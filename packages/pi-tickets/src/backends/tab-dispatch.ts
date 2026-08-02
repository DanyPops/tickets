/**
 * Shared capture-aware input dispatch for a Malevich TabbedContainer --
 * used at both levels of /tickets' two-level tab hierarchy (the outer
 * provider bar, and a raw-query backend's own Issues/Queries/Board
 * submenu, see backend-tab-group.ts) so both levels handle Left/Right and
 * mnemonic jumps identically.
 *
 * handleHorizontalArrow fixes a real bug found live: a captured Left/Right
 * (Board's own kanban columns) still fell through to TabbedContainer's own
 * unconditional cycle-on-arrow handling, silently switching tabs instead
 * of reaching the leaf. TabbedContainer.handleInput() treats left/right as
 * "cycle my own tabs" before it ever considers delegating to the active
 * tab's content, so a capturing tab must be routed straight to its own
 * content.handleInput() instead of back through the container.
 */
import type { TabbedContainer, TabbedContainerTab } from "malevich-tui-components";

/** A tab's own claim on a key its host would otherwise handle itself -- escape (ascend one level instead of leaving), left/right (a leaf's own navigation, e.g. a Kanban board's columns, or a submenu's own tab cycling), tab/shift-tab (a submenu claiming it for its own tab cycling instead of the outer panel's provider cycling), or every printable key (a live typeahead list in charge right now). Optional: a tab with none of these just falls through to the host's own default handling for that key. */
export interface TabScope {
  capturesEscape?(): boolean;
  capturesHorizontalArrows?(): boolean;
  capturesTabCycle?(): boolean;
  capturesMnemonics?(): boolean;
}

export type ScopedTab = TabbedContainerTab & TabScope;

export function activeScopedTab(container: TabbedContainer, tabByKey: Map<string, ScopedTab>): ScopedTab | undefined {
  return tabByKey.get(container.getActiveKey());
}

/** Delegates Left/Right straight to the active tab's own content when it captures them, instead of letting TabbedContainer's own unconditional cycle-on-arrow swallow the key first (the real bug this module exists to fix). */
export function handleHorizontalArrow(container: TabbedContainer, activeTab: ScopedTab | undefined, data: string): void {
  if (activeTab?.capturesHorizontalArrows?.()) activeTab.content.handleInput?.(data);
  else container.handleInput(data);
}

/** Jumps directly to another tab by mnemonic, unless the active tab wants every printable key for itself (a live typeahead list). Returns true if it handled the key. */
export function handleMnemonicJump(container: TabbedContainer, activeTab: ScopedTab | undefined, data: string): boolean {
  if ((activeTab?.capturesMnemonics?.() ?? false) || data.length !== 1) return false;
  const target = container.resolveMnemonic(data);
  if (!target || target === container.getActiveKey()) return false;
  container.setActive(target);
  return true;
}
