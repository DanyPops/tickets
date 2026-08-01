/**
 * Kanban-style, color-coded rendering of a set of issues -- a terminal
 * alternative to a Scrum board's own column layout (TO DO / IN PROGRESS /
 * REVIEW / DONE). Jira assigns each epic a fixed color; this hashes an
 * epic's key onto one of the theme's own syntax-highlight colors instead of
 * hardcoding Jira's palette, so the badge always stays consistent with
 * whatever pi theme the user has chosen.
 *
 * Column layout, header counts, and keyboard-navigable card selection are
 * generic (malevich's Board component); only card content and the
 * terminal-row-aware scroll window are Jira/pi-specific.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { Issue, Status, TicketsRpcClient } from "@danypops/tickets";
import { Board, formatBadgeCount, type BoardColumn, type BoardTheme, type KeyMatcher, type TextMeasure } from "malevich-tui-components";
import { SavedQueryPickerComponent } from "./saved-query-picker.js";

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };
/** malevich's KeyMatcher takes a plain string keyId; pi-tui's matchesKey narrows it to its own closed KeyId union -- Board only ever calls this with the fixed small set ('up'/'down'/'left'/'right'/'enter'/'escape') that's a real KeyId, so the cast is safe. */
const boardKeyMatcher: KeyMatcher = (data, keyId) => matchesKey(data, keyId as KeyId);

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

function boardColumns(issues: Issue[]): BoardColumn<Issue>[] {
  const grouped = groupIssuesByColumn(issues);
  return COLUMN_ORDER.map((name) => ({ name, items: grouped.get(name) ?? [] }));
}

export function renderCard(issue: Issue, theme: Theme, width: number, selected: boolean): string[] {
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

/** Rows reserved for the top/title/border-under-title/footer/bottom-border lines -- render() subtracts this from the terminal's own row count to get the scrollable window height. */
const BOARD_RESERVED_ROWS = 4;

export interface KanbanBoardOptions {
  /** Called when the user presses enter on a selected card; the component awaits this before re-rendering, so a caller can push a detail view and return here on close. */
  onOpenIssue: (issue: Issue) => Promise<void>;
  /** Called when the user presses 'o' on a selected card and it has a URL. */
  onOpenUrl?: (issue: Issue) => void;
  onClose: () => void;
}

/**
 * Interactive, scrollable Kanban board. Wraps malevich's generic Board
 * (column layout, header counts, and up/down/left/right/enter/escape
 * selection) with Jira card rendering and a terminal-row-aware scroll
 * window -- the two things a generic, host-agnostic component can't own.
 */
export class KanbanBoardComponent implements Component {
  private readonly board: Board<Issue>;
  private offsetY = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    issues: Issue[],
    private readonly boardName: string,
    private readonly opts: KanbanBoardOptions,
  ) {
    const boardTheme: BoardTheme = {
      header: (s) => theme.fg("accent", theme.bold(s)),
      border: (s) => theme.fg("borderMuted", s),
      empty: (s) => theme.fg("dim", s),
    };
    this.board = new Board<Issue>({
      columns: boardColumns(issues),
      renderItem: (issue, width, selected) => renderCard(issue, theme, width, selected),
      theme: boardTheme,
      measure,
      matchesKey: boardKeyMatcher,
      onSelect: (issue) => void this.opts.onOpenIssue(issue).then(() => this.tui.requestRender()),
      onClose: () => this.opts.onClose(),
    });
  }

  invalidate(): void {
    this.board.invalidate();
  }

  render(width: number): string[] {
    const lines = this.board.render(width);
    this.scrollSelectionIntoView(lines.length);
    const visibleRows = this.visibleRows();
    const end = Math.min(lines.length, this.offsetY + visibleRows);
    const footer = [
      lines.length > visibleRows ? `\u2191/\u2193 scroll \u2022 ${this.offsetY + 1}-${end}/${lines.length}` : "",
      "\u2190/\u2192/\u2191/\u2193 navigate \u2022 enter open \u2022 o browser \u2022 esc close",
    ].filter(Boolean).join(" \u2022 ");
    const border = this.theme.fg("accent", "\u2500".repeat(Math.max(1, width)));
    return [
      border,
      this.theme.fg("accent", this.theme.bold(`Board: ${this.boardName}`)),
      border,
      ...lines.slice(this.offsetY, end),
      this.theme.fg("dim", footer),
      border,
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "o")) {
      const issue = this.board.getSelectedItem();
      if (issue) this.opts.onOpenUrl?.(issue);
      return;
    }
    this.board.handleInput(data);
    this.tui.requestRender();
  }

  private visibleRows(): number {
    return Math.max(6, this.tui.terminal.rows - BOARD_RESERVED_ROWS);
  }

  private scrollSelectionIntoView(totalLines: number): void {
    const selection = this.board.getSelection();
    const range = this.board.getItemRanges()[selection.column]?.[selection.index];
    if (!range) return;
    const visibleRows = this.visibleRows();
    if (range.start < this.offsetY) this.offsetY = range.start;
    else if (range.end > this.offsetY + visibleRows - 1) this.offsetY = range.end - visibleRows + 1;
    this.offsetY = Math.max(0, Math.min(this.offsetY, Math.max(0, totalLines - visibleRows)));
  }
}

export interface BoardTabOptions {
  backend: string;
  backendDisplayName: string;
  onOpenIssue: (issue: Issue) => Promise<void>;
  onOpenUrl?: (issue: Issue) => void;
}

/**
 * A backend's "Board view" tab: starts on SavedQueryPickerComponent, and
 * once a query is chosen, swaps its own content in place for a live
 * KanbanBoardComponent over that query's results -- KanbanBoardComponent's
 * own escape-closes (onClose) just returns this tab to the picker instead
 * of leaving the tab entirely, mirroring SavedQueryTabComponent's
 * pick/browse split.
 */
export class BoardTabComponent implements Component {
  private readonly picker: SavedQueryPickerComponent;
  private board: KanbanBoardComponent | undefined;
  private loadingBoard = false;
  private lastEmptyQuery: string | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly client: TicketsRpcClient,
    private readonly opts: BoardTabOptions,
  ) {
    this.picker = new SavedQueryPickerComponent(tui, theme, client, opts.backend, opts.backendDisplayName, (name) => void this.loadBoard(name));
  }

  /** While showing the actual board, both escape (KanbanBoardComponent's own onClose, wired below to return to the picker) and left/right (its own column navigation) belong to this tab, not the host's own tab-jump/cycle handling. */
  capturesEscape(): boolean {
    return this.board !== undefined;
  }

  capturesHorizontalArrows(): boolean {
    return this.board !== undefined;
  }

  invalidate(): void {
    this.picker.invalidate();
    this.board?.invalidate();
  }

  private async loadBoard(name: string): Promise<void> {
    this.loadingBoard = true;
    this.lastEmptyQuery = undefined;
    this.lastError = undefined;
    this.tui.requestRender();
    let issues: Issue[];
    try {
      ({ issues } = await this.client.call("query.run", { name, limit: 100 }));
    } catch (err) {
      this.loadingBoard = false;
      this.lastError = `error running query "${name}": ${err instanceof Error ? err.message : String(err)}`;
      this.tui.requestRender();
      return;
    }
    this.loadingBoard = false;
    if (issues.length === 0) {
      this.lastEmptyQuery = name;
      this.tui.requestRender();
      return;
    }
    this.board = new KanbanBoardComponent(this.tui, this.theme, issues, name, {
      onOpenIssue: this.opts.onOpenIssue,
      onOpenUrl: this.opts.onOpenUrl,
      onClose: () => {
        this.board = undefined;
        this.tui.requestRender();
      },
    });
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.board) return this.board.render(width);
    if (this.loadingBoard) return [this.theme.fg("muted", "Loading\u2026")];
    const lines = this.picker.render(width);
    if (this.lastError) lines.push(this.theme.fg("error", this.lastError));
    else if (this.lastEmptyQuery) lines.push(this.theme.fg("warning", `Saved query "${this.lastEmptyQuery}" matched no issues.`));
    return lines;
  }

  handleInput(data: string): void {
    if (this.board) {
      this.board.handleInput(data);
      return;
    }
    if (this.loadingBoard) return;
    this.picker.handleInput(data);
  }
}
