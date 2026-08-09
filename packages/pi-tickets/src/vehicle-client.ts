/**
 * Registers every real ticket operation as its own Vehicle-projected Pi
 * tool (issue_list, focus_set, discover_fields, ...) instead of the old
 * hand-rolled `tickets(action=X)` mega-tool -- see @danypops/tickets' own
 * src/agent-tools/tickets-vehicle.ts for the VehicleRegistry side. Same daemon,
 * same handle file, same Bearer token every other tickets RPC call already
 * uses (resolveVehicleClientTarget mirrors tui.ts's refreshStatus, which
 * already tolerates "daemon not running" the same way).
 *
 * Deliberately does NOT spawn the daemon: resolveVehicleClientTarget only
 * reads the handle if the daemon has already started, matching this
 * package's own established rule (see tui.ts's refreshStatus) that a
 * passive Pi lifecycle hook must never surprise-spawn a daemon process --
 * only an explicit user/LLM action does (the /tickets command, or
 * previously, an actual "tickets" tool call). If the daemon isn't running
 * yet, no tickets tools are registered for this session; the next session
 * after the daemon has been started once (via /tickets, or the CLI) picks
 * them up normally.
 *
 * Uses render.ts's existing renderResultText for every operation's result
 * view via the per-operation renderers option, so this migration keeps the
 * exact same hand-tuned rendering the mega-tool already had (comment
 * previews, created/updated confirmations, focus status) instead of
 * falling back to vehicle-client-pi's generic renderer.
 */

import { resolveVehicleClientTarget, type VehicleClientTarget } from "@danypops/tickets";
import { createReconnectingVehicleClient } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import {
  type RegisteredPiVehicle,
  type RegisterVehicleToolsWhenReadyOptions,
  refreshVehicleToolAvailability,
  registerVehicleToolsWhenReady,
  type VehicleReadyEvent,
  type VehicleReadyRetryOptions,
} from "@danypops/vehicle-client-pi";
import { registerVehicleStatusRefresh } from "@danypops/vehicle-client-pi/pi-status-refresh";
import type { VehicleClient, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderResultText } from "./render.js";

/**
 * issue.* operations drop the "issue" prefix in render.ts's existing action
 * vocabulary (list/get/create/... rather than issue_list/issue_get/...) --
 * every other operation (focus.*, ledger.*, discover.*) already matches
 * Vehicle's own dot-to-underscore projection 1:1, so only this family needs
 * an alias.
 */
const ISSUE_ACTION_ALIAS: Record<string, string> = {
  "issue.list": "list",
  "issue.get": "get",
  "issue.create": "create",
  "issue.update": "update",
  "issue.search": "search",
  "issue.children": "children",
  "issue.comments": "comments",
  "issue.comment_add": "comment_add",
};

function legacyActionFor(operationName: string): string {
  return ISSUE_ACTION_ALIAS[operationName] ?? operationName.replace(/\./g, "_");
}

/**
 * Every Vehicle-projected ticket tool name starts with one of these
 * namespace prefixes (issue_list, focus_set, ledger_search,
 * discover_fields, backends_list -- see tickets-vehicle.ts's OPERATIONS).
 * Exported so tui.ts's own footer-status refresh shares the exact same
 * list instead of keeping a second copy in sync by hand.
 */
export const TICKETS_TOOL_PREFIXES = ["issue_", "focus_", "ledger_", "discover_", "backends_", "stage_"];

export function isTicketsVehicleTool(toolName: string): boolean {
  return TICKETS_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function renderTicketsCall(operationName: string, args: unknown, theme: Theme) {
  const input = args as { ref?: string } | undefined;
  let text = theme.fg("toolTitle", theme.bold("tickets ")) + theme.fg("muted", legacyActionFor(operationName));
  if (input?.ref) text += ` ${theme.fg("accent", input.ref)}`;
  return new Text(text, 0, 0);
}

function renderTicketsResult(operationName: string, result: AgentToolResult<unknown>, theme: Theme, isError: boolean) {
  const output = (result.details as { output?: unknown } | undefined)?.output;
  const errorContent = isError
    ? result.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
    : undefined;
  const text = renderResultText(legacyActionFor(operationName), output ?? errorContent, isError, theme);
  return new Text(text, 0, 0);
}

export interface TicketsVehicleDeps {
  /** Overridden in tests instead of reading a real daemon handle file. */
  resolveTarget?: () => VehicleClientTarget | undefined;
  /** Overridden in tests instead of constructing a real HTTP client. */
  createClient?: (target: VehicleClientTarget) => VehicleClient;
  /** Bounded retry/backoff for the daemon becoming reachable -- see registerVehicleToolsWhenReady. */
  retry?: VehicleReadyRetryOptions;
  /** Overridden in tests to inspect every resolution/registration outcome directly instead of only its ctx.ui.notify side effect. */
  onReadyEvent?: (event: VehicleReadyEvent) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Surfaces the outcomes worth a human seeing: a real resolution/registration
 * error (not just "daemon isn't up yet"), and the terminal exhausted state
 * (the case that used to leave zero tickets tools registered for the whole
 * session with no visible sign why). A daemon merely still starting up
 * (repeated client-unavailable before the last attempt) stays quiet --
 * that's the expected common case right after `tickets daemon start`, not
 * something worth a warning on every retry.
 */
function notifyReadyEvent(event: VehicleReadyEvent): void {
  switch (event.kind) {
    case "client-resolution-failed":
      event.ctx.ui.notify(`tickets daemon target resolution failed: ${errorMessage(event.error)}`, "warning");
      return;
    case "registration-failed":
      event.ctx.ui.notify(`tickets tool registration failed: ${errorMessage(event.error)}`, "warning");
      return;
    case "exhausted":
      event.ctx.ui.notify(
        `tickets tools unavailable this session -- the daemon never became reachable after ${event.attempts} attempts`,
        "warning",
      );
      return;
    case "client-unavailable":
    case "registered":
      return;
  }
}

/**
 * Registers every real ticket operation as a Pi tool once the daemon is
 * reachable. Defers the whole resolve+register sequence to session_start
 * internally (via registerVehicleToolsWhenReady) with bounded retry --
 * a daemon that is merely slow to start no longer permanently blanks out
 * every tickets tool for the rest of the session, and every failure logs
 * through onReadyEvent/ctx.ui.notify instead of vanishing.
 */
export function registerTicketsVehicle(pi: ExtensionAPI, deps: TicketsVehicleDeps = {}): Promise<RegisteredPiVehicle | undefined> {
  const resolveTarget = deps.resolveTarget ?? resolveVehicleClientTarget;
  const createClient = deps.createClient ?? ((t: VehicleClientTarget) => new RemoteVehicleClient({ baseUrl: t.baseUrl, token: t.token }));

  // Built once and reused across every attempt (including the eventual
  // status-refresh calls below) rather than per-attempt: createReconnectingVehicleClient
  // re-resolves resolveTarget()/createClient fresh on every reconnect itself, so
  // one instance already tolerates the daemon rebinding a new random port on
  // restart -- no need to rebuild it just because an earlier attempt found no
  // target yet.
  const client = createReconnectingVehicleClient(async () => {
    const resolved = resolveTarget();
    if (!resolved) throw new Error("Tickets daemon is not running");
    return createClient(resolved);
  });

  const options: RegisterVehicleToolsWhenReadyOptions = {
    // vehicle:approvals:resolve is required alongside tickets:read/write: once
    // the tickets VehicleRegistry gates external-write behind an approval (see
    // its own configureApprovals() call), registerVehicleTools' interactive
    // ctx.ui.confirm()-then-resolve dance calls vehicle.approval.resolve with
    // this exact options.permissions -- without this permission that resolve
    // call itself gets denied, and a human's real "yes" in the confirm dialog
    // would have no effect. vehicle-client-pi never projects
    // vehicle.approval.resolve as a directly LLM-callable tool regardless of
    // this grant, so this does not let the model resolve its own requests.
    permissions: ["tickets:read", "tickets:write", "vehicle:approvals:resolve"],
    principal: { id: "pi-tickets" },
    renderers: (descriptor: VehicleOperationDescriptor) => ({
      renderCall: (args, theme) => renderTicketsCall(descriptor.name, args, theme),
      renderResult: (result, _options, theme, context) => renderTicketsResult(descriptor.name, result, theme, context.isError),
    }),
    retry: deps.retry,
    log: (event) => {
      notifyReadyEvent(event);
      deps.onReadyEvent?.(event);
    },
  };

  return registerVehicleToolsWhenReady(pi, () => Promise.resolve(resolveTarget() ? client : undefined), options).then((registered) => {
    if (!registered) return undefined;

    let current = registered;
    // A backend added/removed via /secrets since the last check (a Jira
    // credential configured or removed) flips discover.*'s availability on
    // the daemon side (see tickets-vehicle.ts's syncDiscoverAvailability) --
    // this is what re-syncs which of those tools the LLM can currently see,
    // without a Pi restart.
    registerVehicleStatusRefresh(pi, {
      ownToolPrefixes: TICKETS_TOOL_PREFIXES,
      refresh: async () => {
        current = await refreshVehicleToolAvailability(pi, client, current, options);
      },
    });

    return current;
  });
}
