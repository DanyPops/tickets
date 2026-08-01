import { describe, expect, it, mock } from "bun:test";
import type { Issue } from "@danypops/tickets";
import { epicBadgeColor, groupIssuesByColumn, KanbanBoardComponent, renderCard } from "../src/board-view.js";

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
    const first = epicBadgeColor("ENG-22136");
    const second = epicBadgeColor("ENG-22136");
    expect(first).toBe(second);
  });

  it("gives different epic keys a real chance at different colors", () => {
    const colors = new Set(["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5", "ENG-6"].map(epicBadgeColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  it('never returns an alarm color (error/warning) that would misread as "something is wrong"', () => {
    for (const key of ["a", "bb", "ccc", "dddd", "eeeee", "ENG-1", "ENG-99999"]) {
      expect(["error", "warning"]).not.toContain(epicBadgeColor(key));
    }
  });
});

describe("renderCard", () => {
  it("includes the card's title, epic title, labels, story points, key, and assignee initials", () => {
    const card = issue({
      ref: "a:1",
      key: "ENG-1",
      title: "First card",
      status: "todo",
      parent: { key: "ENG-100", title: "Epic One" },
      labels: ["red-team"],
      customFields: { "Story Points": "3" },
      assignee: "Jane Doe",
    });
    const rendered = renderCard(card, fakeTheme, 60, false).join("\n");
    expect(rendered).toContain("First card");
    expect(rendered).toContain("Epic One");
    expect(rendered).toContain("\u2039red-team\u203a");
    expect(rendered).toContain("ENG-1");
    expect(rendered).toContain("\u20223");
    expect(rendered).toContain("JD");
  });

  it("uses a distinct bar glyph/color when selected", () => {
    const card = issue({ ref: "a:1", key: "ENG-1", title: "Card", status: "todo" });
    const normal = stripAnsi(renderCard(card, fakeTheme, 60, false)[0]!);
    const selected = stripAnsi(renderCard(card, fakeTheme, 60, true)[0]!);
    expect(normal.startsWith("\u2502")).toBe(true);
    expect(selected.startsWith("\u2503")).toBe(true);
  });
});

describe("KanbanBoardComponent", () => {
  const issues: Issue[] = [
    issue({ ref: "a:1", key: "ENG-1", title: "Todo one", status: "todo" }),
    issue({ ref: "a:2", key: "ENG-2", title: "Todo two", status: "todo" }),
    issue({ ref: "a:3", key: "ENG-3", title: "In progress one", status: "in_progress" }),
  ];

  it("frames the board with a full-width border rule top and bottom, so it reads as a distinct overlay", () => {
    const tui = fakeTui();
    const board = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", { onOpenIssue: async () => {}, onClose: () => {} });
    const lines = board.render(80).map(stripAnsi);
    expect(lines[0]).toBe("\u2500".repeat(80));
    expect(lines.at(-1)).toBe("\u2500".repeat(80));
  });

  it("never renders more lines than the terminal has, even with many more cards than fit -- the closing border always stays on screen", () => {
    // The real regression this test exists for (screenshot-reported): with
    // enough cards to overflow, the footer/closing border silently ran past
    // the terminal's own row count instead of showing at all, because
    // visibleRows() didn't reserve nearly enough rows for the chrome this
    // component actually sits inside (the persistent panel's own Envelope,
    // its outer provider tab bar, and the raw-query backend's own submenu
    // tab bar -- see BOARD_RESERVED_ROWS's own comment in board-view.ts).
    const many: Issue[] = Array.from({ length: 40 }, (_, i) =>
      issue({ ref: `a:${i}`, key: `ENG-${i}`, title: `Card ${i}`, status: "todo" }),
    );
    // Below the visible-rows MAX cap, so this genuinely exercises
    // BOARD_RESERVED_ROWS rather than being masked by the ceiling.
    const tui = fakeTui(20);
    const board = new KanbanBoardComponent(tui, fakeTheme, many, "sprint", { onOpenIssue: async () => {}, onClose: () => {} });

    const lines = board.render(80).map(stripAnsi);

    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.at(-1)).toBe("\u2500".repeat(80)); // the closing border, genuinely the last line
  });

  it("caps the visible window on a very tall terminal instead of growing without bound", () => {
    const many: Issue[] = Array.from({ length: 60 }, (_, i) =>
      issue({ ref: `a:${i}`, key: `ENG-${i}`, title: `Card ${i}`, status: "todo" }),
    );
    const tui = fakeTui(200);
    const board = new KanbanBoardComponent(tui, fakeTheme, many, "sprint", { onOpenIssue: async () => {}, onClose: () => {} });

    const lines = board.render(80).map(stripAnsi);

    expect(lines.length).toBeLessThan(200);
    expect(lines.at(-1)).toBe("\u2500".repeat(80));
  });

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
      onOpenIssue: async (issue) => {
        opened.push(issue);
      },
      onClose: () => {},
    });
    board.render(120);
    board.handleInput("\x1b[B"); // down
    board.render(120);
    board.handleInput("\r"); // enter
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened.map((i) => i.key)).toEqual(["ENG-2"]);
  });

  it("right moves selection to the next non-empty column, clamping the index", () => {
    const tui = fakeTui();
    const board = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", { onOpenIssue: async () => {}, onClose: () => {} });
    board.render(120);
    board.handleInput("\x1b[B"); // down -> ENG-2 (index 1 in TO DO)
    board.handleInput("\x1b[C"); // right -> IN PROGRESS, only has index 0
    board.handleInput("\r");
    const opened: string[] = [];
    // re-run with an onOpenIssue spy since the earlier board discarded it
    const board2 = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", {
      onOpenIssue: async (issue) => {
        opened.push(issue.key);
      },
      onClose: () => {},
    });
    board2.render(120);
    board2.handleInput("\x1b[B");
    board2.handleInput("\x1b[C");
    board2.handleInput("\r");
    expect(opened).toEqual(["ENG-3"]);
  });

  it("left/right does not move past the edge columns", () => {
    const tui = fakeTui();
    const opened: string[] = [];
    const board = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", {
      onOpenIssue: async (issue) => {
        opened.push(issue.key);
      },
      onClose: () => {},
    });
    board.render(120);
    board.handleInput("\x1b[D"); // left from TO DO -- already the first column, no-op
    board.handleInput("\r");
    expect(opened).toEqual(["ENG-1"]);
  });

  it("escape calls onClose", () => {
    const tui = fakeTui();
    let closed = false;
    const board = new KanbanBoardComponent(tui, fakeTheme, issues, "sprint", {
      onOpenIssue: async () => {},
      onClose: () => {
        closed = true;
      },
    });
    board.render(120);
    board.handleInput("\x1b");
    expect(closed).toBe(true);
  });

  it("'o' opens the selected issue's URL via onOpenUrl", () => {
    const tui = fakeTui();
    const withUrl = [{ ...issues[0]!, url: "https://example.invalid/ENG-1" }];
    const opened: string[] = [];
    const board = new KanbanBoardComponent(tui, fakeTheme, withUrl, "sprint", {
      onOpenIssue: async () => {},
      onOpenUrl: (issue) => {
        opened.push(issue.url!);
      },
      onClose: () => {},
    });
    board.render(120);
    board.handleInput("o");
    expect(opened).toEqual(["https://example.invalid/ENG-1"]);
  });
});
