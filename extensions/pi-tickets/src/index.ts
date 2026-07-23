/**
 * pi-tickets — exposes the tickets daemon (GitHub/GitLab/Jira issue tracking)
 * two ways: a single action-based tool the LLM can call, mirroring the CLI's
 * commands 1:1 (see ../../../src/cli/index.ts and ../../../src/daemon/ops.ts),
 * and a `/tickets` interactive TUI for the human (see tui.ts) — a browsable
 * list of pooled issues across every backend, with a persistent footer status
 * showing the current focus. Neither ever talks to a backend or opens the
 * daemon's SQLite ledger directly — both go through the same authenticated
 * RPC client the CLI uses, spawning the (Bun-only) daemon on first use if
 * needed.
 *
 * OAuth login (`tickets auth login`) and daemon lifecycle control (`tickets
 * daemon stop/restart`) are deliberately NOT exposed as a tool action or a
 * TUI command: login requires a human to open a browser link and approve
 * access, and stopping the daemon out from under other callers is an
 * operational decision that belongs to a human at a terminal, not something
 * an agent or a casual keypress should trigger.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTicketsClient, type TicketsRpcClient } from "../../../src/client/tickets-client.js";
import type { CreateInput, ListFilter, Priority, Status, UpdateInput } from "../../../src/domain/issue.js";
import { registerTicketsTui } from "./tui.js";

const ACTIONS = [
  "list",
  "get",
  "create",
  "update",
  "search",
  "children",
  "comments",
  "comment_add",
  "backends",
  "ledger_search",
  "ledger_stats",
  "focus_set",
  "focus_get",
  "focus_pause",
  "focus_unpause",
  "focus_clear",
] as const;
export type Action = (typeof ACTIONS)[number];
export { ACTIONS };

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("search"),
    Type.Literal("children"),
    Type.Literal("comments"),
    Type.Literal("comment_add"),
    Type.Literal("backends"),
    Type.Literal("ledger_search"),
    Type.Literal("ledger_stats"),
    Type.Literal("focus_set"),
    Type.Literal("focus_get"),
    Type.Literal("focus_pause"),
    Type.Literal("focus_unpause"),
    Type.Literal("focus_clear"),
  ]),
  ref: Type.Optional(Type.String({ description: 'Issue ref "backend:key", e.g. "jira:PROJ-42" or "github:#7". Required for get/update/children/comments/comment_add.' })),
  backend: Type.Optional(Type.String({ description: "Backend name, e.g. github/gitlab/jira or a configured multi-instance name. Required for list/create/search." })),
  title: Type.Optional(Type.String({ description: "Issue title. Required for create." })),
  description: Type.Optional(Type.String()),
  status: Type.Optional(Type.String({ description: "backlog | todo | in_progress | in_review | done | canceled" })),
  priority: Type.Optional(Type.String({ description: "none | urgent | high | medium | low" })),
  labels: Type.Optional(Type.Array(Type.String())),
  assignee: Type.Optional(Type.String()),
  project: Type.Optional(Type.String({ description: "Project key/id override for create" })),
  query: Type.Optional(Type.String({ description: "Search text. Required for search/ledger_search." })),
  body: Type.Optional(Type.String({ description: "Comment body. Required for comment_add." })),
  limit: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String({ description: "Optional reason for focus_pause, e.g. \"waiting on review\"." })),
});

export async function dispatch(client: TicketsRpcClient, params: Record<string, unknown>): Promise<unknown> {
  const action = params.action as Action;
  const ref = params.ref as string | undefined;
  const backend = params.backend as string | undefined;

  switch (action) {
    case "backends":
      return client.call("backends.list", {});
    case "list": {
      if (!backend) throw new Error('action "list" requires backend');
      const filter: ListFilter = {
        status: params.status as Status | undefined,
        assignee: params.assignee as string | undefined,
        labels: params.labels as string[] | undefined,
        limit: params.limit as number | undefined,
      };
      return client.call("issue.list", { backend, filter });
    }
    case "get":
      if (!ref) throw new Error('action "get" requires ref');
      return client.call("issue.get", { ref });
    case "create": {
      if (!backend) throw new Error('action "create" requires backend');
      if (!params.title) throw new Error('action "create" requires title');
      const input: CreateInput = {
        title: params.title as string,
        description: params.description as string | undefined,
        priority: params.priority as Priority | undefined,
        labels: params.labels as string[] | undefined,
        assignee: params.assignee as string | undefined,
        project: params.project as string | undefined,
      };
      return client.call("issue.create", { backend, input });
    }
    case "update": {
      if (!ref) throw new Error('action "update" requires ref');
      const input: UpdateInput = {
        title: params.title as string | undefined,
        description: params.description as string | undefined,
        status: params.status as Status | undefined,
        priority: params.priority as Priority | undefined,
        labels: params.labels as string[] | undefined,
        assignee: params.assignee as string | undefined,
      };
      return client.call("issue.update", { ref, input });
    }
    case "search":
      if (!backend || !params.query) throw new Error('action "search" requires backend and query');
      return client.call("issue.search", { backend, query: params.query as string, limit: params.limit as number | undefined });
    case "children":
      if (!ref) throw new Error('action "children" requires ref');
      return client.call("issue.children", { ref });
    case "comments":
      if (!ref) throw new Error('action "comments" requires ref');
      return client.call("issue.comments", { ref });
    case "comment_add":
      if (!ref || !params.body) throw new Error('action "comment_add" requires ref and body');
      return client.call("issue.comment_add", { ref, body: params.body as string });
    case "ledger_search":
      if (!params.query) throw new Error('action "ledger_search" requires query');
      return client.call("ledger.search", { query: params.query as string, limit: params.limit as number | undefined });
    case "ledger_stats":
      return client.call("ledger.stats", {});
    case "focus_set":
      if (!ref) throw new Error('action "focus_set" requires ref');
      return client.call("focus.set", { ref });
    case "focus_get":
      return client.call("focus.get", {});
    case "focus_pause":
      return client.call("focus.pause", { reason: params.reason as string | undefined });
    case "focus_unpause":
      return client.call("focus.unpause", {});
    case "focus_clear":
      return client.call("focus.clear", {});
    default:
      throw new Error(`unknown action: ${String(action)}`);
  }
}

export default function (pi: ExtensionAPI) {
  registerTicketsTui(pi);

  pi.registerTool({
    name: "tickets",
    label: "Tickets",
    description:
      "Issue tracking across GitHub, GitLab, and Jira via the local tickets daemon (live backend calls plus a locally pooled ledger that keeps working even when a backend is slow or unreachable). " +
      `Actions: ${ACTIONS.join(", ")}. Ref format is "backend:key" (e.g. jira:PROJ-42, github:#7). ` +
      "OAuth login is not exposed here — the user runs `tickets auth login --backend <name>` from a terminal.",
    promptSnippet: "query/create/update issues across GitHub, GitLab, Jira",
    parameters,
    async execute(_toolCallId, params) {
      try {
        const client = await createTicketsClient();
        const result = await dispatch(client, params as Record<string, unknown>);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: { result } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `error: ${message}` }],
          isError: true,
          details: { result: null },
        };
      }
    },
  });
}
