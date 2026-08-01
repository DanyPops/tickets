/**
 * Full-screen scrollable read view of one issue's fields, description, and
 * comments -- the terminal alternative to opening the ticket in a browser
 * just to read it.
 */

import type { Comment, Issue } from "@danypops/tickets";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildDetailLines, type DetailField, type DetailSection, type TextMeasure } from "malevich-tui-components";

const DETAIL_RESERVED_ROWS = 4;

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

export class IssueDetailComponent implements Component {
  private offsetY = 0;
  private lines: string[] = [];
  private renderedWidth = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly issue: Issue,
    private readonly comments: Comment[],
    private readonly close: () => void,
  ) {}

  invalidate(): void {
    this.renderedWidth = 0;
  }

  render(width: number): string[] {
    if (this.renderedWidth !== width) {
      this.renderedWidth = width;
      this.buildLines(Math.max(1, width - 2));
    }
    const theme = this.theme;
    const visibleRows = this.visibleRows();
    this.offsetY = Math.min(this.offsetY, Math.max(0, this.lines.length - visibleRows));
    const end = Math.min(this.lines.length, this.offsetY + visibleRows);
    const border = theme.fg("accent", "\u2500".repeat(Math.max(1, width)));
    const footer = [
      "\u2191/\u2193 scroll",
      "pgup/pgdn page",
      this.lines.length > visibleRows ? `${this.offsetY + 1}-${end}/${this.lines.length}` : undefined,
      "esc back",
    ]
      .filter(Boolean)
      .join(" \u2022 ");
    return [
      border,
      truncateToWidth(theme.fg("accent", theme.bold(`${this.issue.key}  ${this.issue.title}`)), width, ""),
      border,
      ...this.lines.slice(this.offsetY, end).map((line) => truncateToWidth(` ${line}`, width, "")),
      truncateToWidth(theme.fg("dim", footer), width, ""),
      border,
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.close();
      return;
    }
    const visibleRows = this.visibleRows();
    const maxOffset = Math.max(0, this.lines.length - visibleRows);
    if (matchesKey(data, "up")) this.offsetY = Math.max(0, this.offsetY - 1);
    else if (matchesKey(data, "down")) this.offsetY = Math.min(maxOffset, this.offsetY + 1);
    else if (matchesKey(data, "pageUp")) this.offsetY = Math.max(0, this.offsetY - visibleRows);
    else if (matchesKey(data, "pageDown")) this.offsetY = Math.min(maxOffset, this.offsetY + visibleRows);
    else return;
    this.tui.requestRender();
  }

  private visibleRows(): number {
    return Math.max(6, this.tui.terminal.rows - DETAIL_RESERVED_ROWS);
  }

  private buildLines(width: number): void {
    const theme = this.theme;
    const issue = this.issue;
    const field = (label: string, value: string | undefined): DetailField[] => (value ? [{ label, value }] : []);

    const fields: DetailField[] = [
      ...field("Status", issue.rawStatus ?? issue.status),
      ...field("Priority", issue.priority),
      ...field("Assignee", issue.assignee),
      ...field("Reporter", issue.reporter),
      ...field("Project", issue.project),
      ...field("Type", issue.issueType),
      ...field("Resolution", issue.resolution),
      ...field("Epic", issue.parent ? `${issue.parent.key} ${issue.parent.title}` : undefined),
      ...field("Labels", issue.labels?.length ? issue.labels.join(", ") : undefined),
      ...field("Fix versions", issue.fixVersions?.length ? issue.fixVersions.join(", ") : undefined),
      ...Object.entries(issue.customFields ?? {}).flatMap(([name, value]) => field(name, value)),
      ...field("URL", issue.url),
    ];

    const sections: DetailSection[] = [];
    if (issue.description?.trim()) sections.push({ heading: "Description:", body: issue.description });
    if (this.comments.length > 0) {
      sections.push({
        heading: `Comments (${this.comments.length}):`,
        items: this.comments.map((comment) => ({
          byline: `${comment.author ?? "unknown"} \u00b7 ${comment.createdAt ?? ""}`,
          body: comment.body,
        })),
      });
    }

    this.lines = buildDetailLines(width, {
      fields,
      sections,
      measure,
      theme: {
        field: (s) => theme.fg("muted", s),
        heading: (s) => theme.fg("muted", s),
        byline: (s) => theme.fg("dim", s),
        body: (s) => theme.fg("text", s),
      },
    });
    this.offsetY = 0;
  }
}
