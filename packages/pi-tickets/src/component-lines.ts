/**
 * Small shared utilities for every bounded presentation renderer (list-table.ts,
 * board-table.ts, board-view.ts, issues/issue-detail-view.ts): an ANSI-safe truncateToWidth
 * wrapper, plus two `Component` decorators that wrap an inner Component's own render output
 * with one extra leading/trailing line, truncated the same safe way. Consolidated here after
 * an audit found the exact same truncateToWidth wrapper independently copy-pasted in four
 * separate files -- this is the one real definition; every other file imports it from here
 * instead of re-deriving or copy-pasting it again.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth as truncateToWidthUnsafe } from "@earendil-works/pi-tui";
import { neutralizeEmbeddedFullResets } from "malevich-tui-components";

/**
 * pi-tui's own truncateToWidth embeds an unconditional full SGR reset (`\x1b[0m`) after any
 * truncated content, even for plain, uncolored text -- fine in isolation, but fatal once an
 * outer component (e.g. Pi's own tool-output Box) paints one background color across the
 * entire line: a full reset embedded mid-line kills that background early, so everything
 * after it renders on the terminal's own default background instead. `neutralizeEmbeddedFullResets`
 * (now living in malevich-tui-components -- see its own doc comment for the full diagnosis)
 * replaces that reset with one that never touches background. Exported so every caller that
 * needs a safe truncateToWidth shares this one definition instead of re-deriving it.
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string {
  return neutralizeEmbeddedFullResets(truncateToWidthUnsafe(text, maxWidth, ellipsis, pad));
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
