/**
 * Daemon HTTP surface: Bearer-token auth, /health, /ready, a single
 * dispatch endpoint (/api/v1/ops) per vehicle-server's http.ts convention,
 * and a VehicleRegistry (see ../vehicle/tickets-vehicle.ts) mounted at
 * /vehicle/* -- same daemon, same auth, same port, not a second service to
 * stand up. Every operation here has a CLI command (cli/index.ts) and a
 * pi-tickets tool action — no operation exists only for one caller.
 */
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "@danypops/vehicle-server/rpc-http";
import type { Logger } from "@danypops/vehicle-server/logging";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { AuthRequiredError, IssueNotFoundError } from "../adapters/errors.js";
import { NotSupportedError, type TicketService, UnknownBackendError } from "../application/service.js";
import { parseRef } from "../domain/issue.js";
import { FocusError, type FocusStore } from "./focus.js";
import type { Ledger } from "./ledger.js";
import { TICKET_OPERATIONS, type TicketOpInputs, type TicketOperation, type TicketOpOutputs } from "./ops.js";
import { SavedQueryNotFoundError, type SavedQueryStore } from "./saved-queries.js";

export interface TicketsAppDeps {
  service: TicketService;
  ledger: Ledger;
  focusStore: FocusStore;
  queries: SavedQueryStore;
  token: string;
  version: string;
  logger?: Logger;
  /**
   * Invoked by the `daemon.shutdown` op, after the HTTP response is already
   * queued to flush. Defaults set by bootstrap.ts self-signal the process so
   * the same tested SIGINT/SIGTERM path (vehicle-server's runDaemonProcess) does
   * the actual graceful stop — this hook only ever *requests* shutdown, it
   * never calls process.exit directly.
   */
  onShutdownRequested?: () => void;
  /**
   * Built by ../vehicle/tickets-vehicle.ts's createTicketsVehicleRegistry,
   * from the same base deps this interface describes -- passed in rather
   * than built here to avoid a server.ts <-> tickets-vehicle.ts import cycle
   * (tickets-vehicle.ts already imports TICKET_OP_HANDLERS and this type
   * from this file).
   */
  vehicleRegistry: VehicleRegistry;
}

// Narrower than TicketsAppDeps on purpose: no real handler reads
// deps.vehicleRegistry, and vehicle/tickets-vehicle.ts's own registry
// builder needs to call these before a registry exists to put there.
export type Handler<Op extends TicketOperation> = (
  deps: Omit<TicketsAppDeps, "vehicleRegistry">,
  input: TicketOpInputs[Op],
) => Promise<TicketOpOutputs[Op]>;

/**
 * The one real implementation of every ticket operation, shared verbatim by
 * the hand-rolled /api/v1/ops dispatch below and vehicle/tickets-vehicle.ts's
 * VehicleRegistry projection -- never reimplemented a second time for the
 * newer surface.
 */
export const TICKET_OP_HANDLERS: { [Op in TicketOperation]: Handler<Op> } = {
  "backends.list": async (deps) => ({ backends: deps.service.backends() }),
  "issue.list": async (deps, input) => ({ issues: await deps.service.list(input.backend, input.filter) }),
  "issue.get": async (deps, input) => ({ issue: await deps.service.get(input.ref) }),
  "issue.create": async (deps, input) => ({ issue: await deps.service.create(input.backend, input.input) }),
  "issue.update": async (deps, input) => ({ issue: await deps.service.update(input.ref, input.input) }),
  "issue.search": async (deps, input) => ({ issues: await deps.service.search(input.backend, input.query, input.limit, input.project) }),
  "issue.children": async (deps, input) => ({ issues: await deps.service.children(input.ref) }),
  "issue.comments": async (deps, input) => ({ comments: await deps.service.comments(input.ref) }),
  "issue.comment_add": async (deps, input) => ({ comment: await deps.service.addComment(input.ref, input.body) }),
  "ledger.search": async (deps, input) => ({ issues: deps.ledger.search(input.query, input.limit) }),
  "ledger.stats": async (deps) => ({ backends: deps.ledger.stats() }),
  "focus.set": async (deps, input) => {
    // Ledger-first: focusing a ticket already pooled locally needs no live
    // backend call. Otherwise fall back to a live get (also validates the
    // ref actually exists) and opportunistically warm the ledger with it,
    // since a ticket you're about to focus on is exactly the kind of issue
    // worth having cached locally.
    const cached = deps.ledger.get(input.ref);
    const issue = cached ?? (await deps.service.get(input.ref));
    if (!cached) deps.ledger.upsert(parseRef(input.ref).backend, issue);
    if (!issue.url) throw new FocusError(`issue "${input.ref}" has no URL from its backend; cannot focus without a full link`);
    return { focus: deps.focusStore.set(input.ref, issue.title, issue.url) };
  },
  "focus.get": async (deps) => ({ focus: deps.focusStore.get() ?? null }),
  "focus.pause": async (deps, input) => ({ focus: deps.focusStore.pause(input.reason) }),
  "focus.unpause": async (deps) => ({ focus: deps.focusStore.unpause() }),
  "focus.clear": async (deps) => ({ cleared: deps.focusStore.clear() }),
  "discover.fields": async (deps, input) => ({ mappings: await deps.service.discoverFields(input.backend) }),
  "discover.statuses": async (deps, input) => ({ mappings: await deps.service.discoverStatuses(input.backend) }),
  "discover.template": async (deps, input) => ({
    template: (await deps.service.discoverTemplate(input.backend, input.project, input.issueType, input.sampleSize)) ?? null,
  }),
  "discover.board_quickfilter": async (deps, input) => ({
    jql: await deps.service.discoverBoardQuickFilterJql(input.backend, input.boardId, input.quickFilterId),
  }),
  "query.save": async (deps, input) => ({ query: deps.queries.save(input.name, input.backend, input.query, input.description) }),
  "query.list": async (deps) => ({ queries: deps.queries.list() }),
  "query.remove": async (deps, input) => ({ removed: deps.queries.remove(input.name) }),
  "query.run": async (deps, input) => {
    const saved = deps.queries.get(input.name);
    if (!saved) throw new SavedQueryNotFoundError(input.name);
    return { issues: await deps.service.runQuery(saved.backend, saved.query, input.limit) };
  },
  "daemon.shutdown": async (deps) => {
    // Deferred so this handler's own response has already been handed back
    // to Bun.serve before the process starts tearing down.
    setTimeout(() => deps.onShutdownRequested?.(), 50);
    return { stopping: true };
  },
};

function isTicketOperation(value: unknown): value is TicketOperation {
  return typeof value === "string" && (TICKET_OPERATIONS as string[]).includes(value);
}

function statusFor(error: unknown): number {
  if (error instanceof IssueNotFoundError || error instanceof SavedQueryNotFoundError) return 404;
  if (error instanceof UnknownBackendError || error instanceof NotSupportedError || error instanceof FocusError) return 400;
  if (error instanceof AuthRequiredError) return 422;
  return 500;
}

export function buildApp(deps: TicketsAppDeps): { fetch(request: Request): Promise<Response> } {
  // Same Bearer token as the rest of this API -- the Vehicle-projected
  // domain (see ../vehicle/tickets-vehicle.ts) rides the same daemon, same
  // auth, same port; it is not a second service to stand up or
  // authenticate against separately.
  const vehicleApp = createVehicleHttpApp({ registry: deps.vehicleRegistry, token: deps.token });
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (!requireBearerToken(request, deps.token)) return errorResponse("unauthorized", 401);
      if (url.pathname.startsWith("/vehicle/")) return vehicleApp.fetch(request);
      if (request.method === "GET" && url.pathname === "/health") return healthResponse(deps.version);
      if (request.method === "GET" && url.pathname === "/ready") return readyResponse(true);

      if (url.pathname === "/api/v1/ops") {
        if (request.method === "GET") return jsonResponse({ operations: TICKET_OPERATIONS });
        if (request.method === "POST") {
          let body: { op?: unknown; input?: unknown };
          try {
            body = (await request.json()) as { op?: unknown; input?: unknown };
          } catch {
            return errorResponse("invalid JSON body", 400);
          }
          if (!isTicketOperation(body.op)) return errorResponse(`unknown op: ${String(body.op)}`, 400);
          const handler = TICKET_OP_HANDLERS[body.op] as Handler<TicketOperation>;
          try {
            const result = await handler(deps, (body.input ?? {}) as never);
            return jsonResponse({ result });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.logger?.warn("op failed", { op: body.op, error: message });
            return errorResponse(message, statusFor(error));
          }
        }
      }

      return errorResponse("not found", 404);
    },
  };
}
