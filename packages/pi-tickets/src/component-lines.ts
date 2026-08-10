/**
 * Small `Component` decorators shared by every bounded presentation renderer
 * (list-table.ts, board-table.ts): wrap an inner Component's own render output
 * with one extra leading/trailing line, truncated to the real width. Split out
 * once a second renderer needed the exact same two helpers list-table.ts had
 * already built, rather than re-deriving or copy-pasting them.
 */
import { neutralizeEmbeddedFullResets } from "@danypops/vehicle-client-pi/vehicle-render";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth as truncateToWidthUnsafe } from "@earendil-works/pi-tui";

/**
 * Same ANSI-safety fix list-table.ts's own truncateToWidth applies: pi-tui's own
 * truncateToWidth embeds an unconditional full SGR reset even for plain text, which kills
 * Pi's own tool-output background paint mid-line -- see list-table.ts's header comment for
 * the original diagnosis. Reused here rather than re-derived.
 */
function truncateToWidth(text: string, maxWidth: number): string {
  return neutralizeEmbeddedFullResets(truncateToWidthUnsafe(text, maxWidth));
}

export function withTrailingLine(inner: Component, line: string | undefined): Component {
  if (!line) return inner;
  const lines = line.split("\n").filter(Boolean);
  if (lines.length === 0) return inner;
  return {
    render: (width: number) => [...inner.render(width), ...lines.map((l) => truncateToWidth(l, width))],
    invalidate: () => inner.invalidate(),
  };
}

export function withLeadingLine(inner: Component, line: string): Component {
  return {
    render: (width: number) => [truncateToWidth(line, width), ...inner.render(width)],
    invalidate: () => inner.invalidate(),
  };
}
