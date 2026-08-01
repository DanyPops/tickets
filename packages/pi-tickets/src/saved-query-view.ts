/**
 * A backend's "Saved queries" tab: starts on SavedQueryPickerComponent,
 * and once a query is chosen, swaps its own content in place for a live
 * IssueListComponent over that query's results -- escape from the
 * results returns to the picker instead of leaving the tab (see
 * capturesEscape), the same content-swap-in-place pattern
 * BoardTabComponent uses for its own pick/board split.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Issue, TicketsRpcClient } from "@danypops/tickets";
import { IssueListComponent } from "./issue-list-view.js";
import { SavedQueryPickerComponent } from "./saved-query-picker.js";

export interface SavedQueryTabOptions {
  backend: string;
  backendDisplayName: string;
  onOpenIssue: (issue: Issue) => Promise<void>;
  onOpenUrl?: (issue: Issue) => void;
  onFocusChanged?: () => void;
}

export class SavedQueryTabComponent implements Component {
  private readonly picker: SavedQueryPickerComponent;
  private browsing: IssueListComponent | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly ctx: ExtensionCommandContext,
    private readonly client: TicketsRpcClient,
    private readonly opts: SavedQueryTabOptions,
  ) {
    this.picker = new SavedQueryPickerComponent(tui, theme, client, opts.backend, opts.backendDisplayName, (name) => this.browseQuery(name));
  }

  /** While browsing a query's results, escape belongs to this tab (back to the picker), not the host's own tab-jump/close handling. */
  capturesEscape(): boolean {
    return this.browsing !== undefined;
  }

  invalidate(): void {
    this.picker.invalidate();
    this.browsing?.invalidate();
  }

  private browseQuery(name: string): void {
    this.browsing = new IssueListComponent(this.tui, this.theme, this.ctx, this.client, {
      title: `Query: ${name}`,
      showClearFocus: false,
      loadIssues: async () => (await this.client.call("query.run", { name, limit: 100 })).issues,
      emptyMessage: () => `Saved query "${name}" matched no issues.`,
      onOpenIssue: this.opts.onOpenIssue,
      onOpenUrl: this.opts.onOpenUrl,
      onFocusChanged: this.opts.onFocusChanged,
      framed: false, // hosted as a tab inside the persistent panel's own Envelope
    });
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.browsing ? this.browsing.render(width) : this.picker.render(width);
  }

  handleInput(data: string): void {
    if (this.browsing) {
      if (matchesKey(data, "escape")) {
        this.browsing = undefined;
        this.tui.requestRender();
        return;
      }
      this.browsing.handleInput(data);
      return;
    }
    this.picker.handleInput(data);
  }
}
