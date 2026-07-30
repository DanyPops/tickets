/**
 * Kanban-style, color-coded rendering of a set of issues -- a terminal
 * alternative to a Scrum board's own column layout (TO DO / IN PROGRESS /
 * REVIEW / DONE). Jira assigns each epic a fixed color; this hashes an
 * epic's key onto one of the theme's own syntax-highlight colors instead of
 * hardcoding Jira's palette, so the badge always stays consistent with
 * whatever pi theme the user has chosen.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
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

export function groupIssuesByColumn(issues: Issue[]): Map<ColumnName, Issue[]> {
  const columns = new Map<ColumnName, Issue[]>(COLUMN_ORDER.map((c) => [c, []]));
  for (const issue of issues) columns.get(columnFor(issue.status))?.push(issue);
  return columns;
}

/** A card's position within the board: which column, and which index within that column's (unbounded) issue list. */
export interface BoardSelection {
  column: number;
  index: number;
}

export interface RenderedBoard {
  lines: string[];
  /** Every column's issues, in display order -- a BoardSelection indexes into these, so a caller can resolve a selection to a real Issue. */
  columns: Issue[][];
  /** The inclusive row range within `lines` each `columns[c][i]` card occupies -- lets a caller scroll a selected card into view without re-deriving layout. */
  cardRanges: Array<Array<{ start: number; end: number }>>;
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - measure.visibleWidth(text)));
}

/**
 * Renders every column side by side as plain text rows (one string per
 * terminal row) -- the caller owns scrolling/paging if the result is taller
 * than the viewport. No per-column cap: the underlying query's own `limit`
 * already bounds how much data exists; capping again here would just hide
 * cards a caller navigating by selection has no way to reach.
 */
export function renderKanbanBoard(issues: Issue[], theme: Theme, width: number, selection?: BoardSelection): RenderedBoard {
  const grouped = groupIssuesByColumn(issues);
  const columns = COLUMN_ORDER.map((name) => grouped.get(name) ?? []);
  const gap = 1;
  const columnWidth = Math.max(14, Math.floor((width - gap * (COLUMN_ORDER.length - 1)) / COLUMN_ORDER.length));

  const rendered = COLUMN_ORDER.map((name, c) =>
    renderColumn(name, columns[c]!, theme, columnWidth, selection?.column === c ? selection.index : -1),
  );
  const height = Math.max(...rendered.map((r) => r.lines.length));
  const lines: string[] = [];
  for (let row = 0; row < height; row++) {
    lines.push(rendered.map((r) => padToWidth(r.lines[row] ?? "", columnWidth)).join(" ".repeat(gap)));
  }
  return { lines, columns, cardRanges: rendered.map((r) => r.cardRanges) };
}

function renderColumn(
  name: ColumnName,
  issues: Issue[],
  theme: Theme,
  width: number,
  selectedIndex: number,
): { lines: string[]; cardRanges: Array<{ start: number; end: number }> } {
  const header = new Badge({ label: name, style: (s) => theme.fg("accent", theme.bold(s)) });
  header.setValue(issues.length);
  const lines: string[] = [...header.render(width), theme.fg("borderMuted", "─".repeat(width))];
  const cardRanges: Array<{ start: number; end: number }> = [];

  if (issues.length === 0) {
    lines.push(theme.fg("dim", "  (empty)"));
  }
  issues.forEach((issue, i) => {
    const start = lines.length;
    lines.push(...renderCard(issue, theme, width, i === selectedIndex));
    cardRanges.push({ start, end: lines.length - 1 });
    lines.push("");
  });

  return { lines, cardRanges };
}

function renderCard(issue: Issue, theme: Theme, width: number, selected: boolean): string[] {
  const barPrefix = selected ? "\u2503 " : "\u2502 ";
  const barColor: ThemeColor = selected ? "accent" : "borderAccent";
  const titleWidth = Math.max(4, width - barPrefix.length);
  const lines = measure.wrapTextWithAnsi!(issue.title, titleWidth).map(
    (line) => theme.fg(barColor, barPrefix) + measure.truncateToWidth(theme.fg("text", selected ? theme.bold(line) : line), titleWidth, ""),
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

/** Rows reserved for the title line and the footer -- render() subtracts this from the terminal's own row count to get the scrollable window height. */
const BOARD_RESERVED_ROWS = 2;

export interface KanbanBoardOptions {
  /** Called when the user presses enter on a selected card; the component awaits this before re-rendering, so a caller can push a detail view and return here on close. */
  onOpenIssue: (issue: Issue) => Promise<void>;
  /** Called when the user presses 'o' on a selected card and it has a URL. */
  onOpenUrl?: (issue: Issue) => void;
  onClose: () => void;
}

/**
 * Interactive, scrollable Kanban board: arrow keys move a highlighted
 * selection between cards (up/down within a column, left/right across
 * columns, skipping empty ones), enter opens the selected card, escape
 * closes the board.
 */
export class KanbanBoardComponent implements Component {
  private selection: BoardSelection;
  private offsetY = 0;
  private rendered: RenderedBoard | undefined;
  private renderedKey = "";

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly issues: Issue[],
    private readonly boardName: string,
    private readonly opts: KanbanBoardOptions,
  ) {
    const grouped = groupIssuesByColumn(issues);
    const columns = COLUMN_ORDER.map((name) => grouped.get(name) ?? []);
    const firstNonEmpty = columns.findIndex((c) => c.length > 0);
    this.selection = { column: Math.max(0, firstNonEmpty), index: 0 };
  }

  invalidate(): void {
    this.renderedKey = "";
  }

  render(width: number): string[] {
    const key = `${width}:${this.selection.column}:${this.selection.index}`;
    if (this.renderedKey !== key) {
      this.renderedKey = key;
      this.rendered = renderKanbanBoard(this.issues, this.theme, width, this.selection);
      this.scrollSelectionIntoView();
    }
    const board = this.rendered!;
    const visibleRows = this.visibleRows();
    const end = Math.min(board.lines.length, this.offsetY + visibleRows);
    const footer = [
      board.lines.length > visibleRows ? `\u2191/\u2193 scroll \u2022 ${this.offsetY + 1}-${end}/${board.lines.length}` : "",
      "\u2190/\u2192/\u2191/\u2193 navigate \u2022 enter open \u2022 o browser \u2022 esc close",
    ].filter(Boolean).join(" \u2022 ");
    return [
      this.theme.fg("accent", this.theme.bold(`Board: ${this.boardName}`)),
      ...board.lines.slice(this.offsetY, end),
      this.theme.fg("dim", footer),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, "enter")) {
      const issue = this.currentIssue();
      if (issue) void this.opts.onOpenIssue(issue).then(() => this.tui.requestRender());
      return;
    }
    if (matchesKey(data, "o")) {
      const issue = this.currentIssue();
      if (issue) this.opts.onOpenUrl?.(issue);
      return;
    }
    if (matchesKey(data, "up")) this.moveVertical(-1);
    else if (matchesKey(data, "down")) this.moveVertical(1);
    else if (matchesKey(data, "left")) this.moveHorizontal(-1);
    else if (matchesKey(data, "right")) this.moveHorizontal(1);
    else return;
    this.tui.requestRender();
  }

  private currentIssue(): Issue | undefined {
    return this.rendered?.columns[this.selection.column]?.[this.selection.index];
  }

  private moveVertical(delta: number): void {
    const column = this.rendered?.columns[this.selection.column] ?? [];
    if (column.length === 0) return;
    this.selection = { ...this.selection, index: Math.max(0, Math.min(column.length - 1, this.selection.index + delta)) };
  }

  /** Skips past empty columns in the direction of travel; stops at the edge instead of wrapping around. */
  private moveHorizontal(delta: number): void {
    const columns = this.rendered?.columns ?? [];
    let next = this.selection.column;
    for (let i = 0; i < columns.length; i++) {
      next += delta;
      if (next < 0 || next >= columns.length) return;
      const target = columns[next];
      if (target && target.length > 0) {
        this.selection = { column: next, index: Math.min(this.selection.index, target.length - 1) };
        return;
      }
    }
  }

  private visibleRows(): number {
    return Math.max(6, this.tui.terminal.rows - BOARD_RESERVED_ROWS);
  }

  private scrollSelectionIntoView(): void {
    const board = this.rendered;
    if (!board) return;
    const range = board.cardRanges[this.selection.column]?.[this.selection.index];
    if (!range) return;
    const visibleRows = this.visibleRows();
    if (range.start < this.offsetY) this.offsetY = range.start;
    else if (range.end > this.offsetY + visibleRows - 1) this.offsetY = range.end - visibleRows + 1;
    this.offsetY = Math.max(0, Math.min(this.offsetY, Math.max(0, board.lines.length - visibleRows)));
  }
}
