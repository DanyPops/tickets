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
  | "discover.fields"
  | "discover.statuses"
  | "discover.template"
  | "discover.board_quickfilter"
  | "discover.board_filter"
  | "query.save"
  | "query.list"
  | "query.remove"
  | "query.run"
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
  "focus.set": { ref: string };
  "focus.get": Record<string, never>;
  "focus.pause": { reason?: string };
  "focus.unpause": Record<string, never>;
  "focus.clear": Record<string, never>;
  "discover.fields": { backend: string };
  "discover.statuses": { backend: string };
  "discover.template": { backend: string; project: string; issueType: string; sampleSize?: number };
  "discover.board_quickfilter": { backend: string; boardId: number; quickFilterId: number };
  "discover.board_filter": { backend: string; boardId: number };
  "query.save": { name: string; backend: string; query: string; description?: string };
  "query.list": Record<string, never>;
  "query.remove": { name: string };
  "query.run": { name: string; limit?: number };
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
  "discover.fields": { mappings: Record<string, string> };
  "discover.statuses": { mappings: Record<string, string> };
  "discover.template": { template: Template | null };
  "discover.board_quickfilter": { jql: string };
  "discover.board_filter": { jql: string };
  "query.save": { query: SavedQuery };
  "query.list": { queries: SavedQuery[] };
  "query.remove": { removed: boolean };
  "query.run": { issues: Issue[] };
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
  "discover.fields",
  "discover.statuses",
  "discover.template",
  "discover.board_quickfilter",
  "discover.board_filter",
  "query.save",
  "query.list",
  "query.remove",
  "query.run",
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
