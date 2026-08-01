/**
 * Interactive TUI for pi-tickets: `/tickets` with no args opens a provider
 * picker (only the backends the daemon actually has configured), then a
 * per-provider mode menu -- every backend gets Issues (browse & search);
 * a backend with a real query language (Jira's JQL today) also gets Saved
 * queries and Board view. `/tickets <query>` skips both pickers and jumps
 * straight to a cross-backend search over the pooled ledger -- the
 * quick-search shortcut stays a one-shot command.
 *
 * The provider picker itself: Tab cycles the highlighted provider (wraps
 * at the end); 'h'/'l'/'j' instantly pick GitHub/GitLab/Jira without
 * navigating first (each letter is a real, distinct substring of the
 * product name -- "Hub"/"Lab"/"Jira" -- not just a first letter, and only
 * fires for a backend that's actually configured); 's' jumps straight to
 * the shared /secrets flow and returns to the still-open picker afterward.
 *
 * Enter sets focus, 'v' opens the full ticket detail view, 'o' opens the
 * issue's real web URL in a browser. A footer status always shows the
 * current focus so it's visible outside the dialog too, refreshed on
 * session start and after every "tickets" tool call -- including
 * autonomous focus_* calls the LLM makes mid-conversation, so the human
 * and the LLM are always looking at the same focus state.
 *
 * Deliberately NOT exposed here: OAuth login and daemon lifecycle control,
 * for the same reason they're excluded from the tool actions in index.ts --
 * both belong to a human at a terminal (`tickets auth login`, `tickets
 * daemon stop`), not a `/` command an LLM conversation could trigger.
 */

import {
  type Comment,
  createTicketsClient,
  type EnsureDaemonOptions,
  type Issue,
  openUrl,
  type TicketFocusState,
  type TicketsRpcClient,
} from "@danypops/tickets";
import { listSecretsContributors, mergeSecretsContributions, runSecretsCommand } from "@danypops/vehicle-client-pi/secrets-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { BorderedSelectPanel } from "malevich-tui-components";
import { KanbanBoardComponent } from "./board-view.js";
import { IssueDetailComponent } from "./issue-detail-view.js";
import { pushView } from "./navigation.js";
import { isTicketsVehicleTool } from "./vehicle-client.js";

const CLEAR_FOCUS_VALUE = "__tickets_clear_focus__";
const BROWSE_LIMIT = 100;
/** The down-arrow's own raw sequence -- forwarded to SelectList.handleInput() so Tab reuses its existing wrap-at-bottom cycling instead of reimplementing it. */
const DOWN_ARROW = "\x1b[B";
/** First letter that's actually distinct within the real product name (GitHub/GitLab share a G, so "Hub"/"Lab" are what's unique) -- instant-select, not just filter-as-you-type. Only fires for a backend that's actually configured. */
const PROVIDER_MNEMONICS: Record<string, string> = { h: "github", l: "gitlab", j: "jira" };

type SavedQuerySummary = { name: string; backend: string; query: string; description?: string };
type BackendCapability = { name: string; supportsRawQuery: boolean };
type ProviderMode = "issues" | "query" | "board";

export interface TicketsTuiDeps {
  /** Overridden in tests instead of spawning/reaching a real daemon. */
  getClient?: (opts?: EnsureDaemonOptions) => Promise<TicketsRpcClient>;
  /** Overridden in tests instead of actually spawning a browser process. */
  openUrl?: (url: string) => void;
  /** Overridden in tests instead of opening the real, shared /secrets flow. */
  openSettings?: (ctx: ExtensionCommandContext) => Promise<void>;
}

/** The same merge the shared `/secrets` command itself performs, invoked directly so 's' inside the provider picker can jump straight there without leaving /tickets. */
async function openTicketsSettings(ctx: ExtensionCommandContext): Promise<void> {
  const resolved = await Promise.all(listSecretsContributors().map((c) => c.resolve()));
  await runSecretsCommand(ctx, mergeSecretsContributions(resolved));
}

/** Known backend identifiers get their real product name; anything else falls back to a capitalized identifier. */
function backendDisplayName(backend: string): string {
  const known: Record<string, string> = { github: "GitHub", gitlab: "GitLab", jira: "Jira" };
  return known[backend] ?? backend.charAt(0).toUpperCase() + backend.slice(1);
}

function focusStatusText(theme: Theme, focus: TicketFocusState | null): string | undefined {
  if (!focus) return undefined;
  const icon = focus.status === "paused" ? "⏸" : "🎯";
  return theme.fg("accent", `${icon} ${focus.ref}`);
}

function issueLabel(issue: Issue): string {
  return `${issue.ref}  ${issue.title.replace(/[\r\n]+/g, " ").trim()}`;
}

function issueDescription(issue: Issue, focusedRef: string | undefined): string {
  const parts: string[] = [issue.status, issue.priority];
  if (issue.ref === focusedRef) parts.push("FOCUSED");
  return parts.join(" · ");
}

export function registerTicketsTui(pi: ExtensionAPI, deps: TicketsTuiDeps = {}): void {
  const getClient = deps.getClient ?? createTicketsClient;
  const open = deps.openUrl ?? openUrl;
  const openSettings = deps.openSettings ?? openTicketsSettings;

  async function refreshStatus(ctx: ExtensionContext, client?: TicketsRpcClient): Promise<void> {
    try {
      const active = client ?? (await getClient({ autoStart: false }));
      const { focus } = await active.call("focus.get", {});
      ctx.ui.setStatus("tickets-focus", focusStatusText(ctx.ui.theme, focus));
    } catch {
      // Daemon not running or unreachable — nothing to show, and starting it
      // just to paint a footer would surprise a user who hasn't touched
      // tickets yet. Leave whatever status was last shown.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!isTicketsVehicleTool(event.toolName)) return;
    await refreshStatus(ctx);
  });

  /** Generic bordered picker: a list of items, enter picks, escape cancels. No per-item side keys. */
  async function pickFromList(ctx: ExtensionCommandContext, title: string, items: SelectItem[], helpText: string): Promise<string | null> {
    return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const selectList = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      const panel = new BorderedSelectPanel({
        title,
        list: selectList,
        helpText,
        theme: {
          border: (s: string) => theme.fg("accent", s),
          title: (s: string) => theme.fg("accent", theme.bold(s)),
          help: (s: string) => theme.fg("dim", s),
        },
      });
      return {
        render: (w: number) => panel.render(w),
        invalidate: () => panel.invalidate(),
        handleInput: (data: string) => {
          panel.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  /** Which configured backend to browse -- skips the picker outright when there's only one configured. Returns null on cancel or when none are configured. */
  async function pickProvider(ctx: ExtensionCommandContext, client: TicketsRpcClient): Promise<BackendCapability | null> {
    const { backends } = await client.call("backends.list", {});
    if (backends.length === 0) {
      ctx.ui.notify("No backends configured yet -- set up GitHub/GitLab/Jira credentials first.", "info");
      return null;
    }
    if (backends.length === 1) return backends[0]!;

    const items: SelectItem[] = backends.map((b) => ({
      value: b.name,
      label: backendDisplayName(b.name),
      description: b.supportsRawQuery ? "Issues, saved queries, and board view" : "Issues",
    }));

    const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const selectList = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      const panel = new BorderedSelectPanel({
        title: "Tickets",
        list: selectList,
        helpText:
          "\u2191\u2193/tab navigate \u2022 enter select \u2022 h GitHub \u2022 l GitLab \u2022 j Jira \u2022 s settings \u2022 esc cancel",
        theme: {
          border: (s: string) => theme.fg("accent", s),
          title: (s: string) => theme.fg("accent", theme.bold(s)),
          help: (s: string) => theme.fg("dim", s),
        },
      });
      return {
        render: (w: number) => panel.render(w),
        invalidate: () => panel.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "tab")) {
            selectList.handleInput(DOWN_ARROW); // reuses SelectList's own wrap-at-bottom cycling
            tui.requestRender();
            return;
          }
          const mnemonicBackend = PROVIDER_MNEMONICS[data];
          if (mnemonicBackend && items.some((i) => i.value === mnemonicBackend)) {
            done(mnemonicBackend);
            return;
          }
          if (data === "s") {
            void openSettings(ctx).then(() => tui.requestRender());
            return;
          }
          panel.handleInput(data);
          tui.requestRender();
        },
      };
    });

    return picked === null ? null : (backends.find((b) => b.name === picked) ?? null);
  }

  /** Which mode within a provider -- skips the picker when the backend only has one real mode (no raw-query support, e.g. GitHub/GitLab today). */
  async function pickMode(ctx: ExtensionCommandContext, provider: BackendCapability): Promise<ProviderMode | null> {
    if (!provider.supportsRawQuery) return "issues";

    const displayName = backendDisplayName(provider.name);
    const picked = await pickFromList(
      ctx,
      displayName,
      [
        { value: "issues", label: "Issues", description: `Browse & search ${displayName} issues` },
        { value: "query", label: "Saved queries", description: "Run a saved JQL query -- e.g. a board's sprint or backlog" },
        { value: "board", label: "Board view", description: "Kanban board (TO DO / IN PROGRESS / REVIEW / DONE) for a saved query" },
      ],
      "\u2191\u2193 navigate \u2022 enter select \u2022 esc cancel",
    );
    return picked as ProviderMode | null;
  }

  /** Issue-list picker shared by browse&search and saved-query browsing: enter focuses, 'v' views, 'o' opens in browser. */
  async function pickIssue(
    ctx: ExtensionCommandContext,
    client: TicketsRpcClient,
    title: string,
    items: SelectItem[],
    byRef: Map<string, Issue>,
  ): Promise<string | null> {
    return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const selectList = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      const panel = new BorderedSelectPanel({
        title,
        list: selectList,
        helpText: "\u2191\u2193 navigate \u2022 enter focus \u2022 v view \u2022 o open in browser \u2022 esc cancel",
        theme: {
          border: (s: string) => theme.fg("accent", s),
          title: (s: string) => theme.fg("accent", theme.bold(s)),
          help: (s: string) => theme.fg("dim", s),
        },
      });
      return {
        render: (w: number) => panel.render(w),
        invalidate: () => panel.invalidate(),
        handleInput: (data: string) => {
          if (data === "o") {
            const highlighted = selectList.getSelectedItem();
            const issue = highlighted ? byRef.get(highlighted.value) : undefined;
            if (issue?.url) {
              try {
                open(issue.url);
              } catch {
                // headless/no-DISPLAY environment — nothing more to do from inside the dialog.
              }
            }
            return;
          }
          if (data === "v") {
            const highlighted = selectList.getSelectedItem();
            const issue = highlighted ? byRef.get(highlighted.value) : undefined;
            if (issue) void showIssueDetail(ctx, client, issue.ref).then(() => tui.requestRender());
            return;
          }
          panel.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  async function pickSavedQuery(ctx: ExtensionCommandContext, queries: SavedQuerySummary[]): Promise<string | null> {
    // The human description is what a person actually recognizes -- lead with it,
    // and push the internal saved-query name (the value `query run <name>` actually
    // takes) into the secondary column instead of the other way around.
    const items: SelectItem[] = queries.map((q) => ({
      value: q.name,
      label: q.description ?? q.name,
      description: q.description ? `(${q.name})` : `${q.backend}: ${q.query}`,
    }));
    return pickFromList(ctx, "Saved queries", items, "\u2191\u2193 navigate \u2022 enter run \u2022 esc cancel");
  }

  /** backend=undefined searches the pooled ledger across every configured backend (the `/tickets <query>` shortcut); a real value scopes to just that provider's own issues. */
  async function browseTickets(ctx: ExtensionCommandContext, client: TicketsRpcClient, query: string, backend?: string): Promise<void> {
    const [{ focus }, { issues }] = await Promise.all([
      client.call("focus.get", {}),
      client.call("ledger.search", { query, limit: BROWSE_LIMIT, backend }),
    ]);

    const items: SelectItem[] = [];
    if (focus) items.push({ value: CLEAR_FOCUS_VALUE, label: "✕ Clear current focus", description: `${focus.ref} — ${focus.title}` });
    for (const issue of issues)
      items.push({ value: issue.ref, label: issueLabel(issue), description: issueDescription(issue, focus?.ref) });

    if (items.length === 0) {
      const scope = backend ? `${backendDisplayName(backend)} tickets` : "pooled tickets";
      ctx.ui.notify(
        query
          ? `No ${scope} matching "${query}" yet (the ledger only has what's synced so far).`
          : `No ${scope} pooled yet — the ledger fills in as the daemon syncs, or after issue.get/list/search calls.`,
        "info",
      );
      return;
    }

    const byRef = new Map(issues.map((issue) => [issue.ref, issue] as const));
    const title = focus ? `Tickets — focused: ${focus.ref}` : backend ? `${backendDisplayName(backend)} issues` : "Tickets";
    const result = await pickIssue(ctx, client, title, items, byRef);
    if (result === null) return;

    try {
      if (result === CLEAR_FOCUS_VALUE) {
        await client.call("focus.clear", {});
        ctx.ui.notify("Focus cleared", "info");
      } else {
        const { focus: newFocus } = await client.call("focus.set", { ref: result });
        ctx.ui.notify(`Focused ${newFocus.ref}: ${newFocus.title}\n${newFocus.url}`, "info");
      }
    } catch (err) {
      ctx.ui.notify(`error: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }

    await refreshStatus(ctx, client);
  }

  async function browseSavedQuery(ctx: ExtensionCommandContext, client: TicketsRpcClient, backend: string): Promise<void> {
    const { queries: allQueries } = await client.call("query.list", {});
    const queries = allQueries.filter((q) => q.backend === backend);
    if (queries.length === 0) {
      ctx.ui.notify(
        `No saved queries yet for ${backendDisplayName(backend)} -- create one with \`tickets query save <name> --backend ${backend} --jql "..."\`.`,
        "info",
      );
      return;
    }

    const name = await pickSavedQuery(ctx, queries);
    if (name === null) return;

    let issues: Issue[];
    try {
      ({ issues } = await client.call("query.run", { name, limit: BROWSE_LIMIT }));
    } catch (err) {
      ctx.ui.notify(`error running query "${name}": ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }

    if (issues.length === 0) {
      ctx.ui.notify(`Saved query "${name}" matched no issues.`, "info");
      return;
    }

    const { focus } = await client.call("focus.get", {});
    const byRef = new Map(issues.map((issue) => [issue.ref, issue] as const));
    const items: SelectItem[] = issues.map((issue) => ({
      value: issue.ref,
      label: issueLabel(issue),
      description: issueDescription(issue, focus?.ref),
    }));

    const result = await pickIssue(ctx, client, `Query: ${name}`, items, byRef);
    if (result === null) return;

    try {
      const { focus: newFocus } = await client.call("focus.set", { ref: result });
      ctx.ui.notify(`Focused ${newFocus.ref}: ${newFocus.title}\n${newFocus.url}`, "info");
    } catch (err) {
      ctx.ui.notify(`error: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }

    await refreshStatus(ctx, client);
  }

  async function showBoard(ctx: ExtensionCommandContext, client: TicketsRpcClient, backend: string): Promise<void> {
    const { queries: allQueries } = await client.call("query.list", {});
    const queries = allQueries.filter((q) => q.backend === backend);
    if (queries.length === 0) {
      ctx.ui.notify(
        `No saved queries yet for ${backendDisplayName(backend)} -- create one with \`tickets query save <name> --backend ${backend} --jql "..."\`.`,
        "info",
      );
      return;
    }

    const name = await pickSavedQuery(ctx, queries);
    if (name === null) return;

    let issues: Issue[];
    try {
      ({ issues } = await client.call("query.run", { name, limit: BROWSE_LIMIT }));
    } catch (err) {
      ctx.ui.notify(`error running query "${name}": ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }

    if (issues.length === 0) {
      ctx.ui.notify(`Saved query "${name}" matched no issues.`, "info");
      return;
    }

    await pushView<void>(
      ctx,
      (tui, theme, _kb, done) =>
        new KanbanBoardComponent(tui, theme, issues, name, {
          onOpenIssue: (issue) => showIssueDetail(ctx, client, issue.ref),
          onOpenUrl: (issue) => {
            if (!issue.url) return;
            try {
              open(issue.url);
            } catch {
              // headless/no-DISPLAY environment -- nothing more to do from inside the board.
            }
          },
          onClose: done,
        }),
    );
  }

  pi.registerCommand("tickets", {
    description:
      "Pick a connected provider (GitHub, GitLab, Jira) and browse its issues -- saved queries and Kanban board view for providers with a real query language",
    handler: async (args, ctx) => {
      let client: TicketsRpcClient;
      try {
        client = await getClient();
      } catch (err) {
        ctx.ui.notify(`tickets daemon unavailable: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      const query = args?.trim() ?? "";
      if (query) {
        await browseTickets(ctx, client, query);
        return;
      }

      const provider = await pickProvider(ctx, client);
      if (provider === null) return;

      const mode = await pickMode(ctx, provider);
      if (mode === null) return;

      if (mode === "issues") await browseTickets(ctx, client, "", provider.name);
      else if (mode === "query") await browseSavedQuery(ctx, client, provider.name);
      else if (mode === "board") await showBoard(ctx, client, provider.name);
    },
  });

  async function showIssueDetail(ctx: ExtensionCommandContext, client: TicketsRpcClient, ref: string): Promise<void> {
    let issue: Issue;
    try {
      ({ issue } = await client.call("issue.get", { ref }));
    } catch (err) {
      ctx.ui.notify(`error loading ${ref}: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    let comments: Comment[] = [];
    try {
      ({ comments } = await client.call("issue.comments", { ref }));
    } catch {
      // Comments unsupported or unreachable for this backend -- show the issue without them rather than failing the whole view.
    }
    await pushView<void>(ctx, (tui, theme, _kb, done) => new IssueDetailComponent(tui, theme, issue, comments, done));
  }
}
