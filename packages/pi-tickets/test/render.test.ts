import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatApprovalInput, renderResultText, titleForApproval } from "../src/render.js";
import {
  SYNTHETIC_APPROVE_INPUT,
  SYNTHETIC_GITHUB_CREATE_INPUT,
  SYNTHETIC_JIRA_CREATE_INPUT,
  SYNTHETIC_LIST_FILTER_INPUT,
  SYNTHETIC_PR_REVIEWERS_INPUT,
} from "./fixtures/approval-inputs.js";
import { renderApprovalPrompt } from "./helpers/approval-harness.js";

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

  it("get renders presentation.ts's own rich issue detail instead of a raw JSON dump", () => {
    const issue = { ref: "jira:PROJ-1", title: "Bound the persisted view", status: "in_progress", priority: "high" };
    const text = renderResultText("get", { issue }, false, fakeTheme);
    expect(text).toContain("jira:PROJ-1");
    expect(text).toContain("Bound the persisted view");
    expect(text).not.toContain("{");
  });

  it("list/search/children render as a real issue table, not a raw JSON dump", () => {
    const issues = [{ ref: "jira:PROJ-1", title: "Do the thing", status: "todo" }];
    for (const action of ["list", "search", "children"]) {
      const text = renderResultText(action, { issues }, false, fakeTheme);
      expect(text).toContain("jira:PROJ-1");
      expect(text).toContain("Do the thing");
      expect(text).not.toContain("{");
    }
  });

  it("approve/merge/request_changes render a real mutation line, not a raw JSON dump", () => {
    const issue = { ref: "github:#41", title: "feat: SSO", status: "in_review", priority: "none" };
    expect(renderResultText("approve", { issue }, false, fakeTheme)).toContain("Approved github:#41");
    expect(renderResultText("merge", { issue }, false, fakeTheme)).toContain("Merged github:#41");
    expect(renderResultText("request_changes", { issue }, false, fakeTheme)).toContain("Changes requested on github:#41");
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

describe("formatApprovalInput", () => {
  it("renders plain key: value lines instead of a JSON blob a human has to parse", () => {
    const text = formatApprovalInput(SYNTHETIC_APPROVE_INPUT);
    expect(text).toBe("ref: github:#101\nbody: Looks good to me.");
    expect(text).not.toContain("{");
    expect(text).not.toContain("}");
  });

  it("never hides or truncates a field -- a security approval prompt must show the real, complete input, recursing into nested objects/arrays instead of JSON.stringify'ing them onto one line", () => {
    const text = formatApprovalInput(SYNTHETIC_LIST_FILTER_INPUT);
    expect(text).toBe("ref: github:#101\nfilter:\n  labels: bug, P1\n  limit: 5");
    expect(text).not.toContain("{");
    expect(text).not.toContain("}");
  });

  it("a Jira-shaped issue.create input's multi-line, wiki-markup description gets its own indented block under its field name, not squashed onto one JSON.stringify'd line", () => {
    const text = formatApprovalInput(SYNTHETIC_JIRA_CREATE_INPUT);
    expect(text).toBe(
      [
        "backend: jira",
        "input:",
        "  title: Add retry/backoff to the widget-sync job",
        "  description:",
        "    The widget-sync job currently fails hard on the first transient network error.",
        "",
        "    h2. Done Criteria",
        "",
        "    * Retry a transient failure up to 3 times with exponential backoff",
        "    * Log each retry attempt at warn level",
        "    * Verify a forced failure recovers by the second attempt",
        "  labels: backend, reliability",
        "  issueType: Story",
      ].join("\n"),
    );
    expect(text).not.toContain("{");
    expect(text).not.toContain('\\n"');
  });

  it("a GitHub-shaped issue.create input's plain multi-paragraph body reads the same way, with no wiki markup assumed", () => {
    const text = formatApprovalInput(SYNTHETIC_GITHUB_CREATE_INPUT);
    expect(text).toContain("  title: Flaky test: widget list pagination");
    expect(text).toContain("    Steps to reproduce:");
    expect(text).toContain("  labels: bug, flaky-test");
    expect(text).not.toContain("{");
  });

  it("renders an array of nested objects (PR reviewers) as an indented bulleted sub-tree, not a JSON array", () => {
    const text = formatApprovalInput(SYNTHETIC_PR_REVIEWERS_INPUT);
    expect(text).toBe("ref: github:#101\nreviewers:\n  - username: alice\n    state: approved\n  - username: bob");
  });

  it("says so plainly for an empty or missing input, field, or array rather than an empty string or bracket", () => {
    expect(formatApprovalInput(undefined)).toBe("(no input)");
    expect(formatApprovalInput(null)).toBe("(no input)");
    expect(formatApprovalInput({})).toBe("(no input)");
    expect(formatApprovalInput({ labels: [] })).toBe("labels: (none)");
  });

  it("falls back to a plain literal rendering for non-object top-level input rather than throwing", () => {
    expect(formatApprovalInput("just a string")).toBe("just a string");
    expect(formatApprovalInput([1, 2, 3])).toBe("1, 2, 3");
  });
});

describe("titleForApproval", () => {
  it("names the concrete ref being acted on instead of the generic default title", () => {
    expect(titleForApproval("issue.approve", { ref: "github:#101" })).toBe("Approve github:#101?");
    expect(titleForApproval("issue.merge", { ref: "github:#101" })).toBe("Merge github:#101?");
    expect(titleForApproval("issue.request_changes", SYNTHETIC_APPROVE_INPUT)).toBe("Request changes on github:#101?");
    expect(titleForApproval("issue.update", { ref: "jira:PROJ-1", input: {} })).toBe("Update jira:PROJ-1?");
    expect(titleForApproval("issue.comment_add", { ref: "github:#101", body: "lgtm" })).toBe("Comment on github:#101?");
  });

  it("names the new ticket's own title when there's no ref yet (issue.create mints one on the backend)", () => {
    expect(titleForApproval("issue.create", SYNTHETIC_GITHUB_CREATE_INPUT)).toBe('Create "Flaky test: widget list pagination"?');
  });

  it("truncates an overlong new-ticket title rather than blowing out the prompt's own title bar", () => {
    const longTitle = "x".repeat(100);
    const title = titleForApproval("issue.create", { backend: "jira", input: { title: longTitle } });
    expect(title.length).toBeLessThan(90);
    expect(title).toContain("…");
  });

  it("falls back to a bare verb when there's neither a ref nor a new-ticket title to name", () => {
    expect(titleForApproval("issue.create", { backend: "github", input: {} })).toBe("Create?");
  });

  it("falls back to a Title Cased split of the operation name for anything not explicitly listed", () => {
    expect(titleForApproval("stage.push", { id: "stage-1" })).toBe("Stage Push?");
  });
});

describe("renderApprovalPrompt (harness: title + message together, matching vehicle-client.ts's own approvalPrompt wiring)", () => {
  it("produces the exact title/message pair a human sees for an issue.approve request", () => {
    const { title, message } = renderApprovalPrompt("issue.approve", "external-write", SYNTHETIC_APPROVE_INPUT);
    expect(title).toBe("Approve github:#101?");
    expect(message).toBe(
      "issue.approve (external-write effect) requests approval before it can run.\n\nref: github:#101\nbody: Looks good to me.",
    );
    expect(message).not.toContain("{");
  });

  it("produces a readable prompt for a Jira-shaped issue.create request, end to end", () => {
    const { title, message } = renderApprovalPrompt("issue.create", "external-write", SYNTHETIC_JIRA_CREATE_INPUT);
    expect(title).toBe('Create "Add retry/backoff to the widget-sync job"?');
    expect(message).toContain("issue.create (external-write effect) requests approval before it can run.");
    expect(message).toContain("  description:\n    The widget-sync job currently fails hard on the first transient network error.");
    expect(message).not.toContain("{");
  });
});
