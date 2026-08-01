import { describe, expect, it, mock } from "bun:test";
import type { Issue, TicketsRpcClient } from "@danypops/tickets";
import { IssueListComponent, issueDescription, issueLabel } from "../src/issue-list-view.js";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as import("@earendil-works/pi-coding-agent").Theme;

function fakeTui() {
  return { terminal: { rows: 40 }, requestRender: mock(() => {}) } as unknown as import("@earendil-works/pi-tui").TUI;
}

function fakeCtx() {
  return { ui: { notify: mock(() => {}) } } as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;
}

function fakeClient(handler: (op: string, input: unknown) => unknown): TicketsRpcClient {
  return { call: mock((op: string, input: unknown) => Promise.resolve(handler(op, input))) } as unknown as TicketsRpcClient;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const ISSUES: Issue[] = [
  { ref: "github:#1", id: "1", key: "#1", title: "First bug", status: "todo", priority: "high", url: "https://github.com/a/b/issues/1" },
];

describe("issueLabel / issueDescription", () => {
  it("collapses embedded newlines in the title into single spaces", () => {
    expect(issueLabel({ ...ISSUES[0]!, title: "line1\nline2\r\nline3" })).toBe("github:#1  line1 line2 line3");
  });

  it("tags the focused ref distinctly from every other issue", () => {
    expect(issueDescription(ISSUES[0]!, "github:#1")).toBe("todo \u00b7 high \u00b7 FOCUSED");
    expect(issueDescription(ISSUES[0]!, "other:#2")).toBe("todo \u00b7 high");
  });
});

describe("IssueListComponent", () => {
  it("renders a loading placeholder, then the real panel once loadIssues resolves", async () => {
    const client = fakeClient((op) => (op === "focus.get" ? { focus: null } : { issues: ISSUES }));
    const list = new IssueListComponent(fakeTui(), fakeTheme, fakeCtx(), client, {
      title: "GitHub issues",
      showClearFocus: true,
      loadIssues: async () => ISSUES,
      emptyMessage: () => "nothing here",
      onOpenIssue: async () => {},
    });
    expect(list.render(80).join("\n")).toContain("Loading");
    await tick();
    expect(list.render(80).join("\n")).toContain("github:#1");
  });

  it("renders the empty message inline instead of a panel when nothing loads and there's no focus to clear", async () => {
    const client = fakeClient((op) => (op === "focus.get" ? { focus: null } : { issues: [] }));
    const list = new IssueListComponent(fakeTui(), fakeTheme, fakeCtx(), client, {
      title: "GitHub issues",
      showClearFocus: true,
      loadIssues: async () => [],
      emptyMessage: (q) => `nothing for "${q}"`,
      onOpenIssue: async () => {},
    });
    await tick();
    expect(list.render(80)).toEqual(['nothing for ""']);
  });

  it("framed defaults to true (drawn with its own top/bottom rule) and false omits it, for nesting inside a host's own border", async () => {
    const client = fakeClient((op) => (op === "focus.get" ? { focus: null } : { issues: ISSUES }));
    const framed = new IssueListComponent(fakeTui(), fakeTheme, fakeCtx(), client, {
      title: "T",
      showClearFocus: false,
      loadIssues: async () => ISSUES,
      emptyMessage: () => "x",
      onOpenIssue: async () => {},
    });
    await tick();
    expect(framed.render(20)[0]).toBe("\u2500".repeat(20));

    const unframed = new IssueListComponent(fakeTui(), fakeTheme, fakeCtx(), client, {
      title: "T",
      showClearFocus: false,
      loadIssues: async () => ISSUES,
      emptyMessage: () => "x",
      onOpenIssue: async () => {},
      framed: false,
    });
    await tick();
    expect(unframed.render(20)[0]).not.toBe("\u2500".repeat(20));
    expect(unframed.render(20)[0]).toBe("T");
  });

  it("enter on a real row calls focus.set and notifies; enter on the synthetic clear-focus row calls focus.clear", async () => {
    const notify = mock(() => {});
    const ctx = { ui: { notify } } as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;
    let cleared = false;
    let focused: string | undefined;
    const client = fakeClient((op, input) => {
      if (op === "focus.get")
        return { focus: { ref: "github:#1", title: "First bug", url: "https://x", status: "active", updatedAt: "now" } };
      if (op === "focus.clear") {
        cleared = true;
        return { cleared: true };
      }
      if (op === "focus.set") {
        focused = (input as { ref: string }).ref;
        return { focus: { ref: focused, title: "x", url: "https://y", status: "active", updatedAt: "now" } };
      }
      return { issues: ISSUES };
    });
    const list = new IssueListComponent(fakeTui(), fakeTheme, ctx, client, {
      title: "T",
      showClearFocus: true,
      loadIssues: async () => ISSUES,
      emptyMessage: () => "x",
      onOpenIssue: async () => {},
    });
    await tick();
    expect(list.render(80).join("\n")).toContain("Clear current focus");
    list.handleInput("\r"); // first row is the synthetic clear-focus item
    await tick();
    expect(cleared).toBe(true);
    expect(notify).toHaveBeenCalledWith("Focus cleared", "info");
  });

  it("'o' opens the highlighted issue's URL via onOpenUrl without touching focus", async () => {
    const client = fakeClient((op) => (op === "focus.get" ? { focus: null } : { issues: ISSUES }));
    const opened: string[] = [];
    const list = new IssueListComponent(fakeTui(), fakeTheme, fakeCtx(), client, {
      title: "T",
      showClearFocus: false,
      loadIssues: async () => ISSUES,
      emptyMessage: () => "x",
      onOpenIssue: async () => {},
      onOpenUrl: (issue) => {
        if (issue.url) opened.push(issue.url);
      },
    });
    await tick();
    list.handleInput("o");
    expect(opened).toEqual(["https://github.com/a/b/issues/1"]);
  });

  it("'v' awaits onOpenIssue for the highlighted issue", async () => {
    const client = fakeClient((op) => (op === "focus.get" ? { focus: null } : { issues: ISSUES }));
    const viewed: string[] = [];
    const list = new IssueListComponent(fakeTui(), fakeTheme, fakeCtx(), client, {
      title: "T",
      showClearFocus: false,
      loadIssues: async () => ISSUES,
      emptyMessage: () => "x",
      onOpenIssue: async (issue) => {
        viewed.push(issue.ref);
      },
    });
    await tick();
    list.handleInput("v");
    await tick();
    expect(viewed).toEqual(["github:#1"]);
  });

  it("'r' reloads from source", async () => {
    let calls = 0;
    const client = fakeClient((op) => {
      if (op === "focus.get") return { focus: null };
      calls += 1;
      return { issues: calls === 1 ? [] : ISSUES };
    });
    const list = new IssueListComponent(fakeTui(), fakeTheme, fakeCtx(), client, {
      title: "T",
      showClearFocus: false,
      loadIssues: async () => ((await client.call("ledger.search", { query: "" })) as { issues: Issue[] }).issues,
      emptyMessage: () => "empty",
      onOpenIssue: async () => {},
    });
    await tick();
    expect(list.render(80).join("\n")).toBe("empty");
    list.handleInput("r");
    await tick();
    expect(list.render(80).join("\n")).toContain("github:#1");
  });
});
