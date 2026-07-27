/**
 * The RPC protocol shared between the tickets daemon (server.ts, running under
 * Bun) and every client (cli/index.ts, packages/pi-tickets, running under
 * whatever consumes this package). Pure types, zero runtime imports, safe to
 * import from either side without pulling in bun:sqlite or Bun.serve.
 */
import type { Comment, CreateInput, Issue, ListFilter, UpdateInput } from "../domain/issue.js";
import type { TicketFocusState } from "./focus.js";

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
  | "ledger.search"
  | "ledger.stats"
  | "focus.set"
  | "focus.get"
  | "focus.pause"
  | "focus.unpause"
  | "focus.clear"
  | "daemon.shutdown";

export interface TicketOpInputs extends Record<TicketOperation, unknown> {
  "backends.list": Record<string, never>;
  "issue.list": { backend: string; filter?: ListFilter };
  "issue.get": { ref: string };
  "issue.create": { backend: string; input: CreateInput };
  "issue.update": { ref: string; input: UpdateInput };
  "issue.search": { backend: string; query: string; limit?: number };
  "issue.children": { ref: string };
  "issue.comments": { ref: string };
  "issue.comment_add": { ref: string; body: string };
  "ledger.search": { query: string; limit?: number };
  "ledger.stats": Record<string, never>;
  "focus.set": { ref: string };
  "focus.get": Record<string, never>;
  "focus.pause": { reason?: string };
  "focus.unpause": Record<string, never>;
  "focus.clear": Record<string, never>;
  "daemon.shutdown": Record<string, never>;
}

export interface TicketOpOutputs extends Record<TicketOperation, unknown> {
  "backends.list": { backends: string[] };
  "issue.list": { issues: Issue[] };
  "issue.get": { issue: Issue };
  "issue.create": { issue: Issue };
  "issue.update": { issue: Issue };
  "issue.search": { issues: Issue[] };
  "issue.children": { issues: Issue[] };
  "issue.comments": { comments: Comment[] };
  "issue.comment_add": { comment: Comment };
  "ledger.search": { issues: Issue[] };
  "ledger.stats": { backends: { backend: string; count: number }[] };
  "focus.set": { focus: TicketFocusState };
  "focus.get": { focus: TicketFocusState | null };
  "focus.pause": { focus: TicketFocusState };
  "focus.unpause": { focus: TicketFocusState };
  "focus.clear": { cleared: boolean };
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
  "ledger.search",
  "ledger.stats",
  "focus.set",
  "focus.get",
  "focus.pause",
  "focus.unpause",
  "focus.clear",
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
