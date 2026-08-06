/**
 * Groups a raw-query backend's own Issues/Saved-queries/Board views into
 * ONE outer-panel tab -- a real submenu, not three flat top-level tabs.
 * Built by nesting a second TabbedContainer, not a new primitive:
 * TabbedContainer is already a plain Component, so a tab's own `content`
 * can itself be one.
 *
 * Tab/Shift-Tab and Left/Right both cycle this group's own three tabs
 * (matching the outer panel's own "Left/Right cycle tabs the same as Tab"
 * convention, one level down) -- unless the active leaf wants Left/Right
 * for itself (Board's own kanban columns), which still takes priority the
 * same way it would for a flat tab. Escape ascends one level at a time:
 * a leaf's own captured state first (Board showing a board, Saved-queries
 * mid-browse), then this group's own home (Issues), and only once neither
 * applies does it stop capturing escape at all -- letting the outer panel
 * take over and go back to ITS own home instead of skipping straight to
 * closing the whole thing.
 */

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type TabBarTheme, TabbedContainer } from "malevich-tui-components";
import { activeScopedTab, handleHorizontalArrow, handleMnemonicJump, type ScopedTab } from "./tab-dispatch.js";

export class BackendTabGroupComponent implements Component {
  private readonly container: TabbedContainer;
  private readonly tabByKey: Map<string, ScopedTab>;
  private readonly homeKey: string;

  constructor(tabs: ScopedTab[], theme: TabBarTheme) {
    this.container = new TabbedContainer({
      tabs,
      theme,
      // measure must be explicit: TabbedContainer's own default is ASCII-only
      // (raw .length, blind to ANSI escape codes) and the tab bar is styled
      // through theme.tab/theme.activeTab/theme.mnemonic -- without this, a
      // narrow render width truncates the styled bar by raw byte count,
      // landing mid-escape-sequence (confirmed live: pi-tickets' own
      // tui.test.ts width-consistency regression).
      measure: { visibleWidth, truncateToWidth },
      // Malevich's own default matcher only recognizes legacy CSI sequences;
      // pi-tui's real matchesKey also covers the Kitty keyboard protocol and
      // xterm's modifyOtherKeys encodings for the same keys.
      matchesKey: (data, keyId) => matchesKey(data, keyId as Parameters<typeof matchesKey>[1]),
    });
    this.tabByKey = new Map(tabs.map((t) => [t.key, t] as const));
    this.homeKey = tabs[0]!.key;
  }

  private active(): ScopedTab | undefined {
    return activeScopedTab(this.container, this.tabByKey);
  }

  /** Claims escape whenever there's somewhere to ascend to within this group -- its active leaf's own captured state, or (when not yet on its own home) just returning there. Once genuinely at home with nothing captured, returns false so the outer panel's own escape (back to ITS home) takes over one level at a time, instead of this group swallowing the key with nothing left to do. */
  capturesEscape(): boolean {
    if (this.active()?.capturesEscape?.()) return true;
    return this.container.getActiveKey() !== this.homeKey;
  }

  /** Always claims Left/Right -- either for this group's own sub-tab cycling, or (delegated further, see handleInput) the active leaf's own use of them. */
  capturesHorizontalArrows(): boolean {
    return true;
  }

  /** Always claims Tab/Shift-Tab for its own sub-tab cycling -- no leaf here ever wants Tab for itself. */
  capturesTabCycle(): boolean {
    return true;
  }

  capturesMnemonics(): boolean {
    return this.active()?.capturesMnemonics?.() ?? false;
  }

  invalidate(): void {
    this.container.invalidate();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  handleInput(data: string): void {
    const activeTab = this.active();

    if (matchesKey(data, "escape") && !(activeTab?.capturesEscape?.() ?? false)) {
      if (this.container.getActiveKey() !== this.homeKey) this.container.setActive(this.homeKey);
      // Already at home with nothing captured: capturesEscape() already
      // told the outer panel to take over instead of routing escape here.
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      handleHorizontalArrow(this.container, activeTab, data);
      return;
    }
    if (handleMnemonicJump(this.container, activeTab, data)) return;
    this.container.handleInput(data);
  }
}
