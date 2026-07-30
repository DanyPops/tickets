import { describe, expect, it, mock } from "bun:test";
import type { Comment, Issue } from "@danypops/tickets";
import { IssueDetailComponent } from "../src/issue-detail-view.js";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as import("@earendil-works/pi-coding-agent").Theme;

function fakeTui(rows = 40) {
  return { terminal: { rows }, requestRender: mock(() => {}) } as unknown as import("@earendil-works/pi-tui").TUI;
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return { ref: "jira:CNF-1", id: "1", key: "CNF-1", title: "Sample issue", status: "todo", priority: "high", ...overrides };
}

describe("IssueDetailComponent", () => {
  it("renders the key, title, and every populated field", () => {
    const view = new IssueDetailComponent(
      fakeTui(),
      fakeTheme,
      issue({ assignee: "Jane Doe", parent: { key: "CNF-100", title: "Epic One" }, labels: ["a", "b"] }),
      [],
      () => {},
    );
    const rendered = view.render(100).join("\n");
    expect(rendered).toContain("CNF-1  Sample issue");
    expect(rendered).toContain("Assignee: Jane Doe");
    expect(rendered).toContain("Epic: CNF-100 Epic One");
    expect(rendered).toContain("Labels: a, b");
  });

  it("renders the description and every comment with its author", () => {
    const comments: Comment[] = [
      { id: "1", body: "First comment", author: "Alice", createdAt: "2024-01-01" },
      { id: "2", body: "Second comment", author: "Bob", createdAt: "2024-01-02" },
    ];
    const view = new IssueDetailComponent(fakeTui(), fakeTheme, issue({ description: "The full description." }), comments, () => {});
    const rendered = view.render(100).join("\n");
    expect(rendered).toContain("Description:");
    expect(rendered).toContain("The full description.");
    expect(rendered).toContain("Comments (2):");
    expect(rendered).toContain("Alice");
    expect(rendered).toContain("First comment");
    expect(rendered).toContain("Bob");
    expect(rendered).toContain("Second comment");
  });

  it("omits the comments section entirely when there are none", () => {
    const view = new IssueDetailComponent(fakeTui(), fakeTheme, issue(), [], () => {});
    expect(view.render(100).join("\n")).not.toContain("Comments");
  });

  it("escape calls close", () => {
    let closed = false;
    const view = new IssueDetailComponent(fakeTui(), fakeTheme, issue(), [], () => { closed = true; });
    view.render(100);
    view.handleInput("\x1b");
    expect(closed).toBe(true);
  });

  it("down/up scroll within bounds; scrolling is reflected in the footer position", () => {
    const longComments: Comment[] = Array.from({ length: 30 }, (_, i) => ({ id: String(i), body: `Comment body ${i}`, author: `User ${i}` }));
    const view = new IssueDetailComponent(fakeTui(15), fakeTheme, issue(), longComments, () => {});
    const before = view.render(100).join("\n");
    expect(before).toContain("1-");
    view.handleInput("\x1b[B"); // down
    const after = view.render(100).join("\n");
    expect(after).toContain("2-");
  });
});
