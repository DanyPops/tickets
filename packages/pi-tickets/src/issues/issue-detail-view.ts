/**
 * Full-screen scrollable read view of one issue's fields, description, and
 * comments -- the terminal alternative to opening the ticket in a browser
 * just to read it.
 *
 * Structure researched against Jira Cloud's own issue view (breadcrumb ->
 * title -> status/type/priority/people -> description -> linked issues ->
 * custom fields) and its real wiki-markup description format (confirmed
 * live against jira:CNF-26069/CNF-26457) -- not a generic key:value dump of
 * every backend field at equal visual weight.
 */

import type { Comment, Issue, IssueLink } from "@danypops/tickets";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, hyperlink, matchesKey, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildDetailLines, type DetailField, type DetailSection, formatChip, type TextMeasure } from "malevich-tui-components";
import { guardedNeutralizeEmbeddedFullResets, truncateToWidth } from "../component-lines.js";
import { statusStyle } from "../list-table.js";

/**
 * Same clamped-viewport technique papyrus's own detail views use (a proven
 * MIN/MAX floor+ceiling around terminal.rows minus a reserved-chrome
 * count) -- min avoids an unusably short scroll window on a tiny terminal,
 * max avoids an unwieldy one on a huge terminal. RESERVED_ROWS=10 (was 8;
 * +2 for the breadcrumb and status-summary lines the header gained) covers
 * border/breadcrumb/title/status/border/content/footer/border (7 lines)
 * plus the other 3 for Pi's own outer UI chrome around a pushed overlay.
 */
const DETAIL_MIN_VISIBLE_ROWS = 6;
const DETAIL_MAX_VISIBLE_ROWS = 24;
const DETAIL_RESERVED_ROWS = 10;

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** Jira-internal bookkeeping a human reading the ticket gets nothing from: a sort key, a field
 * redundant with the breadcrumb's own epic segment, and an always-empty JSON placeholder. */
const NOISY_CUSTOM_FIELD_NAMES = new Set(["Rank", "Epic Link", "Development"]);

function isOpaqueCustomFieldValue(value: string): boolean {
  if (value === "{}" || value === "[]") return true;
  // A long, whitespace-free blob (an opaque id/token -- e.g. Atlassian Intelligence's own field)
  // is never something a human reads directly, regardless of which backend produced it.
  if (!/\s/.test(value) && value.length > 40) return true;
  return false;
}

/**
 * Drops Jira-internal bookkeeping and any opaque token-shaped value, while keeping genuinely
 * useful custom fields (Story Points, Sprint, Blocked, Ready, ...) exactly as the backend named
 * them. Exported for direct unit coverage of this one filtering rule in isolation.
 */
export function curatedCustomFields(customFields: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(customFields ?? {}).filter(
    ([name, value]) => !NOISY_CUSTOM_FIELD_NAMES.has(name) && !isOpaqueCustomFieldValue(value),
  );
}

function buildBreadcrumbLine(issue: Issue, theme: Theme): string {
  const parts = [issue.project, issue.parent ? `${issue.parent.key} ${issue.parent.title}` : undefined, issue.key].filter(
    (part): part is string => !!part,
  );
  return theme.fg("dim", parts.join(" / "));
}

/** Status as a semantically colored chip (reusing list-table.ts's own cross-backend status
 * vocabulary) plus type/priority/people -- the fields Jira's own issue view puts directly under
 * the title, not buried in a same-weight field list below the description. */
function buildStatusSummaryLine(issue: Issue, theme: Theme): string {
  const rawStatus = issue.rawStatus ?? issue.status;
  const chip = formatChip(rawStatus ?? "", { style: (s) => statusStyle(theme, rawStatus, s) });
  const rest = [
    issue.issueType,
    issue.priority,
    issue.assignee ? `${issue.assignee} (assignee)` : undefined,
    issue.reporter ? `${issue.reporter} (reporter)` : undefined,
  ]
    .filter((part): part is string => !!part)
    .join(" \u00b7 ");
  return guardedNeutralizeEmbeddedFullResets(rest ? `${chip}  ${theme.fg("muted", rest)}` : chip);
}

const WIKI_HEADING_PATTERN = /^h[1-6]\.\s*(.*)$/i;
const WIKI_BULLET_PATTERN = /^(\s*)[*#]\s+(.*)$/;
const WIKI_LINK_PATTERN = /\[([^\]|]+)\|([^\]]+)\]/g;
const BARE_ISSUE_KEY_PATTERN = /\[([A-Z][A-Z0-9]+-\d+)\]/g;

/** `[text|url]` -> the label styled as a link, or the bare url when the label IS the url (the
 * common "Design doc: [https://.../edit|https://.../edit]" shape); a bare `[PROJ-123]` issue-key
 * reference -> an arrow to the ref. Never wrapped in a further outer color: an inner theme.fg
 * call's own reset would otherwise cut an outer wrap short partway through the line (the exact
 * hazard neutralizeEmbeddedFullResets exists for elsewhere, but that fix targets a wrapping
 * *background*, not a wrapping foreground -- simplest to just never nest foreground colors here). */
function formatInlineWikiMarkup(text: string, theme: Theme): string {
  let result = text.replace(WIKI_LINK_PATTERN, (_match, label: string, url: string) => {
    const shown = label === url ? url : label;
    return `${theme.fg("accent", shown)}${theme.fg("dim", " \u2197")}`;
  });
  result = result.replace(BARE_ISSUE_KEY_PATTERN, (_match, key: string) => `${theme.fg("dim", "\u2192")} ${theme.fg("accent", key)}`);
  return result;
}

/**
 * A light Jira wiki-markup pass for the handful of constructs that show up constantly in real
 * tickets (confirmed live against jira:CNF-26069/CNF-26457) -- "h2. Heading" lines, "* "/"# "
 * bullets, "[text|url]" links, and a bare "[PROJ-123]" issue-key reference -- rendered as
 * something a human reads directly instead of raw markup syntax. Deliberately narrow: every
 * pattern here is specific enough to Jira's own wiki markup (or, for bullets, harmless even for
 * plain Markdown, which uses the same "* " bullet syntax) that it won't misfire on a GitHub/GitLab
 * description, which never uses "h2." headings or pipe-delimited links. Exported for direct unit
 * coverage independent of the rest of this component's own scroll/width-budgeting logic.
 */
export function formatDescriptionLines(description: string, theme: Theme): string[] {
  return description.split("\n").map((rawLine) => {
    if (rawLine.length === 0) return "";
    const headingMatch = rawLine.match(WIKI_HEADING_PATTERN);
    if (headingMatch) return guardedNeutralizeEmbeddedFullResets(theme.fg("accent", theme.bold(headingMatch[1] ?? "")));
    const bulletMatch = rawLine.match(WIKI_BULLET_PATTERN);
    if (bulletMatch)
      return guardedNeutralizeEmbeddedFullResets(`${bulletMatch[1]}\u2022 ${formatInlineWikiMarkup(bulletMatch[2] ?? "", theme)}`);
    return guardedNeutralizeEmbeddedFullResets(formatInlineWikiMarkup(rawLine, theme));
  });
}

/** One "type  KEY  title  [status]" line per linked issue, status-chip formatted through the same
 * shared formatChip/statusStyle pair the header's own status chip uses (see
 * buildStatusSummaryLine), so "closed"/"in progress"/etc. mean the same color and shape
 * everywhere in this package, not a second, independently-invented palette. */
function renderIssueLinkLine(link: IssueLink, theme: Theme): string {
  const chip = link.targetStatus ? formatChip(link.targetStatus, { style: (s) => statusStyle(theme, link.targetStatus, s) }) : "";
  const title = link.targetTitle ? ` ${link.targetTitle}` : "";
  return guardedNeutralizeEmbeddedFullResets(`${link.type}  ${theme.fg("accent", link.targetKey)}${title}  ${chip}`.trimEnd());
}

export class IssueDetailComponent implements Component {
  private offsetY = 0;
  private lines: string[] = [];
  private renderedWidth = 0;
  private readonly breadcrumbLine: string;
  private readonly statusSummaryLine: string;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly issue: Issue,
    private readonly comments: Comment[],
    private readonly close: () => void,
  ) {
    this.breadcrumbLine = buildBreadcrumbLine(issue, theme);
    this.statusSummaryLine = buildStatusSummaryLine(issue, theme);
  }

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
      // A clickable OSC 8 hyperlink (falls back to plain text automatically on a terminal
      // without OSC 8 support) so an end user can actually reach the issue, not just read its URL.
      this.issue.url ? hyperlink(this.issue.url.replace(/^https?:\/\//, ""), this.issue.url) : undefined,
    ]
      .filter(Boolean)
      .join(" \u2022 ");
    return [
      border,
      truncateToWidth(this.breadcrumbLine, width, ""),
      truncateToWidth(theme.fg("accent", theme.bold(`${this.issue.key}  ${this.issue.title}`)), width, ""),
      truncateToWidth(this.statusSummaryLine, width, ""),
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
    return Math.max(DETAIL_MIN_VISIBLE_ROWS, Math.min(DETAIL_MAX_VISIBLE_ROWS, this.tui.terminal.rows - DETAIL_RESERVED_ROWS));
  }

  private buildLines(width: number): void {
    const theme = this.theme;
    const issue = this.issue;
    const field = (label: string, value: string | undefined): DetailField[] => (value ? [{ label, value }] : []);

    // Status/priority/assignee/reporter/type/project/epic moved to the header (breadcrumb +
    // status-summary lines) above -- this list is deliberately just what's left over.
    const fields: DetailField[] = [
      ...field("Resolution", issue.resolution),
      ...field("Labels", issue.labels?.length ? issue.labels.join(", ") : undefined),
      ...field("Fix versions", issue.fixVersions?.length ? issue.fixVersions.join(", ") : undefined),
    ];

    const sections: DetailSection[] = [];
    if (issue.description?.trim()) {
      sections.push({ heading: "Description", lines: formatDescriptionLines(issue.description, theme) });
    }
    if (issue.issueLinks?.length) {
      sections.push({ heading: "Linked issues", lines: issue.issueLinks.map((link) => renderIssueLinkLine(link, theme)) });
    }
    const customFields = curatedCustomFields(issue.customFields);
    if (customFields.length > 0) {
      sections.push({ heading: "Details", lines: customFields.map(([name, value]) => theme.fg("muted", `${name}: ${value}`)) });
    }
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
        // Every `lines`-based section above already carries its own, possibly mixed, coloring
        // (a status chip alongside plain text, an accent-colored link alongside plain text) --
        // a further uniform wrap here would risk exactly the embedded-reset hazard
        // formatInlineWikiMarkup's own doc comment describes, for no benefit.
        line: (s) => s,
      },
    });
    this.offsetY = 0;
  }
}
