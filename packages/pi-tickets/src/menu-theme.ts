import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TabBarTheme } from "malevich-tui-components";

/** Maps Pi's own Theme onto Malevich's TabbedContainer -- the persistent provider/mode tab bar at the top of /tickets' one overlay. Matches pi-packed's own convention: real ANSI reverse-video for the focused tab, since a theme's own selectedBg can be too close in luminance to the surrounding UI to read as a highlight at all -- reverse video swaps whatever foreground and background are already in effect, guaranteeing contrast on any theme. */
export function tabBarTheme(theme: Theme): TabBarTheme {
  return {
    tab: (s) => theme.fg("dim", s),
    activeTab: (s) => theme.inverse(s),
    mnemonic: (s) => theme.bold(theme.fg("warning", s)),
  };
}
