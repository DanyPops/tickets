/**
 * Daemon HTTP surface: Bearer-token auth, /health, /ready, and a single
 * dispatch endpoint (/api/v1/ops) per daemon-kit's http.ts convention.
 * Every operation here has a CLI command (cli/index.ts) and a pi-tickets
 * tool action — no operation exists only for one caller.
 */
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "@danypops/daemon-kit/http";
import type { Logger } from "@danypops/daemon-kit/logging";
import { AuthRequiredError, IssueNotFoundError } from "../adapters/errors.js";
import { NotSupportedError, type TicketService, UnknownBackendError } from "../application/service.js";
import { parseRef } from "../domain/issue.js";
import { FocusError, type FocusStore } from "./focus.js";
import type { Ledger } from "./ledger.js";
import { TICKET_OPERATIONS, type TicketOpInputs, type TicketOperation, type TicketOpOutputs } from "./ops.js";

export interface TicketsAppDeps {
  service: TicketService;
  ledger: Ledger;
  focusStore: FocusStore;
  token: string;
  version: string;
  logger?: Logger;
  /**
   * Invoked by the `daemon.shutdown` op, after the HTTP response is already
   * queued to flush. Defaults set by bootstrap.ts self-signal the process so
   * the same tested SIGINT/SIGTERM path (daemon-kit's runDaemonProcess) does
   * the actual graceful stop — this hook only ever *requests* shutdown, it
   * never calls process.exit directly.
   */
  onShutdownRequested?: () => void;
}

type Handler<Op extends TicketOperation> = (
  deps: TicketsAppDeps,
  input: TicketOpInputs[Op],
) => Promise<TicketOpOutputs[Op]>;

const handlers: { [Op in TicketOperation]: Handler<Op> } = {
  "backends.list": async (deps) => ({ backends: deps.service.backends() }),
  "issue.list": async (deps, input) => ({ issues: await deps.service.list(input.backend, input.filter) }),
  "issue.get": async (deps, input) => ({ issue: await deps.service.get(input.ref) }),
  "issue.create": async (deps, input) => ({ issue: await deps.service.create(input.backend, input.input) }),
  "issue.update": async (deps, input) => ({ issue: await deps.service.update(input.ref, input.input) }),
  "issue.search": async (deps, input) => ({ issues: await deps.service.search(input.backend, input.query, input.limit) }),
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
  if (error instanceof IssueNotFoundError) return 404;
  if (error instanceof UnknownBackendError || error instanceof NotSupportedError || error instanceof FocusError) return 400;
  if (error instanceof AuthRequiredError) return 422;
  return 500;
}

export function buildApp(deps: TicketsAppDeps): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (!requireBearerToken(request, deps.token)) return errorResponse("unauthorized", 401);
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
          const handler = handlers[body.op] as Handler<TicketOperation>;
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
