import { describe, expect, it, mock } from "bun:test";
import type { Issue } from "@danypops/tickets";
import { epicBadgeColor, groupIssuesByColumn, KanbanBoardComponent, renderKanbanBoard } from "../src/board-view.js";

/**
 * Real ANSI SGR codes (not bracket tags) so visibleWidth/truncateToWidth --
 * which strip real escape sequences, not arbitrary markup -- measure this
 * the same way they measure genuine themed output. Which specific color was
 * requested is covered separately by the direct epicBadgeColor tests below,
 * not by parsing it back out of rendered text here.
 */
const fakeTheme = {
  fg: (_color: string, text: string) => `\x1b[38;5;1m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as import("@earendil-works/pi-coding-agent").Theme;

function fakeTui(rows = 40) {
  return { terminal: { rows }, requestRender: mock(() => {}) } as unknown as import("@earendil-works/pi-tui").TUI;
}

function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real terminal escape sequences is the point
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function issue(overrides: Partial<Issue> & Pick<Issue, "ref" | "key" | "title" | "status">): Issue {
  return { id: overrides.key, priority: "none", ...overrides };
}

describe("groupIssuesByColumn", () => {
  it("maps backlog and todo onto TO DO, in_review onto REVIEW, done and canceled onto DONE", () => {
    const issues = [
      issue({ ref: "a:1", key: "1", title: "a", status: "backlog" }),
      issue({ ref: "a:2", key: "2", title: "b", status: "todo" }),
      issue({ ref: "a:3", key: "3", title: "c", status: "in_progress" }),
      issue({ ref: "a:4", key: "4", title: "d", status: "in_review" }),
      issue({ ref: "a:5", key: "5", title: "e", status: "done" }),
      issue({ ref: "a:6", key: "6", title: "f", status: "canceled" }),
    ];
    const columns = groupIssuesByColumn(issues);
    expect(columns.get("TO DO")?.map((i) => i.key)).toEqual(["1", "2"]);
    expect(columns.get("IN PROGRESS")?.map((i) => i.key)).toEqual(["3"]);
    expect(columns.get("REVIEW")?.map((i) => i.key)).toEqual(["4"]);
    expect(columns.get("DONE")?.map((i) => i.key)).toEqual(["5", "6"]);
  });

  it("every column exists even when empty, never undefined", () => {
    const columns = groupIssuesByColumn([]);
    expect(columns.get("TO DO")).toEqual([]);
    expect(columns.get("IN PROGRESS")).toEqual([]);
    expect(columns.get("REVIEW")).toEqual([]);
    expect(columns.get("DONE")).toEqual([]);
  });
});

describe("epicBadgeColor", () => {
  it("is deterministic -- the same epic key always maps to the same color", () => {
    const first = epicBadgeColor("CNF-22136");
    const second = epicBadgeColor("CNF-22136");
    expect(first).toBe(second);
  });

  it("gives different epic keys a real chance at different colors", () => {
    const colors = new Set(["CNF-1", "CNF-2", "CNF-3", "CNF-4", "CNF-5", "CNF-6"].map(epicBadgeColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  it("never returns an alarm color (error/warning) that would misread as \"something is wrong\"", () => {
    for (const key of ["a", "bb", "ccc", "dddd", "eeeee", "CNF-1", "CNF-99999"]) {
      expect(["error", "warning"]).not.toContain(epicBadgeColor(key));
    }
  });
});

describe("renderKanbanBoard", () => {
  const issues: Issue[] = [
    issue({ ref: "a:1", key: "CNF-1", title: "First card", status: "todo", parent: { key: "CNF-100", title: "Epic One" }, labels: ["red-team"], customFields: { "Story Points": "3" }, assignee: "Jane Doe" }),
    issue({ ref: "a:2", key: "CNF-2", title: "Second card", status: "in_progress" }),
  ];

  it("renders all four column headers with their own counts", () => {
    const rows = renderKanbanBoard(issues, fakeTheme, 120).lines.join("\n");
    expect(rows).toContain("TO DO: 1");
    expect(rows).toContain("IN PROGRESS: 1");
    expect(rows).toContain("REVIEW: 0");
    expect(rows).toContain("DONE: 0");
  });

  it("includes the card's key, epic title, labels, story points, and assignee initials", () => {
    const rows = renderKanbanBoard(issues, fakeTheme, 120).lines.join("\n");
    expect(rows).toContain("First card");
    expect(rows).toContain("Epic One");
    expect(rows).toContain("\u2039red-team\u203a");
    expect(rows).toContain("CNF-1");
    expect(rows).toContain("\u20223");
    expect(rows).toContain("JD");
  });

  it("does not cap cards per column -- every issue is rendered so selection can reach any of them", () => {
    const many = Array.from({ length: 20 }, (_, i) => issue({ ref: `a:${i}`, key: `CNF-${i}`, title: `card ${i}`, status: "todo" }));
    const board = renderKanbanBoard(many, fakeTheme, 120);
    expect(board.columns[0]).toHaveLength(20);
    expect(board.lines.join("\n")).toContain("card 19");
  });

  it("every rendered row is padded to the same total width, so columns stay aligned", () => {
    const rows = renderKanbanBoard(issues, fakeTheme, 100).lines;
    const widths = new Set(rows.map((row) => stripAnsi(row).length));
    expect(widths.size).toBe(1);
  });

  it("returns a cardRanges row range for every rendered card, in column/index order matching `columns`", () => {
    const board = renderKanbanBoard(issues, fakeTheme, 120);
    expect(board.cardRanges[0]).toHaveLength(1); // TO DO has CNF-1
    expect(board.cardRanges[1]).toHaveLength(1); // IN PROGRESS has CNF-2
    const range = board.cardRanges[0]![0]!;
    expect(range.end).toBeGreaterThanOrEqual(range.start);
    expect(board.lines[range.start]).toContain("First card");
  });
});

describe("KanbanBoardComponent", () => {
  const issues: Issue[] = [
    issue({ ref: "a:1", key: "CNF-1", title: "Todo one", status: "todo" }),
    issue({ ref: "a:2", key: "CNF-2", title: "Todo two", status: "todo" }),
    issue({ ref: "a:3", key: "CNF-3", title: "In progress one", status: "in_progress" }),
  ];

  it("selects the first non-empty column on construction and highlights that card", () => {
    const tui = fakeTui();
    const board = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", { onOpenIssue: async () => {}, onClose: () => {} });
    const rendered = board.render(120).join("\n");
    expect(rendered).toContain("Todo one");
    expect(rendered).toContain("Board: sprint");
  });

  it("down moves selection within a column; enter opens the newly selected issue", async () => {
    const tui = fakeTui();
    const opened: Issue[] = [];
    const board = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", {
      onOpenIssue: async (issue) => { opened.push(issue); },
      onClose: () => {},
    });
    board.render(120);
    board.handleInput("\x1b[B"); // down
    board.render(120);
    board.handleInput("\r"); // enter
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened.map((i) => i.key)).toEqual(["CNF-2"]);
  });

  it("right moves selection to the next non-empty column, clamping the index", () => {
    const tui = fakeTui();
    const board = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", { onOpenIssue: async () => {}, onClose: () => {} });
    board.render(120);
    board.handleInput("\x1b[B"); // down -> CNF-2 (index 1 in TO DO)
    board.handleInput("\x1b[C"); // right -> IN PROGRESS, only has index 0
    board.handleInput("\r");
    const opened: string[] = [];
    // re-run with an onOpenIssue spy since the earlier board discarded it
    const board2 = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", {
      onOpenIssue: async (issue) => { opened.push(issue.key); },
      onClose: () => {},
    });
    board2.render(120);
    board2.handleInput("\x1b[B");
    board2.handleInput("\x1b[C");
    board2.handleInput("\r");
    expect(opened).toEqual(["CNF-3"]);
  });

  it("left/right does not move past the edge columns", () => {
    const tui = fakeTui();
    const opened: string[] = [];
    const board = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", {
      onOpenIssue: async (issue) => { opened.push(issue.key); },
      onClose: () => {},
    });
    board.render(120);
    board.handleInput("\x1b[D"); // left from TO DO -- already the first column, no-op
    board.handleInput("\r");
    expect(opened).toEqual(["CNF-1"]);
  });

  it("escape calls onClose", () => {
    const tui = fakeTui();
    let closed = false;
    const board = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", { onOpenIssue: async () => {}, onClose: () => { closed = true; } });
    board.render(120);
    board.handleInput("\x1b");
    expect(closed).toBe(true);
  });

  it("'o' opens the selected issue's URL via onOpenUrl", () => {
    const tui = fakeTui();
    const withUrl = [{ ...issues[0]!, url: "https://example.invalid/CNF-1" }];
    const opened: string[] = [];
    const board = new KanbanBoardComponent(tui, fakeTheme, withUrl, "sprint", {
      onOpenIssue: async () => {},
      onOpenUrl: (issue) => { opened.push(issue.url!); },
      onClose: () => {},
    });
    board.render(120);
    board.handleInput("o");
    expect(opened).toEqual(["https://example.invalid/CNF-1"]);
  });
});
