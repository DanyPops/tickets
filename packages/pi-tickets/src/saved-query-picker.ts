/**
 * "Pick one of this backend's saved queries" -- the first step shared by
 * both the Saved queries tab (then browses the result as an issue list)
 * and the Board tab (then renders it as a Kanban board). Owns loading,
 * the empty-state message, and the picker itself; not what happens after
 * a name is chosen, which differs per caller.
 */

import type { TicketsRpcClient } from "@danypops/tickets";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem, TUI } from "@earendil-works/pi-tui";
import { SelectList } from "@earendil-works/pi-tui";
import { BorderedSelectPanel } from "malevich-tui-components";
import { panelTheme } from "./issue-list-view.js";

export type SavedQuerySummary = { name: string; backend: string; query: string; description?: string };

export class SavedQueryPickerComponent implements Component {
  private loading = true;
  private queries: SavedQuerySummary[] = [];
  private panel: BorderedSelectPanel | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    client: TicketsRpcClient,
    private readonly backend: string,
    private readonly backendDisplayName: string,
    onPick: (name: string) => void,
  ) {
    void client.call("query.list", {}).then(({ queries: all }) => {
      this.queries = all.filter((q) => q.backend === backend);
      this.loading = false;
      this.buildPanel(onPick);
      this.tui.requestRender();
    });
  }

  private buildPanel(onPick: (name: string) => void): void {
    if (this.queries.length === 0) return;
    // The human description is what a person actually recognizes -- lead with
    // it, and push the internal saved-query name (the value `query run <name>`
    // actually takes) into the secondary column instead of the other way around.
    const items: SelectItem[] = this.queries.map((q) => ({
      value: q.name,
      label: q.description ?? q.name,
      description: q.description ? `(${q.name})` : `${q.backend}: ${q.query}`,
    }));
    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (t: string) => this.theme.fg("accent", t),
      selectedText: (t: string) => this.theme.fg("accent", t),
      description: (t: string) => this.theme.fg("muted", t),
      scrollInfo: (t: string) => this.theme.fg("dim", t),
      noMatch: (t: string) => this.theme.fg("warning", t),
    });
    selectList.onSelect = (item) => onPick(item.value);
    this.panel = new BorderedSelectPanel({
      title: "Saved queries",
      list: selectList,
      helpText: "\u2191\u2193 navigate \u2022 enter run \u2022 esc back",
      theme: panelTheme(this.theme),
      // Always hosted as a tab inside the persistent panel's own Envelope --
      // never used standalone, so no framed option to thread through.
      framed: false,
    });
  }

  invalidate(): void {
    this.panel?.invalidate();
  }

  render(width: number): string[] {
    if (this.loading) return [this.theme.fg("muted", "Loading\u2026")];
    if (this.queries.length === 0) {
      return [
        this.theme.fg(
          "muted",
          `No saved queries yet for ${this.backendDisplayName} -- create one with \`tickets query save <name> --backend ${this.backend} --jql "..."\`.`,
        ),
      ];
    }
    return this.panel?.render(width) ?? [];
  }

  handleInput(data: string): void {
    this.panel?.handleInput(data);
    this.tui.requestRender();
  }
}
