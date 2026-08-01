import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TabBarTheme } from "malevich-tui-components";

/**
 * Maps Pi's own Theme onto Malevich's TabbedContainer -- the persistent
 * provider/mode tab bar at the top of /tickets' one overlay.
 *
 * activeTab deliberately does NOT use theme.inverse() (real ANSI reverse
 * video): pi-packed hit this live -- inverse() swaps whatever foreground/
 * background happen to be ambient at that exact point in the ANSI stream,
 * it doesn't set a specific color, and Envelope wraps this whole tab-bar
 * line in one continuous border-color span with no reset until the line's
 * end. Which tab is active changes what "ambient" means at that point in
 * the stream (the border's own color if nothing before it reset yet, the
 * terminal's plain default if an earlier inactive tab's own fg reset
 * already cleared it) -- so the highlight color silently depended on tab
 * position, not a real theme color. theme.bg() always overwrites rather
 * than swaps, so it's immune to that; matches Pi's own core
 * session-selector.js, which highlights its selected line the same way.
 */
export function tabBarTheme(theme: Theme): TabBarTheme {
  return {
    tab: (s) => theme.fg("dim", s),
    activeTab: (s) => theme.bg("selectedBg", s),
    mnemonic: (s) => theme.underline(theme.bold(theme.fg("accent", s))),
  };
}
