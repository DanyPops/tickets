import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderTicketsBoard } from "../src/board-table.js";
import { TICKETS_PRESENTATION_SCHEMA, type TicketsPresentation } from "../src/presentation.js";

/** Identity theme, matching list-table.test.ts's own fake -- asserts on content, not color codes. */
const fakeTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

type BoardPresentation = Extract<TicketsPresentation, { kind: "board" }>;

function boardPresentation(overrides: Partial<BoardPresentation> = {}): BoardPresentation {
  return {
    schemaVersion: TICKETS_PRESENTATION_SCHEMA,
    operation: "query.run",
    kind: "board",
    variant: "issue",
    title: "Board",
    completeness: { total: 1, returned: 1, omitted: 0 },
    omissions: [],
    rows: [{ ref: "jira:PROJ-1", title: "Wire SSO", status: "todo" }],
    ...overrides,
  };
}

// 120, not 100 -- malevich-tui-components' Board now correctly truncates an oversized column
// header to its own column width (see malevich-tui-components fix in this same initiative,
// doc 4e9e08c1); at width=100 a 5-column PR board's own "CHANGES REQUESTED: N" header no longer
// fits its ~19-char column share, which would silently truncate the very text these tests assert
// on. 120 gives every column enough room for its longest real header, matching this ecosystem's
// own 40/80/120 standard render-width triad rather than an arbitrary narrower number.
function renderText(board: BoardPresentation, width = 120): string {
  return renderTicketsBoard(board, fakeTheme).render(width).join("\n");
}

describe("renderTicketsBoard", () => {
  describe("issue variant", () => {
    it("groups rows into TO DO / IN PROGRESS / REVIEW / DONE columns by status", () => {
      const rows = [
        { ref: "jira:PROJ-1", title: "Backlog item", status: "backlog" },
        { ref: "jira:PROJ-2", title: "Doing item", status: "in_progress" },
        { ref: "jira:PROJ-3", title: "Review item", status: "in_review" },
        { ref: "jira:PROJ-4", title: "Done item", status: "done" },
      ];
      const text = renderText(boardPresentation({ rows }));
      expect(text).toContain("TO DO");
      expect(text).toContain("IN PROGRESS");
      expect(text).toContain("REVIEW");
      expect(text).toContain("DONE");
      expect(text).toContain("Backlog item");
      expect(text).toContain("Doing item");
      expect(text).toContain("Review item");
      expect(text).toContain("Done item");
    });

    it("shows epic badge, labels, story points, and assignee initials on a card", () => {
      const rows = [
        {
          ref: "jira:PROJ-1",
          title: "Wire SSO",
          status: "todo",
          parent: { key: "PROJ-100", label: "Epic: Auth overhaul" },
          labels: ["auth", "security"],
          storyPoints: "5",
          assignee: "Dana Popsuev",
        },
      ];
      const text = renderText(boardPresentation({ rows }));
      expect(text).toContain("Epic: Auth overhaul");
      expect(text).toContain("auth");
      expect(text).toContain("security");
      expect(text).toContain("\u20225"); // •5
      expect(text).toContain("DP");
      expect(text).toContain("jira:PROJ-1");
    });

    it("never renders PR-only fields for an issue-variant board", () => {
      const text = renderText(boardPresentation());
      expect(text).not.toContain("DRAFT");
      expect(text).not.toContain("MERGED");
    });

    it("QoL: wraps the card's own ref in a clickable OSC 8 hyperlink when the row carries a real url", () => {
      const rows = [{ ref: "jira:PROJ-1", title: "Wire SSO", status: "todo", url: "https://issues.example.com/browse/PROJ-1" }];
      const text = renderText(boardPresentation({ rows }));
      expect(text).toContain("\x1b]8;;https://issues.example.com/browse/PROJ-1\x1b\\jira:PROJ-1\x1b]8;;\x1b\\");
    });
  });

  describe("pr variant", () => {
    function prBoard(rows: BoardPresentation["rows"]): BoardPresentation {
      return boardPresentation({ operation: "issue.list", variant: "pr", title: "Pull Requests", rows });
    }

    it("groups rows into DRAFT / OPEN / CHANGES REQUESTED / APPROVED / MERGED columns", () => {
      const rows = [
        { ref: "github:#1", title: "Draft PR", pullRequest: { draft: true } },
        { ref: "github:#2", title: "Open PR", pullRequest: {} },
        { ref: "github:#3", title: "Blocked PR", pullRequest: { reviewers: [{ username: "a", state: "changes_requested" }] } },
        { ref: "github:#4", title: "Ready PR", pullRequest: { reviewers: [{ username: "a", state: "approved" }] } },
        { ref: "github:#5", title: "Landed PR", pullRequest: { merged: true } },
      ];
      const text = renderText(prBoard(rows));
      expect(text).toContain("DRAFT: 1");
      expect(text).toContain("OPEN: 1");
      expect(text).toContain("CHANGES REQUESTED: 1");
      expect(text).toContain("APPROVED: 1");
      expect(text).toContain("MERGED: 1");
      expect(text).toContain("Draft PR");
      expect(text).toContain("Open PR");
      expect(text).toContain("Blocked PR");
      expect(text).toContain("Ready PR");
      expect(text).toContain("Landed PR");
    });

    it("QoL: wraps a PR card's own ref in a clickable OSC 8 hyperlink when the row carries a real url", () => {
      const rows = [{ ref: "github:#42", title: "Add feature", url: "https://github.com/example/repo/pull/42", pullRequest: {} }];
      const text = renderText(prBoard(rows));
      expect(text).toContain("\x1b]8;;https://github.com/example/repo/pull/42\x1b\\github:#42\x1b]8;;\x1b\\");
    });

    it("shows a draft badge, mergeable-state badge, and per-reviewer approve/changes-requested/waiting icons", () => {
      const rows = [
        {
          ref: "github:#1",
          title: "feat: SSO",
          pullRequest: {
            draft: true,
            mergeableState: "conflicting",
            reviewers: [
              { username: "rivka-cohen", state: "approved" },
              { username: "omer-katz", state: "changes_requested" },
            ],
            requestedReviewers: ["dana-popsuev"],
          },
        },
      ];
      const text = renderText(prBoard(rows));
      expect(text).toContain("DRAFT");
      expect(text).toContain("conflicts");
      expect(text).toContain("\u2713 RC"); // approved check + initials
      expect(text).toContain("\u2717 OK"); // changes-requested cross + initials
      expect(text).toContain("\u2026 DP"); // still-waiting ellipsis + initials
    });

    it("never renders issue-only fields (epic/labels/story points) for a PR-variant board", () => {
      const text = renderText(prBoard([{ ref: "github:#1", title: "feat: SSO", pullRequest: { draft: false } }]));
      expect(text).not.toContain("Epic:");
    });
  });

  it("shows a leading title/count line", () => {
    const text = renderText(boardPresentation({ completeness: { total: 7, returned: 1, omitted: 6 } }));
    expect(text.split("\n")[0]).toContain("Board (7)");
  });

  it("appends a trailing omissions/completeness line reusing presentation.ts's own omissionLine", () => {
    const text = renderText(boardPresentation({ completeness: { total: 25, returned: 20, omitted: 5 }, omissions: ["description"] }));
    expect(text).toContain("5 row(s) omitted");
    expect(text).toContain("omitted: description");
  });

  it("shows a plain empty-state message, not an empty board, when there are no rows", () => {
    const text = renderText(boardPresentation({ rows: [], completeness: { total: 0, returned: 0, omitted: 0 } }));
    expect(text.toLowerCase()).toContain("no board");
  });

  it("never renders a line wider than the given width, regardless of card content", () => {
    // A Board's own column-count * minColumnWidth floor (malevich's own contract, unchanged
    // by this renderer -- see board-view.ts's identical KanbanBoardComponent) can legitimately
    // exceed a very narrow width; 150 stays well above that floor for 4 columns so this checks
    // the thing this renderer actually owns -- that oversized card *content* gets truncated to
    // its own column's width, not that Board shrinks narrower than its documented floor.
    const rows = [{ ref: "github:#1", title: "x".repeat(300), status: "todo", labels: ["y".repeat(300)] }];
    const lines = renderTicketsBoard(boardPresentation({ rows }), fakeTheme).render(150);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(150);
  });

  it("never leaves a truncated card's embedded SGR reset able to kill an outer Box's background mid-line", () => {
    const rows = [{ ref: "github:#1", title: "x".repeat(300), status: "todo", labels: ["y".repeat(300)] }];
    const lines = renderTicketsBoard(boardPresentation({ rows }), fakeTheme).render(150);
    for (const line of lines) expect(line).not.toContain("\x1b[0m");
  });
});
