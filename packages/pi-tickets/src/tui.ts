/**
 * Interactive TUI for pi-tickets: `/tickets` with no args opens a provider
 * picker (only the backends the daemon actually has configured), then a
 * per-provider mode menu -- every backend gets Issues (browse & search);
 * a backend with a real query language (Jira's JQL today) also gets Saved
 * queries and Board view. `/tickets <query>` skips both pickers and jumps
 * straight to a cross-backend search over the pooled ledger -- the
 * quick-search shortcut stays a one-shot command.
 *
 * The provider picker itself is one walkable tmux-style tab bar (Malevich's
 * TabMenu), not a chain of separate dialogs: the root tabs are the
 * configured providers, and a provider with a real query language (Jira's
 * JQL today) has its own child tabs (Issues / Saved queries / Board view)
 * one Enter-press down -- Escape climbs back up to the provider tabs
 * instead of canceling the whole flow. A provider with only one real mode
 * (GitHub/GitLab today) is a leaf: Enter resolves it directly. Left/right
 * and Tab/Shift+Tab flip between tabs at the current level (wrapping);
 * 'h'/'l'/'j' jump straight to GitHub/GitLab/Jira and activate them in one
 * step (each letter is a real, distinct substring of the product name --
 * "Hub"/"Lab"/"Jira" -- not just a first letter, and only fires for a
 * backend that's actually configured); 's' jumps straight to the shared
 * /secrets flow and returns to the still-open picker afterward.
 *
 * A level with only one real choice (a single configured backend, say) is
 * never shown -- pickProviderAndMode compresses that singleton chain down
 * to its own leaf/branch before ever building the TabMenu, rather than
 * asking a user to confirm a choice that isn't actually one.
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
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { BorderedSelectPanel, TabMenu, type TabMenuNode } from "malevich-tui-components";
import { listSecretsContributors, mergeSecretsContributions, runSecretsCommand } from "@danypops/vehicle-client-pi/secrets-tui";
import { type Comment, createTicketsClient, type EnsureDaemonOptions, type Issue, openUrl, type TicketFocusState, type TicketsRpcClient } from "@danypops/tickets";
import { KanbanBoardComponent } from "./board-view.js";
import { IssueDetailComponent } from "./issue-detail-view.js";
import { pushView } from "./navigation.js";
import { isTicketsVehicleTool } from "./vehicle-client.js";

const CLEAR_FOCUS_VALUE = "__tickets_clear_focus__";
const BROWSE_LIMIT = 100;
/** First letter that's actually distinct within the real product name (GitHub/GitLab share a G, so "Hub"/"Lab" are what's unique) -- instant-select, not just filter-as-you-type. Only fires for a backend that's actually configured. */
const PROVIDER_MNEMONICS: Record<string, string> = { github: "h", gitlab: "l", jira: "j" };
/** Malevich's TabMenu takes a plain string keyId; pi-tui's matchesKey narrows it to its own closed KeyId union -- the picker only ever calls this with the fixed small set that's a real KeyId, so the cast is safe (same pattern as board-view.ts's boardKeyMatcher). */
const providerKeyMatcher = (data: string, keyId: string) => matchesKey(data, keyId as KeyId);

type SavedQuerySummary = { name: string; backend: string; query: string; description?: string };
type BackendCapability = { name: string; supportsRawQuery: boolean };
type ProviderMode = "issues" | "query" | "board";
type ProviderSelection = { backend: string; mode: ProviderMode };

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
  /** One node per configured backend; a backend with raw-query support gets its own child tabs for Issues/Saved queries/Board view, everything else is a leaf that resolves directly. */
  function buildProviderTree(backends: BackendCapability[]): TabMenuNode<ProviderSelection>[] {
    return backends.map((b): TabMenuNode<ProviderSelection> => {
      const displayName = backendDisplayName(b.name);
      const mnemonic = PROVIDER_MNEMONICS[b.name];
      if (!b.supportsRawQuery) {
        return { label: displayName, mnemonic, description: "Issues", value: { backend: b.name, mode: "issues" } };
      }
      return {
        label: displayName,
        mnemonic,
        description: "Issues, saved queries, and board view",
        children: [
          { label: "Issues", description: `Browse & search ${displayName} issues`, value: { backend: b.name, mode: "issues" } },
          { label: "Saved queries", description: "Run a saved JQL query -- e.g. a board's sprint or backlog", value: { backend: b.name, mode: "query" } },
          { label: "Board view", description: "Kanban board (TO DO / IN PROGRESS / REVIEW / DONE) for a saved query", value: { backend: b.name, mode: "board" } },
        ],
      };
    });
  }

  /** Descends through every singleton level (a lone backend, or a lone mode) before ever building a TabMenu, so a level with no real choice is never shown. */
  function autoResolveProviderTree(nodes: TabMenuNode<ProviderSelection>[]): { resolved: ProviderSelection } | { nodes: TabMenuNode<ProviderSelection>[] } {
    if (nodes.length !== 1) return { nodes };
    const only = nodes[0]!;
    if (only.children?.length) return autoResolveProviderTree(only.children);
    return { resolved: only.value as ProviderSelection };
  }

  /** Which backend and mode to browse -- one walkable tab bar, not a chain of dialogs. Returns null when nothing is configured or the user cancels. */
  async function pickProviderAndMode(ctx: ExtensionCommandContext, client: TicketsRpcClient): Promise<ProviderSelection | null> {
    const { backends } = await client.call("backends.list", {});
    if (backends.length === 0) {
      ctx.ui.notify("No backends configured yet -- set up GitHub/GitLab/Jira credentials first.", "info");
      return null;
    }

    const auto = autoResolveProviderTree(buildProviderTree(backends));
    if ("resolved" in auto) return auto.resolved;

    return ctx.ui.custom<ProviderSelection | null>((tui, theme, _kb, done) => {
      const menu = new TabMenu<ProviderSelection>({
        nodes: auto.nodes,
        theme: {
          tab: (s: string) => theme.fg("dim", s),
          activeTab: (s: string) => theme.inverse(s),
          breadcrumb: (s: string) => theme.fg("accent", s),
          description: (s: string) => theme.fg("muted", s),
          help: (s: string) => theme.fg("dim", s),
        },
        onSelect: (value) => done(value),
        onCancel: () => done(null),
        matchesKey: providerKeyMatcher,
      });
      return {
        render: (w: number) => {
          const lines = menu.render(w);
          const last = lines.length - 1;
          lines[last] = `${lines[last]}${theme.fg("dim", " \u2022 s settings")}`;
          return lines;
        },
        invalidate: () => menu.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "s")) {
            void openSettings(ctx).then(() => tui.requestRender());
            return;
          }
          menu.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  /** Issue-list picker shared by browse&search and saved-query browsing: enter focuses, 'v' views, 'o' opens in browser. */
  async function pickIssue(ctx: ExtensionCommandContext, client: TicketsRpcClient, title: string, items: SelectItem[], byRef: Map<string, Issue>): Promise<string | null> {
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
    for (const issue of issues) items.push({ value: issue.ref, label: issueLabel(issue), description: issueDescription(issue, focus?.ref) });

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
      ctx.ui.notify(`No saved queries yet for ${backendDisplayName(backend)} -- create one with \`tickets query save <name> --backend ${backend} --jql "..."\`.`, "info");
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
    const items: SelectItem[] = issues.map((issue) => ({ value: issue.ref, label: issueLabel(issue), description: issueDescription(issue, focus?.ref) }));

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
      ctx.ui.notify(`No saved queries yet for ${backendDisplayName(backend)} -- create one with \`tickets query save <name> --backend ${backend} --jql "..."\`.`, "info");
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

    await pushView<void>(ctx, (tui, theme, _kb, done) =>
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
      }));
  }

  pi.registerCommand("tickets", {
    description: "Pick a connected provider (GitHub, GitLab, Jira) and browse its issues -- saved queries and Kanban board view for providers with a real query language",
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

      const selection = await pickProviderAndMode(ctx, client);
      if (selection === null) return;

      if (selection.mode === "issues") await browseTickets(ctx, client, "", selection.backend);
      else if (selection.mode === "query") await browseSavedQuery(ctx, client, selection.backend);
      else if (selection.mode === "board") await showBoard(ctx, client, selection.backend);
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
