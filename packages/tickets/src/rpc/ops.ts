/**
 * The RPC protocol shared between the tickets daemon (server.ts, running under
 * Bun) and every client (cli/index.ts, packages/pi-tickets, running under
 * whatever consumes this package). Pure types, zero runtime imports, safe to
 * import from either side without pulling in bun:sqlite or Bun.serve.
 */
import type { Comment, CreateInput, Issue, ListFilter, UpdateInput } from "../issue/issue.js";
import type { BackendCapabilities } from "../issue/service.js";
import type { Template } from "../issue/template.js";
import type { TicketFocusState } from "../sqlite/focus.js";
import type { SavedQuery } from "../sqlite/saved-queries.js";
import type { IssueWatchSubscription, QueryWatchSubscription, WatchEvent } from "../sqlite/watches.js";
import type { StagedItem, StagePatchFields, StagePayload } from "../stage/store.js";

export type TicketOperation =
  | "backends.list"
  | "issue.list"
  | "issue.get"
  | "issue.create"
  | "issue.update"
  | "issue.search"
  | "issue.children"
  | "issue.comments"
  | "issue.comment_add"
  | "issue.approve"
  | "issue.request_changes"
  | "issue.merge"
  | "ledger.search"
  | "ledger.stats"
  | "focus.set"
  | "focus.get"
  | "focus.pause"
  | "focus.unpause"
  | "focus.clear"
  | "session.register"
  | "session.release"
  | "discover.fields"
  | "discover.statuses"
  | "discover.template"
  | "discover.board_quickfilter"
  | "discover.board_filter"
  | "query.save"
  | "query.list"
  | "query.remove"
  | "query.run"
  | "issue.subscribe"
  | "issue.unsubscribe"
  | "issue.subscribed"
  | "query.subscribe"
  | "query.unsubscribe"
  | "query.subscribed"
  | "watch.events"
  | "stage.add"
  | "stage.list"
  | "stage.show"
  | "stage.patch"
  | "stage.drop"
  | "stage.push"
  | "daemon.shutdown";

export interface TicketOpInputs extends Record<TicketOperation, unknown> {
  "backends.list": Record<string, never>;
  "issue.list": { backend: string; filter?: ListFilter };
  "issue.get": { ref: string };
  "issue.create": { backend: string; input: CreateInput };
  "issue.update": { ref: string; input: UpdateInput };
  "issue.search": { backend: string; query: string; limit?: number; project?: string };
  "issue.children": { ref: string };
  "issue.comments": { ref: string };
  "issue.comment_add": { ref: string; body: string };
  "issue.approve": { ref: string; body?: string };
  "issue.request_changes": { ref: string; body: string };
  "issue.merge": { ref: string; method?: "merge" | "squash" | "rebase" };
  "ledger.search": { query: string; limit?: number; backend?: string };
  "ledger.stats": Record<string, never>;
  /**
   * sessionId: optional explicit scope override (see sqlite/focus.ts's own normalizeFocusScope) --
   * defaults to callContext?.callerSessionId, then "global", the same input-wins-over-callContext
   * precedence issue.subscribe/query.subscribe already established. sessionSecret authorizes an
   * EXPLICIT sessionId claim against session.register's own identity store (see
   * sqlite/session-identity.ts) -- never required, and never even read, for the implicit
   * callContext.callerSessionId default, since a Vehicle-projected tool call's own
   * callerSessionId is host-derived, not model-settable.
   */
  "focus.set": { ref: string; sessionId?: string; sessionSecret?: string };
  "focus.get": { sessionId?: string };
  "focus.pause": { reason?: string; sessionId?: string; sessionSecret?: string };
  "focus.unpause": { sessionId?: string; sessionSecret?: string };
  "focus.clear": { sessionId?: string; sessionSecret?: string };
  /**
   * No CLI command, and excluded from Vehicle tool projection (see agent-tools/tickets-vehicle.ts's
   * own OWNER/OPERATIONS list) -- a pure client<->daemon handshake pi-tickets' own extension code
   * calls directly (see pi-tickets' tui.ts), never a human- or model-meaningful action the way
   * every other operation here is. daemon.shutdown is the one other operation with no Pi tool for
   * a similar reason, but it at least keeps a human-facing CLI command (`daemon stop`); these two
   * have no comparable human verb at all.
   */
  "session.register": { sessionId: string };
  "session.release": { sessionId: string; sessionSecret?: string };

  "discover.fields": { backend: string };
  "discover.statuses": { backend: string };
  "discover.template": { backend: string; project: string; issueType: string; sampleSize?: number };
  "discover.board_quickfilter": { backend: string; boardId: number; quickFilterId: number };
  "discover.board_filter": { backend: string; boardId: number };
  "query.save": { name: string; backend: string; query: string; description?: string };
  "query.list": Record<string, never>;
  "query.remove": { name: string };
  "query.run": { name: string; limit?: number };
  "issue.subscribe": { ref: string; subscriberId?: string; scheduleMs?: number; projectRoot?: string };
  "issue.unsubscribe": { ref: string; subscriberId?: string };
  "issue.subscribed": { subscriberId?: string };
  "query.subscribe": { name: string; subscriberId?: string; scheduleMs?: number; projectRoot?: string };
  "query.unsubscribe": { name: string; subscriberId?: string };
  "query.subscribed": { subscriberId?: string };
  "watch.events": { subscriberId?: string; sinceId?: number; limit?: number };
  "stage.add": { payload: StagePayload };
  "stage.list": Record<string, never>;
  "stage.show": { id: string };
  "stage.patch": { id: string; fields: StagePatchFields };
  "stage.drop": { id: string };
  "stage.push": { id: string };
  "daemon.shutdown": Record<string, never>;
}

/** stage.push's own output shape -- whichever real op the staged payload's kind maps to (issue.create/issue.update/issue.comment_add). */
export type StagePushResult = { issue: Issue } | { comment: Comment };

export interface TicketOpOutputs extends Record<TicketOperation, unknown> {
  "backends.list": { backends: BackendCapabilities[] };
  "issue.list": { issues: Issue[] };
  "issue.get": { issue: Issue };
  "issue.create": { issue: Issue };
  "issue.update": { issue: Issue };
  "issue.search": { issues: Issue[] };
  "issue.children": { issues: Issue[] };
  "issue.comments": { comments: Comment[] };
  "issue.comment_add": { comment: Comment };
  "issue.approve": { issue: Issue };
  "issue.request_changes": { issue: Issue };
  "issue.merge": { issue: Issue };
  "ledger.search": { issues: Issue[] };
  "ledger.stats": { backends: { backend: string; count: number }[] };
  "focus.set": { focus: TicketFocusState };
  "focus.get": { focus: TicketFocusState | null };
  "focus.pause": { focus: TicketFocusState };
  "focus.unpause": { focus: TicketFocusState };
  "focus.clear": { cleared: boolean };
  /** secret: shown once, plaintext, on register -- never persisted or logged by the client, mirroring vehicle-server/session-identity's own contract. */
  "session.register": { sessionId: string; secret: string };
  "session.release": { released: true };
  "discover.fields": { mappings: Record<string, string> };
  "discover.statuses": { mappings: Record<string, string> };
  "discover.template": { template: Template | null };
  "discover.board_quickfilter": { jql: string };
  "discover.board_filter": { jql: string };
  "query.save": { query: SavedQuery };
  "query.list": { queries: SavedQuery[] };
  "query.remove": { removed: boolean };
  "query.run": { issues: Issue[] };
  "issue.subscribe": { subscribed: true };
  "issue.unsubscribe": { unsubscribed: true };
  "issue.subscribed": { watches: IssueWatchSubscription[] };
  "query.subscribe": { subscribed: true };
  "query.unsubscribe": { unsubscribed: true };
  "query.subscribed": { watches: QueryWatchSubscription[] };
  "watch.events": { events: WatchEvent[]; lastId: number };
  "stage.add": { item: StagedItem };
  "stage.list": { items: StagedItem[] };
  "stage.show": { item: StagedItem };
  "stage.patch": { item: StagedItem };
  "stage.drop": { dropped: boolean };
  "stage.push": { result: StagePushResult };
  "daemon.shutdown": { stopping: true };
}

export const TICKET_OPERATIONS: TicketOperation[] = [
  "backends.list",
  "issue.list",
  "issue.get",
  "issue.create",
  "issue.update",
  "issue.search",
  "issue.children",
  "issue.comments",
  "issue.comment_add",
  "issue.approve",
  "issue.request_changes",
  "issue.merge",
  "ledger.search",
  "ledger.stats",
  "focus.set",
  "focus.get",
  "focus.pause",
  "focus.unpause",
  "focus.clear",
  "session.register",
  "session.release",
  "discover.fields",
  "discover.statuses",
  "discover.template",
  "discover.board_quickfilter",
  "discover.board_filter",
  "query.save",
  "query.list",
  "query.remove",
  "query.run",
  "issue.subscribe",
  "issue.unsubscribe",
  "issue.subscribed",
  "query.subscribe",
  "query.unsubscribe",
  "query.subscribed",
  "watch.events",
  "stage.add",
  "stage.list",
  "stage.show",
  "stage.patch",
  "stage.drop",
  "stage.push",
  "daemon.shutdown",
];

/** Daemon path/state directory identity — the one place this name is spelled out. */
export const TICKETS_DAEMON_NAMES = {
  stateDirectoryName: "tickets",
  databaseFilename: "tickets.db",
  tokenFilename: "token",
  handleFilename: "handle.json",
  systemdUnitName: "tickets-daemon.service",
} as const;

/**
 * Tickets' own stable identity name in the shared, cross-package Vehicle Handle Directory (see
 * @danypops/vehicle-server's resolveSharedVehicleHandlePath) -- must match the ownVehicleName a
 * broker-mode consumer (e.g. Papyrus, Pi Packed, Pipes) discovers it under, and process/
 * bootstrap.ts's own StartDaemonOptions.vehicleName exactly. Derived from TICKETS_DAEMON_NAMES
 * rather than a second hand-typed literal so the two can never drift apart.
 */
export const TICKETS_VEHICLE_NAME = TICKETS_DAEMON_NAMES.stateDirectoryName;
