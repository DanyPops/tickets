/**
 * Genuine tabular rendering for a `tickets.tool-details/v1` "list" presentation, replacing
 * a flat "ref: title [status] — metadata" line per row with real aligned columns and
 * semantic status coloring -- the recipe every real-world TUI table library converges on
 * (Rich's `Table`: per-column `style`/`justify`/`header_style`; Charm's `lipgloss-table`:
 * a per-row/column style function keyed by row index; `cli-table3`/pterm: the same shape).
 *
 * Deliberately built from this package's own already-curated `TicketsPresentationRow`
 * (id/label/status/metadata) rather than the raw Issue object -- the exact discipline that
 * keeps this from regressing into a same-weight dump of every backend field (ref, id, key,
 * description, rawStatus, url, createdAt, updatedAt, a raw `pullRequest` JSON blob, ...),
 * which is what a generic array-of-objects table renderer (malevich's own
 * `deriveTableColumns`, used by @danypops/vehicle-client-pi's raw-JSON compatibility
 * fallback) produces when handed a raw Issue[] with no curation at all.
 *
 * malevich-tui-components' installed API (BoundedTable/renderBoundedTable, ^0.25.0)
 * already covers everything this needs -- per-column `align`, `headerStyle`, and
 * `cellStyle` keyed by column `key` (enough for Rich-style semantic column coloring),
 * a Unicode header separator, and Pi's own bounded "N more (expand)" row-count
 * affordance -- so no upstream malevich change was needed for this.
 */
import { neutralizeEmbeddedFullResets } from "@danypops/vehicle-client-pi/vehicle-render";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth as truncateToWidthUnsafe, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderBoundedTable, type TextMeasure } from "malevich-tui-components";
import { withLeadingLine, withTrailingLine } from "./component-lines.js";
import { omissionLine, type TicketsPresentation } from "./presentation.js";

/**
 * pi-tui's own truncateToWidth embeds an unconditional full SGR reset (\x1b[0m) after any
 * truncated content, even for plain, uncolored text -- fine in isolation, but fatal once
 * Pi's own tool-output Box paints one background color across the entire line: a full reset
 * embedded mid-line kills that background early, so everything after it renders on the
 * terminal's own default background instead. See @danypops/vehicle-client-pi's own
 * vehicle-render.ts for the original diagnosis (its generic renderer hit the exact same
 * hazard) -- reusing its fix here rather than re-deriving it.
 */
function truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string {
  return neutralizeEmbeddedFullResets(truncateToWidthUnsafe(text, maxWidth, ellipsis, pad));
}

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** Rows beyond this render as a "... N more" line instead of an ever-taller table, matching
 * the same order-of-magnitude default @danypops/vehicle-client-pi's own generic renderer and
 * several of Lector's list renderers already use. */
const DEFAULT_VISIBLE_ROWS = 20;

type TicketsListPresentation = Extract<TicketsPresentation, { kind: "list" }>;

/** A semantic color TOKEN a Pi theme is expected to define, not a hardcoded ANSI value --
 * theme.fg() resolves it (or falls back to plain text if the active theme doesn't
 * distinguish it), matching every other themed render in this codebase. */
type StatusToken = "success" | "accent" | "error" | "muted" | "text";

/**
 * Cross-backend status vocabulary -> a semantic token. Deliberately pattern-based rather
 * than an exact-match table: GitHub ("closed"/"open"), GitLab ("opened"/"closed"/"merged"),
 * and Jira (freeform workflow names, e.g. "Done"/"In Review"/"Won't Fix") each spell the
 * same handful of real-world states differently, and this project's own domain `Status`
 * enum (backlog/todo/in_progress/in_review/done/canceled -- see issue/issue.ts) already
 * normalizes most of them, but presentation rows carry whichever string arrived (may be the
 * backend's own rawStatus in a raw legacy row) -- matching by substring covers both.
 */
function statusToken(status: string | undefined): StatusToken {
  if (!status) return "text";
  const s = status.toLowerCase();
  if (/(done|closed|merged|resolved|complete)/.test(s)) return "success";
  if (/(cancel|reject|block|fail|won'?t)/.test(s)) return "error";
  if (/(progress|review|open|todo|doing|backlog)/.test(s)) return "accent";
  return "text";
}

function moreRowsLine(theme: Theme, hiddenCount: number): string {
  return theme.fg("dim", `… ${hiddenCount} more row${hiddenCount === 1 ? "" : "s"}`);
}

/**
 * Renders a "list" presentation as a real table: Ref/Title/Status/Details columns, a
 * semantically colored Status column, a leading "Title (total)" line, and a trailing
 * completeness/omissions annotation reusing presentation.ts's own `omissionLine` (never
 * duplicated). Bounded to `DEFAULT_VISIBLE_ROWS`, expandable via Pi's own row-expand
 * affordance -- `expanded` is threaded in from the tool row's own state, not tracked here.
 */
export function renderTicketsListTable(list: TicketsListPresentation, theme: Theme, expanded: boolean): Component {
  if (list.rows.length === 0) return new Text(theme.fg("muted", `No ${list.title.toLowerCase()}`), 0, 0);

  const columns = [
    { header: "Ref", key: "ref" },
    { header: "Title", key: "title" },
    { header: "Status", key: "status" },
    { header: "Details", key: "details" },
  ];
  const rows = list.rows.map((row) => ({
    ref: row.id,
    title: row.label,
    status: row.status ?? "",
    details: row.metadata.join(" \u00b7 "),
  }));

  const table = renderBoundedTable({
    columns,
    rows,
    expanded,
    visibleRowCount: DEFAULT_VISIBLE_ROWS,
    moreLine: (hidden) => moreRowsLine(theme, hidden),
    headerStyle: (s) => theme.fg("muted", theme.bold(s)),
    cellStyle: (text, key) => {
      if (key === "status") return text ? theme.fg(statusToken(text), text) : text;
      if (key === "ref" || key === "details") return theme.fg("dim", text);
      return theme.fg("text", text);
    },
    measure,
  });

  const titled = withLeadingLine(table, theme.fg("muted", theme.bold(`${list.title} (${list.completeness.total})`)));
  const trailer = omissionLine(list).trim();
  return withTrailingLine(titled, trailer ? theme.fg("dim", trailer) : undefined);
}
