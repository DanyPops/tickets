/**
 * A view is pushed as a nested overlay; returning from that push (its
 * `done()` fires) is the only "back" edge a caller needs -- the async call
 * stack already is the navigation history, so there's no separate stack
 * data structure to keep in sync with what's on screen.
 */
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";

/**
 * Matches Pi's own main viewport footprint instead of a centered box, so a
 * rendered line's width stays stable and can be selected/copied whole in a
 * terminal multiplexer.
 */
export const FULL_SCREEN_OVERLAY: OverlayOptions = { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 };

export function pushView<T>(
  ctx: ExtensionCommandContext,
  factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component,
): Promise<T> {
  return ctx.ui.custom<T>(factory, { overlay: true, overlayOptions: FULL_SCREEN_OVERLAY });
}
