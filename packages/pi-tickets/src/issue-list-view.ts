/**
 * A persistent, live issue list -- the shared content behind every "browse
 * these issues" surface in /tickets (a backend's own Issues tab, a saved
 * query's results, the quick `/tickets <query>` cross-backend search):
 * one component, parameterized by how it fetches its own issues, instead
 * of a one-shot dialog closure per call site. Enter focuses (or clears
 * focus on the synthetic first row); 'v' pushes the full detail view; 'o'
 * opens the real URL; 'r' reloads from source.
 *
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem, TUI } from "@earendil-works/pi-tui";
import { SelectList } from "@earendil-works/pi-tui";
import { BorderedSelectPanel, type BorderedSelectPanelTheme } from "malevich-tui-components";
import type { Issue, TicketFocusState, TicketsRpcClient } from "@danypops/tickets";

const CLEAR_FOCUS_VALUE = "__tickets_clear_focus__";

export function issueLabel(issue: Issue): string {
  return `${issue.ref}  ${issue.title.replace(/[\r\n]+/g, " ").trim()}`;
}

export function issueDescription(issue: Issue, focusedRef: string | undefined): string {
  const parts: string[] = [issue.status, issue.priority];
  if (issue.ref === focusedRef) parts.push("FOCUSED");
  return parts.join(" \u00b7 ");
}

export function panelTheme(theme: Theme): BorderedSelectPanelTheme {
  return {
    border: (s) => theme.fg("accent", s),
    title: (s) => theme.fg("accent", theme.bold(s)),
    help: (s) => theme.fg("dim", s),
  };
}

export interface IssueListOptions {
  title: string;
  /** No live search box -- fixed once at construction ("" for a backend's own Issues tab, the real text for the quick `/tickets <query>` shortcut). */
  query?: string;
  /** Shown when loadIssues() resolves to an empty array, given the fixed query above ("" is the "nothing pooled yet" case; a real query is "no match"). */
  emptyMessage: (query: string) => string;
  /** True for the "search across everything" and "one backend's issues" surfaces; false for a saved query's results, which never offered a clear-focus row. */
  showClearFocus: boolean;
  loadIssues: (query: string) => Promise<Issue[]>;
  onOpenIssue: (issue: Issue) => Promise<void>;
  onOpenUrl?: (issue: Issue) => void;
  /** Fires after a successful focus.set/focus.clear, so a host can refresh its own status line. */
  onFocusChanged?: () => void;
  /** Defaults to true. False when hosted as a tab inside the persistent panel, already framed by its own Envelope -- true for the standalone quick-search view, which has no other border. */
  framed?: boolean;
}

export class IssueListComponent implements Component {
  private loading = true;
  private error: string | undefined;
  private issues: Issue[] = [];
  private focus: TicketFocusState | null = null;
  private byRef = new Map<string, Issue>();
  private panel: BorderedSelectPanel | undefined;
  private selectList: SelectList | undefined;
  private readonly query: string;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly ctx: ExtensionCommandContext,
    private readonly client: TicketsRpcClient,
    private readonly opts: IssueListOptions,
  ) {
    this.query = opts.query ?? "";
    void this.load();
  }

  invalidate(): void {
    this.panel?.invalidate();
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.tui.requestRender();
    try {
      const [{ focus }, issues] = await Promise.all([this.client.call("focus.get", {}), this.opts.loadIssues(this.query)]);
      this.focus = focus;
      this.issues = issues;
      this.byRef = new Map(issues.map((issue) => [issue.ref, issue] as const));
      this.buildPanel();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.tui.requestRender();
    }
  }

  private buildPanel(): void {
    const items: SelectItem[] = [];
    if (this.opts.showClearFocus && this.focus) {
      items.push({ value: CLEAR_FOCUS_VALUE, label: "\u2715 Clear current focus", description: `${this.focus.ref} \u2014 ${this.focus.title}` });
    }
    for (const issue of this.issues) items.push({ value: issue.ref, label: issueLabel(issue), description: issueDescription(issue, this.focus?.ref) });

    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (t: string) => this.theme.fg("accent", t),
      selectedText: (t: string) => this.theme.fg("accent", t),
      description: (t: string) => this.theme.fg("muted", t),
      scrollInfo: (t: string) => this.theme.fg("dim", t),
      noMatch: (t: string) => this.theme.fg("warning", t),
    });
    selectList.onSelect = (item) => void this.resolveSelection(item.value);
    this.selectList = selectList;
    this.panel = new BorderedSelectPanel({
      title: this.focus ? `${this.opts.title} \u2014 focused: ${this.focus.ref}` : this.opts.title,
      list: selectList,
      helpText: "\u2191\u2193 navigate \u2022 enter focus \u2022 v view \u2022 o open in browser \u2022 r refresh",
      theme: panelTheme(this.theme),
      framed: this.opts.framed ?? true,
    });
  }

  private async resolveSelection(value: string): Promise<void> {
    try {
      if (value === CLEAR_FOCUS_VALUE) {
        await this.client.call("focus.clear", {});
        this.ctx.ui.notify("Focus cleared", "info");
      } else {
        const { focus } = await this.client.call("focus.set", { ref: value });
        this.ctx.ui.notify(`Focused ${focus.ref}: ${focus.title}\n${focus.url}`, "info");
      }
    } catch (err) {
      this.ctx.ui.notify(`error: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    this.opts.onFocusChanged?.();
    await this.load();
  }

  render(width: number): string[] {
    if (this.loading) return [this.theme.fg("muted", "Loading\u2026")];
    if (this.error) return [this.theme.fg("error", this.error)];
    if (!this.panel) return [];
    if (this.issues.length === 0 && !(this.opts.showClearFocus && this.focus)) {
      return [this.theme.fg("muted", this.opts.emptyMessage(this.query))];
    }
    return this.panel.render(width);
  }

  handleInput(data: string): void {
    if (this.loading || !this.panel || !this.selectList) return;
    if (data === "o") {
      const highlighted = this.selectList.getSelectedItem();
      const issue = highlighted ? this.byRef.get(highlighted.value) : undefined;
      if (issue) this.opts.onOpenUrl?.(issue);
      return;
    }
    if (data === "v") {
      const highlighted = this.selectList.getSelectedItem();
      const issue = highlighted ? this.byRef.get(highlighted.value) : undefined;
      if (issue) void this.opts.onOpenIssue(issue).then(() => this.tui.requestRender());
      return;
    }
    if (data === "r") {
      void this.load();
      return;
    }
    this.panel.handleInput(data);
    this.tui.requestRender();
  }
}
