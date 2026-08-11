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
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { firstDistinctStyle, renderBoundedTable, type TextMeasure } from "malevich-tui-components";
import { truncateToWidth, withLeadingLine, withTrailingLine } from "./component-lines.js";
import { omissionLine, type TicketsPresentation } from "./presentation.js";

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** Rows beyond this render as a "... N more" line instead of an ever-taller table, matching
 * the same order-of-magnitude default @danypops/vehicle-client-pi's own generic renderer and
 * several of Lector's list renderers already use. */
const DEFAULT_VISIBLE_ROWS = 20;

type TicketsListPresentation = Extract<TicketsPresentation, { kind: "list" }>;

/** A semantic color TOKEN a Pi theme is expected to define, not a hardcoded ANSI value --
 * theme.fg() resolves it (or falls back to plain text if the active theme doesn't
 * distinguish it), matching every other themed render in this codebase. */
export type StatusToken = "success" | "accent" | "error" | "muted" | "text";

/**
 * Cross-backend status vocabulary -> a semantic token. Deliberately pattern-based rather
 * than an exact-match table: GitHub ("closed"/"open"), GitLab ("opened"/"closed"/"merged"),
 * and Jira (freeform workflow names, e.g. "Done"/"In Review"/"Won't Fix") each spell the
 * same handful of real-world states differently, and this project's own domain `Status`
 * enum (backlog/todo/in_progress/in_review/done/canceled -- see issue/issue.ts) already
 * normalizes most of them, but presentation rows carry whichever string arrived (may be the
 * backend's own rawStatus in a raw legacy row) -- matching by substring covers both.
 */
export function statusToken(status: string | undefined): StatusToken {
  if (!status) return "text";
  const s = status.toLowerCase();
  if (/(done|closed|merged|resolved|complete)/.test(s)) return "success";
  if (/(cancel|reject|block|fail|won'?t)/.test(s)) return "error";
  if (/(progress|review|open|todo|doing|backlog)/.test(s)) return "accent";
  return "text";
}

/**
 * Preference-ordered theme tokens per StatusToken, most specific first -- cascaded through
 * malevich's firstDistinctStyle, mirroring @danypops/vehicle-client-pi's own effectStyle for
 * tool-call effect coloring (same shape, same rationale: not every Pi theme defines every one
 * of these tokens distinctly from plain text, so a status chip styled with only the single most
 * specific token can silently render visually identical to ordinary text on such a theme).
 * "text" itself never cascades -- it already means "no special status semantics", so falling
 * back to something more colorful would misrepresent an unrecognized/absent status as one.
 */
const STATUS_STYLE_CANDIDATES: Record<Exclude<StatusToken, "text">, readonly ThemeColor[]> = {
  success: ["success", "accent"],
  error: ["error", "warning"],
  accent: ["accent", "warning"],
  muted: ["muted", "dim"],
};

/** Absolute last-resort ANSI codes, used only when a theme fails to distinguish even its own success/error/accent/muted tokens from plain text. */
const STATUS_HARDCODED_FALLBACK: Record<Exclude<StatusToken, "text">, string> = {
  success: "\x1b[32m", // green
  error: "\x1b[31m", // red
  accent: "\x1b[36m", // cyan
  muted: "\x1b[90m", // bright black
};

/**
 * Styles `text` per `status`'s classified StatusToken, cascading through theme-completeness
 * fallbacks rather than trusting the single most specific token to always render distinctly.
 * The one status-coloring entry point every renderer in this package should call instead of a
 * bare `theme.fg(statusToken(status), text)`.
 */
export function statusStyle(theme: Theme, status: string | undefined, text: string): string {
  const token = statusToken(status);
  if (token === "text") return theme.fg("text", text);
  const baseline = theme.fg("text", text);
  const candidates = STATUS_STYLE_CANDIDATES[token].map((t) => theme.fg(t, text));
  const fallbackCode = STATUS_HARDCODED_FALLBACK[token];
  return firstDistinctStyle(baseline, candidates, `${fallbackCode}${text}\x1b[39m`);
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
      if (key === "status") return text ? statusStyle(theme, text, text) : text;
      if (key === "ref" || key === "details") return theme.fg("dim", text);
      return theme.fg("text", text);
    },
    measure,
  });

  const titled = withLeadingLine(table, theme.fg("muted", theme.bold(`${list.title} (${list.completeness.total})`)));
  const trailer = omissionLine(list).trim();
  return withTrailingLine(titled, trailer ? theme.fg("dim", trailer) : undefined);
}
