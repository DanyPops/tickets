/**
 * Genuine Kanban rendering for a `tickets.tool-details/v1` "board" presentation --
 * the tool-call-output counterpart to board-view.ts's interactive KanbanBoardComponent,
 * but read-only (a one-shot render, no handleInput/onSelect/onClose) and built from this
 * package's own curated `TicketsBoardRow` rather than a raw `Issue`, the same discipline
 * list-table.ts already applies to its own "list" rows.
 *
 * Two genuinely different column axes share one `Board` shell (malevich's own generic,
 * host-agnostic grid layout): `variant: "issue"` groups by the domain Status enum, exactly
 * board-view.ts's own TO DO/IN PROGRESS/REVIEW/DONE (Backlog/Sprint) -- `variant: "pr"`
 * groups by draft/review/merge state instead, since a PR/MR's own lifecycle doesn't fit
 * that axis (see the design discussion this replaced: reusing the Status columns for PRs
 * left everything not-yet-merged piled into one REVIEW column with no draft/mergeable/
 * reviewer signal at all).
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { hyperlink, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Board, type BoardColumn, type BoardTheme, formatChip, type TextMeasure } from "malevich-tui-components";
import { epicBadgeColor } from "./board-view.js";
import { truncateToWidth, withLeadingLine, withTrailingLine } from "./component-lines.js";
import { omissionLine, type TicketsBoardRow, type TicketsPresentation } from "./presentation.js";

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

type TicketsBoardPresentation = Extract<TicketsPresentation, { kind: "board" }>;

/** No avatars in a terminal -- initials stand in for the assignee's/reviewer's face, same as board-view.ts's own. */
function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0]!.slice(0, 2).toUpperCase() : `${parts[0]![0]}${parts.at(-1)![0]}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// "issue" variant -- Status-column board (Backlog/Sprint)
// ---------------------------------------------------------------------------

const ISSUE_COLUMN_ORDER = ["TO DO", "IN PROGRESS", "REVIEW", "DONE"] as const;
type IssueColumnName = (typeof ISSUE_COLUMN_ORDER)[number];

/** Mirrors board-view.ts's own columnFor, against the presentation row's plain-string status rather than the closed Status union -- an already-curated row can only ever carry one of these six values, but a defensive fallback still lands unrecognized/missing status in TO DO instead of silently dropping the card. */
function issueColumnFor(status: string | undefined): IssueColumnName {
  switch (status) {
    case "in_progress":
      return "IN PROGRESS";
    case "in_review":
      return "REVIEW";
    case "done":
    case "canceled":
      return "DONE";
    default:
      return "TO DO";
  }
}

function issueColumns(rows: readonly TicketsBoardRow[]): BoardColumn<TicketsBoardRow>[] {
  const grouped = new Map<IssueColumnName, TicketsBoardRow[]>(ISSUE_COLUMN_ORDER.map((c) => [c, []]));
  for (const row of rows) grouped.get(issueColumnFor(row.status))?.push(row);
  return ISSUE_COLUMN_ORDER.map((name) => ({ name, items: grouped.get(name) ?? [] }));
}

function renderIssueCard(row: TicketsBoardRow, theme: Theme, width: number): string[] {
  const barPrefix = "\u2502 ";
  const titleWidth = Math.max(4, width - barPrefix.length);
  const lines = wrapTextWithAnsi(row.title, titleWidth).map(
    (line) => theme.fg("borderAccent", barPrefix) + truncateToWidth(theme.fg("text", line), titleWidth),
  );

  if (row.parent) lines.push(truncateToWidth(theme.fg(epicBadgeColor(row.parent.key), `  ${row.parent.label}`), width));
  if (row.labels?.length) lines.push(truncateToWidth(theme.fg("muted", `  ${row.labels.map((l) => `\u2039${l}\u203a`).join(" ")}`), width));

  const ref = row.url ? hyperlink(row.ref, row.url) : row.ref;
  const meta = [ref, row.storyPoints ? `\u2022${row.storyPoints}` : undefined, row.assignee ? initials(row.assignee) : undefined]
    .filter(Boolean)
    .join("  ");
  lines.push(theme.fg("dim", `  ${meta}`));
  return lines;
}

// ---------------------------------------------------------------------------
// "pr" variant -- draft/review/merge-state column board
// ---------------------------------------------------------------------------

const PR_COLUMN_ORDER = ["DRAFT", "OPEN", "CHANGES REQUESTED", "APPROVED", "MERGED"] as const;
type PrColumnName = (typeof PR_COLUMN_ORDER)[number];

function prColumnFor(row: TicketsBoardRow): PrColumnName {
  const pr = row.pullRequest;
  if (!pr) return "OPEN";
  if (pr.merged) return "MERGED";
  if (pr.draft) return "DRAFT";
  const states = pr.reviewers?.map((r) => r.state) ?? [];
  if (states.includes("changes_requested")) return "CHANGES REQUESTED";
  if (states.length > 0 && states.every((s) => s === "approved")) return "APPROVED";
  return "OPEN";
}

function prColumns(rows: readonly TicketsBoardRow[]): BoardColumn<TicketsBoardRow>[] {
  const grouped = new Map<PrColumnName, TicketsBoardRow[]>(PR_COLUMN_ORDER.map((c) => [c, []]));
  for (const row of rows) grouped.get(prColumnFor(row))?.push(row);
  return PR_COLUMN_ORDER.map((name) => ({ name, items: grouped.get(name) ?? [] }));
}

const REVIEW_ICON: Record<string, { icon: string; color: ThemeColor }> = {
  approved: { icon: "\u2713", color: "success" },
  changes_requested: { icon: "\u2717", color: "error" },
  commented: { icon: "\u25cf", color: "muted" },
  pending: { icon: "\u2026", color: "muted" },
  unreviewed: { icon: "\u2026", color: "muted" },
};

const MERGEABLE_BADGE: Record<string, { label: string; color: ThemeColor }> = {
  mergeable: { label: "clean", color: "success" },
  conflicting: { label: "conflicts", color: "error" },
  checking: { label: "checking\u2026", color: "muted" },
};

function renderPrCard(row: TicketsBoardRow, theme: Theme, width: number): string[] {
  const pr = row.pullRequest;
  const barPrefix = "\u2502 ";
  const titleWidth = Math.max(4, width - barPrefix.length);
  const lines = wrapTextWithAnsi(row.title, titleWidth).map(
    (line) => theme.fg("borderAccent", barPrefix) + truncateToWidth(theme.fg("text", line), titleWidth),
  );

  const badges: string[] = [];
  if (pr?.draft) badges.push(formatChip("DRAFT", { shape: "plain", style: (s) => theme.fg("warning", s) }));
  const mergeBadge = pr?.mergeableState ? MERGEABLE_BADGE[pr.mergeableState] : undefined;
  if (mergeBadge) badges.push(formatChip(mergeBadge.label, { shape: "plain", style: (s) => theme.fg(mergeBadge.color, s) }));
  if (badges.length) lines.push(truncateToWidth(`  ${badges.join("  ")}`, width));

  const reviewed = pr?.reviewers ?? [];
  const waiting = (pr?.requestedReviewers ?? []).filter((u) => !reviewed.some((r) => r.username === u));
  const reviewerBits = [
    ...reviewed.map((r) => {
      const icon = REVIEW_ICON[r.state ?? "pending"] ?? REVIEW_ICON.pending!;
      return formatChip(initials(r.username), { icon: icon.icon, shape: "plain", style: (s) => theme.fg(icon.color, s) });
    }),
    ...waiting.map((u) => formatChip(initials(u), { icon: "\u2026", shape: "plain", style: (s) => theme.fg("muted", s) })),
  ];
  if (reviewerBits.length) lines.push(truncateToWidth(`  ${reviewerBits.join("  ")}`, width));

  const ref = row.url ? hyperlink(row.ref, row.url) : row.ref;
  const meta = [ref, row.assignee ? `by ${initials(row.assignee)}` : undefined].filter(Boolean).join("  ");
  lines.push(theme.fg("dim", `  ${meta}`));
  return lines;
}

// ---------------------------------------------------------------------------
// Shared render entry point
// ---------------------------------------------------------------------------

/**
 * Renders a "board" presentation as a real Kanban grid: one `Board` (malevich's generic
 * multi-column card layout) with the column axis and card content chosen by `variant`, a
 * leading "Title (total)" line, and a trailing completeness/omissions annotation reusing
 * presentation.ts's own `omissionLine`. No row-count bounding of its own -- the
 * presentation layer already caps at `TICKETS_PRESENTATION_MAX_ITEMS`, and unlike a table's
 * ever-taller row list, an already-columnar board stays readable at that size.
 */
export function renderTicketsBoard(board: TicketsBoardPresentation, theme: Theme): Component {
  if (board.rows.length === 0) return new Text(theme.fg("muted", `No ${board.title.toLowerCase()}`), 0, 0);

  const boardTheme: BoardTheme = {
    header: (s) => theme.fg("accent", theme.bold(s)),
    border: (s) => theme.fg("borderMuted", s),
    empty: (s) => theme.fg("dim", s),
  };
  const isPr = board.variant === "pr";
  const columns = isPr ? prColumns(board.rows) : issueColumns(board.rows);
  const renderItem = (row: TicketsBoardRow, width: number) => (isPr ? renderPrCard(row, theme, width) : renderIssueCard(row, theme, width));

  const inner = new Board<TicketsBoardRow>({ columns, renderItem: (row, width) => renderItem(row, width), theme: boardTheme, measure });
  const component: Component = { render: (width: number) => inner.render(width), invalidate: () => inner.invalidate() };

  const titled = withLeadingLine(component, theme.fg("muted", theme.bold(`${board.title} (${board.completeness.total})`)));
  const trailer = omissionLine(board).trim();
  return withTrailingLine(titled, trailer ? theme.fg("dim", trailer) : undefined);
}
