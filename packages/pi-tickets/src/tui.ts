/**
 * Interactive TUI for pi-tickets: `/tickets` with no args opens one
 * persistent panel -- a tab bar of every configured provider (GitHub,
 * GitLab, Jira), each tab's content a live, standing view (an issue list,
 * or for a backend with a real query language like Jira's JQL, its own
 * Issues/Saved queries/Board view sub-tabs) that stays mounted for the
 * whole session. `/tickets <query>` skips the panel and pushes a single
 * quick cross-backend search view -- that shortcut stays one-shot.
 *
 * This replaced a walkable tree of dialogs (pick a provider, resolve into
 * a leaf, close, open a DIFFERENT dialog for the actual content) with
 * Malevich's TabbedContainer -- the same fix pi-packed's own panel made
 * for its Packages/Find/Config/Settings screens: every feature lives
 * inside ONE overlay for the panel's whole lifetime, switching tabs never
 * tears anything down. Left/Right or Tab/Shift-Tab cycle tabs (wrapping);
 * a mnemonic character jumps directly and activates in one step -- none of
 * pi-tui's own SelectList (every tab's own picker) treats a printable key
 * as live-filter input, so a mnemonic never collides with browsing a list.
 * 's' jumps straight to the shared /secrets flow the same way. Escape
 * returns to the first tab from any other, or closes the whole panel from
 * the first tab -- unless the active tab's own capturesEscape() says it
 * wants that key for itself right now (Jira's Board/Saved-queries tabs use
 * this to back out of a live query to their own picker instead of leaving
 * the tab), and Left/Right instead cycle a Kanban board's own columns
 * while one is showing (capturesHorizontalArrows).
 *
 * Enter sets focus (or clears it on the synthetic first row), 'v' opens
 * the full ticket detail view, 'o' opens the issue's real web URL, 'r'
 * refreshes from source. A footer status always shows the current focus
 * so it's visible outside the dialog too, refreshed on session start and
 * after every "tickets" tool call -- including autonomous focus_* calls
 * the LLM makes mid-conversation, so the human and the LLM are always
 * looking at the same focus state.
 *
 * Deliberately NOT exposed here: OAuth login and daemon lifecycle control,
 * for the same reason they're excluded from the tool actions in index.ts --
 * both belong to a human at a terminal (`tickets auth login`, `tickets
 * daemon stop`), not a `/` command an LLM conversation could trigger.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import { Envelope, TabbedContainer, type TabbedContainerTab } from "malevich-tui-components";
import { listSecretsContributors, mergeSecretsContributions, runSecretsCommand } from "@danypops/vehicle-client-pi/secrets-tui";
import { type Comment, createTicketsClient, type EnsureDaemonOptions, type Issue, openUrl, type TicketFocusState, type TicketsRpcClient } from "@danypops/tickets";
import { BoardTabComponent } from "./board-view.js";
import { IssueDetailComponent } from "./issue-detail-view.js";
import { IssueListComponent } from "./issue-list-view.js";
import { tabBarTheme } from "./menu-theme.js";
import { pushView } from "./navigation.js";
import { SavedQueryTabComponent } from "./saved-query-view.js";
import { isTicketsVehicleTool } from "./vehicle-client.js";

const BROWSE_LIMIT = 100;
/** First letter that's actually distinct within the real product name (GitHub/GitLab share a G, so "Hub"/"Lab" are what's unique); Jira's own three sub-tabs also all start with J, so each gets its own letter too. 's' (settings) is reserved globally -- never assigned here. */
const TAB_MNEMONICS: Record<string, string> = { github: "h", gitlab: "l", "jira-issues": "i", "jira-query": "q", "jira-board": "b" };

type BackendCapability = { name: string; supportsRawQuery: boolean };

/** A tab's own claim on a key the host would otherwise handle itself -- escape (back out of a live query to this tab's own picker), left/right (a Kanban board's own column navigation), or every printable key (a live typeahead SelectList in charge right now). Optional: a tab with none of these just falls through to the host's own default handling for that key. */
interface TabScope {
  capturesEscape?(): boolean;
  capturesHorizontalArrows?(): boolean;
  capturesMnemonics?(): boolean;
}

export interface TicketsTuiDeps {
  /** Overridden in tests instead of spawning/reaching a real daemon. */
  getClient?: (opts?: EnsureDaemonOptions) => Promise<TicketsRpcClient>;
  /** Overridden in tests instead of actually spawning a browser process. */
  openUrl?: (url: string) => void;
  /** Overridden in tests instead of opening the real, shared /secrets flow. */
  openSettings?: (ctx: ExtensionCommandContext) => Promise<void>;
}

/** The same merge the shared `/secrets` command itself performs, invoked directly so 's' inside the panel can jump straight there without leaving /tickets. */
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
  const icon = focus.status === "paused" ? "\u23f8" : "\ud83c\udfaf";
  return theme.fg("accent", `${icon} ${focus.ref}`);
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

  function openIssueUrl(issue: Issue): void {
    if (!issue.url) return;
    try {
      open(issue.url);
    } catch {
      // headless/no-DISPLAY environment — nothing more to do from inside the panel.
    }
  }

  /** `/tickets <query>` -- a one-shot, cross-backend search view, not part of the persistent panel. Escape closes it; nothing else about it differs from any other IssueListComponent. */
  async function quickSearch(ctx: ExtensionCommandContext, client: TicketsRpcClient, query: string, backend?: string): Promise<void> {
    await pushView<void>(ctx, (tui, theme, _kb, done) => {
      const list = new IssueListComponent(tui, theme, ctx, client, {
        title: backend ? `${backendDisplayName(backend)} issues` : "Tickets",
        query,
        showClearFocus: true,
        loadIssues: (q) => client.call("ledger.search", { query: q, limit: BROWSE_LIMIT, backend }).then((r) => r.issues),
        emptyMessage: (q) => {
          const scope = backend ? `${backendDisplayName(backend)} tickets` : "pooled tickets";
          return q
            ? `No ${scope} matching "${q}" yet (the ledger only has what's synced so far).`
            : `No ${scope} pooled yet \u2014 the ledger fills in as the daemon syncs, or after issue.get/list/search calls.`;
        },
        onOpenIssue: (issue) => showIssueDetail(ctx, client, issue.ref),
        onOpenUrl: openIssueUrl,
        onFocusChanged: () => void refreshStatus(ctx, client),
      });
      return {
        render: (w: number) => list.render(w),
        invalidate: () => list.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "escape")) {
            done();
            return;
          }
          list.handleInput(data);
        },
      };
    });
  }

  /** One tab per configured backend that has no real query language; three (Issues/Saved queries/Board view) for one that does (Jira's JQL today). */
  function buildTabs(
    tui: TUI,
    theme: Theme,
    ctx: ExtensionCommandContext,
    client: TicketsRpcClient,
    backends: BackendCapability[],
  ): (TabbedContainerTab & TabScope)[] {
    const onOpenIssue = (issue: Issue) => showIssueDetail(ctx, client, issue.ref);
    const onFocusChanged = () => void refreshStatus(ctx, client);

    return backends.flatMap((b): (TabbedContainerTab & TabScope)[] => {
      const displayName = backendDisplayName(b.name);
      if (!b.supportsRawQuery) {
        const content = new IssueListComponent(tui, theme, ctx, client, {
          title: `${displayName} issues`,
          showClearFocus: true,
          loadIssues: (q) => client.call("ledger.search", { query: q, limit: BROWSE_LIMIT, backend: b.name }).then((r) => r.issues),
          emptyMessage: () => `No ${displayName} tickets pooled yet \u2014 the ledger fills in as the daemon syncs, or after issue.get/list/search calls.`,
          onOpenIssue,
          onOpenUrl: openIssueUrl,
          onFocusChanged,
        });
        return [{ key: b.name, label: displayName, mnemonic: TAB_MNEMONICS[b.name], content }];
      }

      const issues = new IssueListComponent(tui, theme, ctx, client, {
        title: `${displayName} issues`,
        showClearFocus: true,
        loadIssues: (q) => client.call("ledger.search", { query: q, limit: BROWSE_LIMIT, backend: b.name }).then((r) => r.issues),
        emptyMessage: () => `No ${displayName} tickets pooled yet \u2014 the ledger fills in as the daemon syncs, or after issue.get/list/search calls.`,
        onOpenIssue,
        onOpenUrl: openIssueUrl,
        onFocusChanged,
      });
      const savedQueries = new SavedQueryTabComponent(tui, theme, ctx, client, {
        backend: b.name,
        backendDisplayName: displayName,
        onOpenIssue,
        onOpenUrl: openIssueUrl,
        onFocusChanged,
      });
      const board = new BoardTabComponent(tui, theme, client, { backend: b.name, backendDisplayName: displayName, onOpenIssue, onOpenUrl: openIssueUrl });

      return [
        { key: `${b.name}-issues`, label: `${displayName} Issues`, mnemonic: TAB_MNEMONICS[`${b.name}-issues`], content: issues },
        { key: `${b.name}-query`, label: `${displayName} Queries`, mnemonic: TAB_MNEMONICS[`${b.name}-query`], content: savedQueries, capturesEscape: () => savedQueries.capturesEscape() },
        { key: `${b.name}-board`, label: `${displayName} Board`, mnemonic: TAB_MNEMONICS[`${b.name}-board`], content: board, capturesEscape: () => board.capturesEscape(), capturesHorizontalArrows: () => board.capturesHorizontalArrows() },
      ];
    });
  }

  /** The persistent panel itself: one Envelope + one TabbedContainer, alive for the panel's whole lifetime. Returns null when nothing is configured. */
  async function openTicketsPanel(ctx: ExtensionCommandContext, client: TicketsRpcClient): Promise<void> {
    const { backends } = await client.call("backends.list", {});
    if (backends.length === 0) {
      ctx.ui.notify("No backends configured yet -- set up GitHub/GitLab/Jira credentials first.", "info");
      return;
    }

    await pushView<void>(ctx, (tui, theme, _kb, done) => {
      const tabs = buildTabs(tui, theme, ctx, client, backends);
      const homeKey = tabs[0]!.key;
      const tabByKey = new Map(tabs.map((t) => [t.key, t] as const));

      const tabbedContainer = new TabbedContainer({
        tabs,
        theme: tabBarTheme(theme),
        // Malevich's own default matcher only recognizes legacy CSI sequences;
        // pi-tui's real matchesKey also covers the Kitty keyboard protocol and
        // xterm's modifyOtherKeys encodings for the same keys.
        matchesKey: (data, keyId) => matchesKey(data, keyId as Parameters<typeof matchesKey>[1]),
      });

      const envelope = new Envelope({
        title: "tickets",
        borderStyle: "rounded",
        style: (s) => theme.fg("border", s),
        titleStyle: (s) => theme.bold(theme.fg("accent", s)),
      });

      return {
        render: (width: number) => {
          envelope.setContent(tabbedContainer);
          return envelope.render(width);
        },
        invalidate: () => envelope.invalidate(),
        handleInput: (data: string) => {
          const activeKey = tabbedContainer.getActiveKey();
          const activeTab = tabByKey.get(activeKey);

          if (matchesKey(data, "escape") && !(activeTab?.capturesEscape?.() ?? false)) {
            if (activeKey !== homeKey) tabbedContainer.setActive(homeKey);
            else {
              done();
              return;
            }
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
            tabbedContainer.handleInput(data);
            tui.requestRender();
            return;
          }
          if ((matchesKey(data, "left") || matchesKey(data, "right")) && !(activeTab?.capturesHorizontalArrows?.() ?? false)) {
            tabbedContainer.handleInput(data);
            tui.requestRender();
            return;
          }
          if (!(activeTab?.capturesMnemonics?.() ?? false) && data.length === 1) {
            if (data === "s") {
              void openSettings(ctx).then(() => tui.requestRender());
              return;
            }
            const target = tabbedContainer.resolveMnemonic(data);
            if (target && target !== activeKey) {
              tabbedContainer.setActive(target);
              tui.requestRender();
              return;
            }
          }
          tabbedContainer.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  pi.registerCommand("tickets", {
    description: "Open a persistent panel over every connected provider (GitHub, GitLab, Jira) -- saved queries and a Kanban board view for providers with a real query language",
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
        await quickSearch(ctx, client, query);
        return;
      }

      await openTicketsPanel(ctx, client);
    },
  });
}
