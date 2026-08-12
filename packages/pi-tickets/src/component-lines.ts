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
import { neutralizeEmbeddedFullResets, safeTruncateToWidth } from "malevich-tui-components";

/**
 * Guards a malevich-tui-components call against a real production failure mode: a long-running
 * Pi process resolving an older in-memory copy of the package (loaded before some export existed
 * there) while this file's own code -- reloaded more recently via a newer pi-tickets install --
 * still calls it unconditionally. That crashed with `TypeError: ... is not a function` three
 * frames deep inside a render call, with nothing in the render tree to contain it, taking the
 * whole session down. Degrading to the unguarded text is strictly better than that: a rare
 * cosmetic regression (a background color bleeding past where it should stop) instead of a fatal
 * crash. `neutralize` is a testing seam only -- every real call site relies on the default. Every
 * other pi-tickets file that needs a bare (non-truncating) neutralize -- e.g.
 * issues/issue-detail-view.ts's chip/heading/bullet/link formatting -- imports this instead of
 * malevich-tui-components' own export directly, so this file stays the one place that guards it.
 */
export function guardedNeutralizeEmbeddedFullResets(text: string, neutralize: unknown = neutralizeEmbeddedFullResets): string {
  return typeof neutralize === "function" ? (neutralize as (value: string) => string)(text) : text;
}

/**
 * pi-tui's own truncateToWidth embeds an unconditional full SGR reset (`\x1b[0m`) after any
 * truncated content, even for plain, uncolored text -- fine in isolation, but fatal once an
 * outer component (e.g. Pi's own tool-output Box) paints one background color across the
 * entire line: a full reset embedded mid-line kills that background early, so everything
 * after it renders on the terminal's own default background instead. Delegates to Malevich's own
 * safeTruncateToWidth (the canonical, already-guarded truncate+neutralize composition -- see its
 * own doc comment) instead of re-deriving that pairing here; still guards its own import of
 * safeTruncateToWidth against the same stale-resolution risk described above. Exported so every
 * caller that needs a safe truncateToWidth shares this one definition instead of re-deriving it.
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string {
  if (typeof safeTruncateToWidth !== "function")
    return guardedNeutralizeEmbeddedFullResets(truncateToWidthUnsafe(text, maxWidth, ellipsis, pad));
  return safeTruncateToWidth(truncateToWidthUnsafe, text, maxWidth, ellipsis, pad);
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
