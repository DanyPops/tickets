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
 *
 * anchor: "top-center" + offsetY, not "center" -- the same pinning fix
 * pi-packed's own identical panel needed (confirmed live there: an
 * anchor:"center" or row:"NN%" position recomputes from the CURRENT
 * content's own height on every render, so the whole panel visibly jitters
 * up and down as tab content of a different height becomes active -- an
 * Issues list's own row count vs. a Kanban board's. A fixed top offset
 * keeps the header pinned in place; only the footer moves as content
 * grows or shrinks.
 */
export const FULL_SCREEN_OVERLAY: OverlayOptions = { width: "100%", maxHeight: "100%", anchor: "top-center", offsetY: 1, margin: 0 };

export function pushView<T>(
  ctx: ExtensionCommandContext,
  factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component,
): Promise<T> {
  return ctx.ui.custom<T>(factory, { overlay: true, overlayOptions: FULL_SCREEN_OVERLAY });
}
