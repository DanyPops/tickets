import { describe, expect, it } from "bun:test";
import type { Issue } from "@danypops/tickets";
import { epicBadgeColor, groupIssuesByColumn, MAX_CARDS_PER_COLUMN, renderKanbanBoard } from "../src/board-view.js";

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
    const rows = renderKanbanBoard(issues, fakeTheme, 120).join("\n");
    expect(rows).toContain("TO DO: 1");
    expect(rows).toContain("IN PROGRESS: 1");
    expect(rows).toContain("REVIEW: 0");
    expect(rows).toContain("DONE: 0");
  });

  it("includes the card's key, epic title, labels, story points, and assignee initials", () => {
    const rows = renderKanbanBoard(issues, fakeTheme, 120).join("\n");
    expect(rows).toContain("First card");
    expect(rows).toContain("Epic One");
    expect(rows).toContain("\u2039red-team\u203a");
    expect(rows).toContain("CNF-1");
    expect(rows).toContain("\u20223");
    expect(rows).toContain("JD");
  });

  it("caps cards per column and shows a +N more footer instead of an unbounded render", () => {
    const many = Array.from({ length: MAX_CARDS_PER_COLUMN + 3 }, (_, i) => issue({ ref: `a:${i}`, key: `CNF-${i}`, title: `card ${i}`, status: "todo" }));
    const rows = renderKanbanBoard(many, fakeTheme, 120).join("\n");
    expect(rows).toContain("+3 more");
    expect(rows).not.toContain("card 10"); // 11th card (index 10) is beyond the 8-card cap
  });

  it("every rendered row is padded to the same total width, so columns stay aligned", () => {
    const rows = renderKanbanBoard(issues, fakeTheme, 100);
    const widths = new Set(rows.map((row) => stripAnsi(row).length));
    expect(widths.size).toBe(1);
  });
});
