import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderResultText } from "../src/render.js";

/** Identity theme, matching the fake used in tui.test.ts -- asserts on content, not color codes. */
const fakeTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

describe("renderResultText", () => {
  it("comment_add shows a clear confirmation with the real body, not a raw JSON dump with an empty body", () => {
    const result = { comment: { id: "123", body: "hello world", author: "Daniel", createdAt: "2026-01-01T00:00:00Z" } };
    const text = renderResultText("comment_add", result, false, fakeTheme);
    expect(text).toContain("Comment added");
    expect(text).toContain("Daniel");
    expect(text).toContain("hello world");
    expect(text).not.toContain("{");
  });

  it("comment_add flags an empty body distinctly instead of silently showing nothing", () => {
    const result = { comment: { id: "123", body: "", author: "Daniel" } };
    const text = renderResultText("comment_add", result, false, fakeTheme);
    expect(text).toContain("empty body");
  });

  it("comments lists each comment's author and a truncated body", () => {
    const result = {
      comments: [
        { id: "1", body: "first", author: "A" },
        { id: "2", body: "second", author: "B" },
      ],
    };
    const text = renderResultText("comments", result, false, fakeTheme);
    expect(text).toContain("2 comment(s)");
    expect(text).toContain("A: first");
    expect(text).toContain("B: second");
  });

  it("comments on an issue with none says so plainly", () => {
    const text = renderResultText("comments", { comments: [] }, false, fakeTheme);
    expect(text).toBe("No comments");
  });

  it("create shows the new ref and title", () => {
    const text = renderResultText("create", { ref: "jira:PROJ-1", title: "Do the thing" }, false, fakeTheme);
    expect(text).toContain("Created jira:PROJ-1");
    expect(text).toContain("Do the thing");
  });

  it("an error result renders in the error channel, not the success format", () => {
    const text = renderResultText("comment_add", "boom", true, fakeTheme);
    expect(text).toBe("boom");
  });

  it("an error with no details still renders a useful fallback instead of undefined", () => {
    expect(renderResultText("list", undefined, true, fakeTheme)).toBe("Tickets operation failed");
  });

  it("an action with no special-case rendering falls back to a JSON dump", () => {
    const text = renderResultText("backends", { backends: ["jira"] }, false, fakeTheme);
    expect(text).toContain("backends");
    expect(text).toContain("jira");
  });

  it("bounds oversized historical details.output rows", () => {
    const text = renderResultText("legacy", { body: "x".repeat(20_000) }, false, fakeTheme);
    expect(text.length).toBeLessThan(8_300);
    expect(text).toContain("legacy details truncated");
  });

  it("fails safely when a historical details.output row is cyclic", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(renderResultText("legacy", cyclic, false, fakeTheme)).toContain("legacy details were malformed");
  });
});
