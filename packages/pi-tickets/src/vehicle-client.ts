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
 * only an explicit user/LLM action does (the /tickets command, or an actual
 * tool call). If the daemon isn't running
 * yet, no tickets tools are registered for this session; the next session
 * after the daemon has been started once (via /tickets, or the CLI) picks
 * them up normally.
 *
 * Uses a paired Vehicle presentation contract: successful application output
 * is projected before persistence into the strict bounded
 * tickets.tool-details/v1 union, and the custom renderer parses only that
 * curated DTO. Historical details.output rows retain a bounded compatibility
 * fallback; malformed or future details fail closed to bounded model content.
 */

import { resolveVehicleClientTarget, type VehicleClientTarget } from "@danypops/tickets";
import { createReconnectingVehicleClient } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import {
  type PiVehicleToolDetails,
  type RegisteredPiVehicle,
  type RegisterVehicleToolsOptions,
  type RegisterVehicleToolsWhenReadyOptions,
  refreshVehicleToolAvailability,
  registerVehicleToolsWhenReady,
  type VehicleReadyEvent,
  type VehicleReadyRetryOptions,
} from "@danypops/vehicle-client-pi";
import { requestPiApprovalViaAskPrompt } from "@danypops/vehicle-client-pi/hitl-approval-ask-prompt";
import { registerVehicleStatusRefresh } from "@danypops/vehicle-client-pi/pi-status-refresh";
import type { VehicleClient, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTicketsBoard } from "./board-table.js";
import { renderTicketsListTable } from "./list-table.js";
import {
  formatTicketsPresentation,
  parseTicketsPresentation,
  projectTicketsPresentation,
  TICKETS_PRESENTATION_MAX_BYTES,
} from "./presentation.js";
import { formatApprovalInput, renderResultText, titleForApproval } from "./render.js";
import { WatchEventsPoll } from "./watch-events-poll.js";

/**
 * issue.* operations drop the "issue" prefix in render.ts's existing action
 * vocabulary (list/get/create/... rather than issue_list/issue_get/...) --
 * every other operation (focus.*, ledger.*, discover.*) already matches
 * Vehicle's own dot-to-underscore projection 1:1, so only this family needs
 * an alias. issue.approve/issue.request_changes/issue.merge were a gap here
 * (silently falling through to the full issue_approve/... underscored form,
 * which render.ts's own switch had no branch for either) -- included now for
 * the same reason as every sibling issue.* operation above.
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
  "issue.approve": "approve",
  "issue.request_changes": "request_changes",
  "issue.merge": "merge",
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
 *
 * query_ was a pre-existing gap here (query.save/list/remove/run have projected query_* tools
 * since before this list was last touched) -- fixed alongside adding watch_ for the new
 * issue.subscribe/query.subscribe family's own watch_events tool, rather than leaving a second,
 * unrelated bug in place while editing this exact line for a different reason.
 */
export const TICKETS_TOOL_PREFIXES = ["issue_", "focus_", "ledger_", "discover_", "backends_", "stage_", "query_", "watch_"];

export function isTicketsVehicleTool(toolName: string): boolean {
  return TICKETS_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

/** No tickets operation's own input schema declares any of these -- a defensive net for an
 * unrecognized/malformed args shape reaching this branch (neither `.ref` present), so it shows
 * *something* identifying rather than silently falling back to the bare operation name alone. */
const GENERIC_IDENTITY_ARG_KEYS = ["name", "title", "id", "text"] as const;

function genericIdentityFallback(args: Record<string, unknown>): string | undefined {
  for (const key of GENERIC_IDENTITY_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Exported for @danypops/vehicle-conformance's dual-channel fixture (test/tool-shell-dual-channel.test.ts) -- the real per-operation call renderer wired via `renderers()` above, not a test-only duplicate. */
export function renderTicketsCall(operationName: string, args: unknown, theme: Theme) {
  const input = args as { ref?: string } | undefined;
  let text = theme.fg("toolTitle", theme.bold("tickets ")) + theme.fg("muted", legacyActionFor(operationName));
  if (input?.ref) {
    text += ` ${theme.fg("accent", input.ref)}`;
  } else if (input && typeof input === "object") {
    const identity = genericIdentityFallback(input as Record<string, unknown>);
    if (identity) text += ` ${theme.fg("accent", identity)}`;
  }
  return new Text(text, 0, 0);
}

function resultTextContent(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Exported for @danypops/vehicle-conformance's dual-channel fixture -- the real per-operation result renderer wired via `presentations()` above, not a test-only duplicate. */
export function renderTicketsResult(
  operationName: string,
  result: AgentToolResult<PiVehicleToolDetails>,
  theme: Theme,
  isError: boolean,
  isPartial: boolean,
  expanded: boolean,
) {
  if (isPartial) return new Text(theme.fg("warning", "Working…"), 0, 0);
  const content = resultTextContent(result);
  if (isError) return new Text(renderResultText(legacyActionFor(operationName), content || undefined, true, theme), 0, 0);

  const details = result.details;
  const presentation = parseTicketsPresentation(details?.presentation);
  if (presentation) {
    // "list" gets a genuine table (real columns, semantic status coloring) -- every other
    // kind (detail/mutation/summary/error) is a single item or a short message, where a
    // flat styled line already is the right shape.
    if (presentation.kind === "list") return renderTicketsListTable(presentation, theme, expanded);
    if (presentation.kind === "board") return renderTicketsBoard(presentation, theme);
    const color = presentation.kind === "error" ? "error" : "toolOutput";
    return new Text(theme.fg(color, formatTicketsPresentation(presentation)), 0, 0);
  }

  // Compatibility window for historical rows persisted before tickets.tool-details/v1.
  if (details?.output !== undefined) {
    return new Text(renderResultText(legacyActionFor(operationName), details.output, false, theme), 0, 0);
  }

  // Malformed or future presentation details fail closed to the independently
  // bounded model content rather than throwing during transcript replay.
  return new Text(theme.fg("toolOutput", content || "Tickets operation completed"), 0, 0);
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
  /**
   * Overridden in tests that need shell mode off to isolate an unrelated behavior -- pass
   * `shell: undefined` explicitly to disable it. Omitting this field entirely (not present on
   * deps at all) keeps the real default: core operations active, everything else behind
   * tools_man. Discovery of every other Vehicle in the process is unconditional now
   * (vehicle-client-pi's own neutral, shared tools_list/tools_man) -- no ownVehicleName/broker
   * option needed here anymore. Mirrors pi-pipes'/pi-papyrus' own identical escape hatch.
   */
  shell?: RegisterVehicleToolsOptions["shell"];
  /** Overridden in tests that need a connector failure to surface immediately instead of waiting
   * out the real ~5s background retry budget. Defaults to true -- see vehicle-client's own
   * DEFAULT_CONNECT_RETRY, which covers a daemon that crashed and is mid systemd-restart. */
  connectRetry?: boolean;
}

/**
 * Vehicle Shell's core set (see @danypops/vehicle-client-pi's registerVehicleTools `shell`
 * option): the handful of operations used in nearly every session, active from turn one with no
 * tools_man round-trip. Every other operation boots inactive, reachable via tools_list/tools_man.
 * Illustrative, not fixed -- tune from real usage, same as papyrus's own CORE_OPERATIONS.
 */
const TICKETS_CORE_OPERATIONS = ["issue.list", "issue.get", "issue.search", "issue.comment_add", "focus.set", "focus.get"];

const DEFAULT_SHELL_OPTIONS: RegisterVehicleToolsOptions["shell"] = {
  coreOperations: TICKETS_CORE_OPERATIONS,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Surfaces the outcomes worth a human seeing: a real resolution/registration
 * error (not just "daemon isn't up yet"), and the terminal exhausted state
 * (every attempt failed and no tickets tool will be registered this
 * session). A daemon merely still starting up (repeated client-unavailable
 * before the last attempt) stays quiet -- that's the expected common case
 * right after `tickets daemon start`, not something worth a warning on
 * every retry.
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
  // connectRetry:true (vehicle-client's own bounded background retry budget) covers a
  // daemon that crashed and is mid systemd-restart -- without it, the very first call
  // during that window fails immediately instead of waiting the ~2s restart out.
  const client = createReconnectingVehicleClient(
    async () => {
      const resolved = resolveTarget();
      if (!resolved) throw new Error("Tickets daemon is not running");
      return createClient(resolved);
    },
    { connectRetry: deps.connectRetry ?? true },
  );

  const options: RegisterVehicleToolsWhenReadyOptions = {
    // vehicle:approvals:resolve is required alongside tickets:read/write: once
    // the tickets VehicleRegistry gates external-write behind an approval (see
    // its own configureApprovals() call), registerVehicleTools' interactive
    // approval dance (see requestApproval below) calls vehicle.approval.resolve
    // with this exact options.permissions -- without this permission that
    // resolve call itself gets denied, and a human's real "approve" decision
    // would have no effect. vehicle-client-pi never projects
    // vehicle.approval.resolve as a directly LLM-callable tool regardless of
    // this grant, so this does not let the model resolve its own requests.
    permissions: ["tickets:read", "tickets:write", "vehicle:approvals:resolve"],
    principal: { id: "pi-tickets" },
    // requestPiAskPrompt (the component requestApproval below wires in) defaults to "integrated"
    // (docked in place of Pi's input editor) whenever presentation is left unset -- too little
    // room for a real issue.create's own multi-line description/labels/etc, which need
    // scrolling (a leading "↑" in the box) to fit there. "overlay" hosts the identical component
    // as a centered floating box sized up to 80% of the terminal's own width/height (see
    // vehicle-client-pi's own DUAL_HOST_OVERLAY_OPTIONS) -- meaningfully more reading room for
    // exactly the approvalPrompt content below, without needing any change outside this package.
    approvalPresentation: "overlay",
    // Presents Approve/Deny (plus an optional ctrl+g comment) through requestPiAskPrompt's
    // shared searchable-select component instead of registerVehicleTools' own default
    // fixed two-item requestPiApproval dialog -- one consistent HITL look across every
    // tickets prompt, and the option is already there for reuse if a future gated
    // operation ever wants richer than plain Approve/Deny (e.g. picking a specific field
    // to fix before retrying).
    requestApproval: requestPiApprovalViaAskPrompt,
    // Without this, vehicle-pi.ts's own requestLocalApproval default renders the approval
    // prompt's body as `Input:\n${JSON.stringify(input, null, 2)}` -- a raw
    // `{"ref": "github:#1", "body": "..."}` blob for e.g. issue.approve. Same literal field
    // values, just formatted as plain `key: value` lines (see formatApprovalInput's own doc
    // comment for why this must stay lossless, unlike presentation.ts's result-formatting
    // redaction).
    approvalPrompt: (descriptor: VehicleOperationDescriptor, input: unknown) => ({
      title: titleForApproval(descriptor.name, input),
      message: `${descriptor.name} (${descriptor.effect} effect) requests approval before it can run.\n\n${formatApprovalInput(input)}`,
    }),
    renderers: (descriptor: VehicleOperationDescriptor) => ({
      renderCall: (args, theme) => renderTicketsCall(descriptor.name, args, theme),
    }),
    presentations: (descriptor: VehicleOperationDescriptor) => ({
      projector: {
        maxBytes: TICKETS_PRESENTATION_MAX_BYTES,
        project: (output) => projectTicketsPresentation(descriptor.name, output),
      },
      renderResult: (result, resultOptions, theme, context) =>
        renderTicketsResult(descriptor.name, result, theme, context.isError, resultOptions.isPartial, resultOptions.expanded),
    }),
    retry: deps.retry,
    log: (event) => {
      notifyReadyEvent(event);
      deps.onReadyEvent?.(event);
    },
    // Turns Vehicle Shell (and broker mode) on: core operations active from turn one,
    // everything else behind tools_man; activateForeignOperation is auto-supplied by
    // registerVehicleTools, no extra wiring needed beyond DEFAULT_SHELL_OPTIONS above.
    shell: "shell" in deps ? deps.shell : DEFAULT_SHELL_OPTIONS,
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

    // "Get notified about a watched issue/query changing" -- the pi-tickets analog of pi-pipes'
    // own JobsOverlay poll, minus the visual widget (see watch-events-poll.ts's own doc comment
    // for why no client-side diffing is needed here). Gated on ctx.hasUI, same as pi-pipes' own
    // jobs overlay: a passive background notifier has no reason to run for a headless/RPC caller
    // with nobody to notice it. Reuses this exact same reconnecting `client` -- no second daemon
    // connection, and it already tolerates the daemon not being up yet or rebinding a new port.
    let watchEventsPoll: WatchEventsPoll | undefined;
    pi.on("session_start", (_event, ctx) => {
      if (!ctx.hasUI) return;
      watchEventsPoll ??= new WatchEventsPoll({
        client,
        pi,
        subscriberId: ctx.sessionManager.getSessionId(),
        permissions: options.permissions ?? [],
      });
      watchEventsPoll.start();
    });
    pi.on("session_shutdown", () => {
      watchEventsPoll?.stop();
    });

    return current;
  });
}
