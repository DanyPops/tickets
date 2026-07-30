/**
 * Interactive TUI for pi-tickets: `/tickets [query]` opens a browsable list
 * of every issue the daemon's ledger has pooled across all configured
 * backends (GitHub/GitLab/Jira in one flat list, no backend picker needed),
 * lets you set focus with Enter, open the issue's real web URL in a browser
 * with 'o', or clear the current focus via a special first row. A footer
 * status always shows the current focus so it's visible outside the dialog
 * too, refreshed on session start and after every "tickets" tool call —
 * including autonomous focus_* calls the LLM makes mid-conversation, so the
 * human and the LLM are always looking at the same focus state.
 *
 * Deliberately NOT exposed here: OAuth login and daemon lifecycle control,
 * for the same reason they're excluded from the tool actions in index.ts —
 * both belong to a human at a terminal (`tickets auth login`, `tickets
 * daemon stop`), not a `/` command an LLM conversation could trigger.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { createTicketsClient, type EnsureDaemonOptions, type Issue, openUrl, type TicketFocusState, type TicketsRpcClient } from "@danypops/tickets";
import { isTicketsVehicleTool } from "./vehicle-client.js";

const CLEAR_FOCUS_VALUE = "__tickets_clear_focus__";
const BROWSE_LIMIT = 100;

export interface TicketsTuiDeps {
  /** Overridden in tests instead of spawning/reaching a real daemon. */
  getClient?: (opts?: EnsureDaemonOptions) => Promise<TicketsRpcClient>;
  /** Overridden in tests instead of actually spawning a browser process. */
  openUrl?: (url: string) => void;
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

  pi.registerCommand("tickets", {
    description: "Browse pooled tickets across GitHub/GitLab/Jira and set focus",
    handler: async (args, ctx) => {
      let client: TicketsRpcClient;
      try {
        client = await getClient();
      } catch (err) {
        ctx.ui.notify(`tickets daemon unavailable: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      const query = args?.trim() ?? "";
      const [{ focus }, { issues }] = await Promise.all([
        client.call("focus.get", {}),
        client.call("ledger.search", { query, limit: BROWSE_LIMIT }),
      ]);

      const items: SelectItem[] = [];
      if (focus) {
        items.push({ value: CLEAR_FOCUS_VALUE, label: "✕ Clear current focus", description: `${focus.ref} — ${focus.title}` });
      }
      for (const issue of issues) {
        items.push({ value: issue.ref, label: issueLabel(issue), description: issueDescription(issue, focus?.ref) });
      }

      if (items.length === 0) {
        ctx.ui.notify(
          query
            ? `No pooled tickets matching "${query}" yet (the ledger only has what's synced so far).`
            : "No tickets pooled yet — the ledger fills in as the daemon syncs, or after issue.get/list/search calls.",
          "info",
        );
        return;
      }

      const byRef = new Map(issues.map((issue) => [issue.ref, issue] as const));

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        const title = focus ? `Tickets — focused: ${focus.ref}` : "Tickets";
        container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

        // Built from the callback's own `theme` param, not the package's
        // getSelectListTheme() helper -- that reads a module-global theme
        // singleton that jiti-loaded extensions can't rely on being
        // initialized (same caveat the docs call out for DynamicBorder).
        const selectList = new SelectList(items, Math.min(items.length, 12), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);

        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter focus • o open in browser • esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
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
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });

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
    },
  });

  pi.registerCommand("query", {
    description: "Run a saved query (Jira JQL) and browse its issues -- e.g. a board's sprint or backlog view saved via `tickets query save`",
    handler: async (args, ctx) => {
      let client: TicketsRpcClient;
      try {
        client = await getClient();
      } catch (err) {
        ctx.ui.notify(`tickets daemon unavailable: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      const { queries } = await client.call("query.list", {});
      if (queries.length === 0) {
        ctx.ui.notify('No saved queries yet -- create one with `tickets query save <name> --backend jira --jql "..."`.', "info");
        return;
      }

      const requestedName = args?.trim();
      let name = requestedName;
      if (!name) {
        const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold("Saved queries")), 1, 0));
          const items: SelectItem[] = queries.map((q) => ({ value: q.name, label: q.name, description: q.description ?? `${q.backend}: ${q.query}` }));
          const selectList = new SelectList(items, Math.min(items.length, 12), {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          });
          selectList.onSelect = (item) => done(item.value);
          selectList.onCancel = () => done(null);
          container.addChild(selectList);
          container.addChild(new Text(theme.fg("dim", "\u2191\u2193 navigate \u2022 enter run \u2022 esc cancel"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        });
        if (picked === null) return;
        name = picked;
      }

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

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold(`Query: ${name}`)), 1, 0));
        const items: SelectItem[] = issues.map((issue) => ({ value: issue.ref, label: issueLabel(issue), description: issueDescription(issue, focus?.ref) }));
        const selectList = new SelectList(items, Math.min(items.length, 12), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
        container.addChild(new Text(theme.fg("dim", "\u2191\u2193 navigate \u2022 enter focus \u2022 o open in browser \u2022 esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (data === "o") {
              const highlighted = selectList.getSelectedItem();
              const issue = highlighted ? byRef.get(highlighted.value) : undefined;
              if (issue?.url) {
                try {
                  open(issue.url);
                } catch {
                  // headless/no-DISPLAY environment -- nothing more to do from inside the dialog.
                }
              }
              return;
            }
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (result === null) return;

      try {
        const { focus: newFocus } = await client.call("focus.set", { ref: result });
        ctx.ui.notify(`Focused ${newFocus.ref}: ${newFocus.title}\n${newFocus.url}`, "info");
      } catch (err) {
        ctx.ui.notify(`error: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      await refreshStatus(ctx, client);
    },
  });
}
