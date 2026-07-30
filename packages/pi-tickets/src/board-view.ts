/**
 * Kanban-style, color-coded rendering of a set of issues -- a terminal
 * alternative to a Scrum board's own column layout (TO DO / IN PROGRESS /
 * REVIEW / DONE). Jira assigns each epic a fixed color; this hashes an
 * epic's key onto one of the theme's own syntax-highlight colors instead of
 * hardcoding Jira's palette, so the badge always stays consistent with
 * whatever pi theme the user has chosen.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Issue, Status } from "@danypops/tickets";
import { Badge, formatBadgeCount, type TextMeasure } from "malevich-tui-components";

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

const COLUMN_ORDER = ["TO DO", "IN PROGRESS", "REVIEW", "DONE"] as const;
type ColumnName = (typeof COLUMN_ORDER)[number];

function columnFor(status: Status): ColumnName {
  switch (status) {
    case "backlog":
    case "todo":
      return "TO DO";
    case "in_progress":
      return "IN PROGRESS";
    case "in_review":
      return "REVIEW";
    case "done":
    case "canceled":
      return "DONE";
  }
}

/**
 * Distinct, non-alarm theme colors only -- "error"/"warning" carry a real
 * semantic meaning elsewhere in the TUI (something is actually wrong), which
 * an epic badge picked by hash must never accidentally imply.
 */
const EPIC_BADGE_COLORS: readonly ThemeColor[] = [
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxType",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxOperator",
  "accent",
];

/** Same epic key always maps to the same color within (and across) a render. */
export function epicBadgeColor(epicKey: string): ThemeColor {
  let hash = 0;
  for (let i = 0; i < epicKey.length; i++) hash = (hash * 31 + epicKey.charCodeAt(i)) >>> 0;
  return EPIC_BADGE_COLORS[hash % EPIC_BADGE_COLORS.length]!;
}

/** Bounded per column -- an "+N more" footer covers the rest instead of an unbounded render. */
export const MAX_CARDS_PER_COLUMN = 8;

export function groupIssuesByColumn(issues: Issue[]): Map<ColumnName, Issue[]> {
  const columns = new Map<ColumnName, Issue[]>(COLUMN_ORDER.map((c) => [c, []]));
  for (const issue of issues) columns.get(columnFor(issue.status))?.push(issue);
  return columns;
}

/** Renders every column side by side as plain text rows (one string per terminal row) -- the caller owns scrolling/paging if the result is taller than the viewport. */
export function renderKanbanBoard(issues: Issue[], theme: Theme, totalWidth: number): string[] {
  const columns = groupIssuesByColumn(issues);
  const gap = 1;
  const columnWidth = Math.max(14, Math.floor((totalWidth - gap * (COLUMN_ORDER.length - 1)) / COLUMN_ORDER.length));

  const columnLines = COLUMN_ORDER.map((name) => renderColumn(name, columns.get(name) ?? [], theme, columnWidth));
  const height = Math.max(...columnLines.map((lines) => lines.length));
  const rows: string[] = [];
  for (let row = 0; row < height; row++) {
    rows.push(columnLines.map((lines) => padToWidth(lines[row] ?? "", columnWidth)).join(" ".repeat(gap)));
  }
  return rows;
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - measure.visibleWidth(text)));
}

function renderColumn(name: ColumnName, issues: Issue[], theme: Theme, width: number): string[] {
  const header = new Badge({ label: name, style: (s) => theme.fg("accent", theme.bold(s)) });
  header.setValue(issues.length);
  const lines: string[] = [...header.render(width), theme.fg("borderMuted", "─".repeat(width))];
  const shown = issues.slice(0, MAX_CARDS_PER_COLUMN);
  for (const issue of shown) {
    lines.push(...renderCard(issue, theme, width));
    lines.push("");
  }
  if (issues.length > shown.length) lines.push(theme.fg("dim", `+${issues.length - shown.length} more`));
  return lines;
}

function renderCard(issue: Issue, theme: Theme, width: number): string[] {
  const barPrefix = "│ ";
  const titleWidth = Math.max(4, width - barPrefix.length);
  const lines = measure.wrapTextWithAnsi!(issue.title, titleWidth).map(
    (line) => theme.fg("borderAccent", barPrefix) + measure.truncateToWidth(theme.fg("text", line), titleWidth, ""),
  );

  if (issue.parent) {
    lines.push(measure.truncateToWidth(theme.fg(epicBadgeColor(issue.parent.key), `  ${issue.parent.title}`), width, ""));
  }
  if (issue.labels?.length) {
    lines.push(measure.truncateToWidth(theme.fg("muted", `  ${issue.labels.map((l) => `\u2039${l}\u203a`).join(" ")}`), width, ""));
  }

  const points = Number(issue.customFields?.["Story Points"]);
  const meta = [issue.key, Number.isFinite(points) && points > 0 ? `\u2022${formatBadgeCount(points)}` : undefined, issue.assignee ? initials(issue.assignee) : undefined].filter(Boolean).join("  ");
  lines.push(theme.fg("dim", `  ${meta}`));

  return lines;
}

/** No avatars in a terminal -- initials stand in for the assignee's face, same information at a glance. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length === 1 ? parts[0]!.slice(0, 2).toUpperCase() : `${parts[0]![0]}${parts.at(-1)![0]}`.toUpperCase();
}
