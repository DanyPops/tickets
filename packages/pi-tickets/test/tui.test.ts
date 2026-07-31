import { describe, expect, it, mock } from "bun:test";
import type { TicketsRpcClient } from "@danypops/tickets";
import { registerTicketsTui } from "../src/tui.js";

interface Component {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

function fakeClient(handler: (op: string, input: unknown) => unknown): TicketsRpcClient {
  return { call: mock((op: string, input: unknown) => Promise.resolve(handler(op, input))) } as unknown as TicketsRpcClient;
}

/** Minimal fake theme: pass strings through unstyled, matching how tests elsewhere treat theme.fg/bold as identity. */
const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function fakeCtx() {
  return {
    ui: {
      theme: fakeTheme,
      notify: mock(() => {}),
      setStatus: mock(() => {}),
      custom: <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => Component, _options?: unknown) =>
        new Promise<T>((resolve) => {
          const fakeTui = { terminal: { rows: 40 }, requestRender: () => {} };
          const component = factory(fakeTui, fakeTheme, {}, resolve);
          // Exposed so the test can drive it as if a user pressed keys. Each
          // call (including one nested inside another, e.g. a mode menu
          // handing off to a browse dialog, or a detail view pushed from
          // the board) overwrites this -- a test reads it again after the
          // transition it just triggered.
          (fakeCtx as unknown as { lastComponent?: Component }).lastComponent = component;
        }),
    },
  };
}

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { description?: string; handler: (args: string | undefined, ctx: unknown) => unknown }>();
  return {
    on: mock((event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler)),
    registerCommand: mock((name: string, options: { description?: string; handler: (args: string | undefined, ctx: unknown) => unknown }) =>
      commands.set(name, options),
    ),
    handlers,
    commands,
  };
}

/** Lets already-scheduled microtasks (getClient()/RPC-call resolutions) run before reading the last-opened component. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function lastComponent(): Component {
  return (fakeCtx as unknown as { lastComponent: Component }).lastComponent;
}

const ISSUES = [
  { ref: "github:#1", id: "1", key: "#1", title: "First bug", status: "todo", priority: "high", url: "https://github.com/a/b/issues/1" },
  { ref: "jira:PROJ-1", id: "PROJ-1", key: "PROJ-1", title: "Second bug", status: "in_progress", priority: "medium", url: "https://a.atlassian.net/browse/PROJ-1" },
];

describe("registerTicketsTui", () => {
  it("registers only the /tickets and /secrets-contributing surface -- no separate /query or /board commands", () => {
    const pi = fakePi();
    registerTicketsTui(pi as never);
    expect(pi.commands.has("tickets")).toBe(true);
    expect(pi.commands.has("query")).toBe(false);
    expect(pi.commands.has("board")).toBe(false);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("tool_execution_end")).toBe(true);
  });

  it("session_start sets a focus status when a focus already exists, none when it doesn't", async () => {
    const pi = fakePi();
    let hasFocus = false;
    const client = fakeClient((op) => {
      if (op === "focus.get") return { focus: hasFocus ? { ref: "github:#1", title: "First bug", url: "https://x", status: "active", updatedAt: "now" } : null };
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("tickets-focus", undefined);

    hasFocus = true;
    await pi.handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("tickets-focus", "🎯 github:#1");
  });

  it("tool_execution_end refreshes status only for a real tickets Vehicle tool", async () => {
    const pi = fakePi();
    const client = fakeClient((op) => {
      if (op === "focus.get") return { focus: { ref: "jira:PROJ-1", title: "x", url: "https://x", status: "paused", updatedAt: "now" } };
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.handlers.get("tool_execution_end")?.({ toolName: "bash" }, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();

    await pi.handlers.get("tool_execution_end")?.({ toolName: "focus_set" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("tickets-focus", "⏸ jira:PROJ-1");
  });

  it("surfaces the daemon-unavailable error via notify instead of throwing", async () => {
    const pi = fakePi();
    registerTicketsTui(pi as never, {
      getClient: async () => {
        throw new Error("tickets daemon is not running");
      },
    });

    const ctx = fakeCtx();
    await pi.commands.get("tickets")?.handler(undefined, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("daemon unavailable"), "error");
  });

  it("/tickets <query> skips the mode menu and searches the ledger directly", async () => {
    const pi = fakePi();
    const client = fakeClient((op, input) => {
      if (op === "focus.get") return { focus: null };
      if (op === "ledger.search") {
        expect(input).toEqual({ query: "bug", limit: 100 });
        return { issues: [] };
      }
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.commands.get("tickets")?.handler("bug", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('matching "bug"'), "info");
  });

  it("/tickets with no args opens a mode menu offering Browse & search, Saved queries, and Board view", async () => {
    const pi = fakePi();
    const client = fakeClient((op) => {
      if (op === "focus.get") return { focus: null };
      if (op === "ledger.search") return { issues: [] };
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    const done = pi.commands.get("tickets")?.handler(undefined, ctx);
    await tick();
    const menu = lastComponent();
    const rendered = menu.render(80).join("\n");
    expect(rendered).toContain("Browse & search");
    expect(rendered).toContain("Saved queries");
    expect(rendered).toContain("Board view");
    menu.handleInput("\x1b");
    await done;
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  describe("Browse & search mode", () => {
    it("no pooled issues and no focus notifies instead of opening the issue picker", async () => {
      const pi = fakePi();
      const client = fakeClient((op) => {
        if (op === "focus.get") return { focus: null };
        if (op === "ledger.search") return { issues: [] };
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\r"); // first item: Browse & search
      await done;
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No tickets pooled yet"), "info");
    });

    it("pressing enter on the first item focuses it and notifies with the real URL", async () => {
      const pi = fakePi();
      const client = fakeClient((op, input) => {
        if (op === "focus.get") return { focus: null };
        if (op === "ledger.search") {
          expect(input).toEqual({ query: "", limit: 100 });
          return { issues: ISSUES };
        }
        if (op === "focus.set") {
          expect(input).toEqual({ ref: "github:#1" });
          return { focus: { ref: "github:#1", title: "First bug", url: "https://github.com/a/b/issues/1", status: "active", updatedAt: "now" } };
        }
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\r"); // pick Browse & search
      await tick();
      const browser = lastComponent();
      expect(browser.render(80).join("\n")).toContain("github:#1");
      browser.handleInput("\r"); // enter — selects the first (and only non-clear) item
      await done;
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("https://github.com/a/b/issues/1"), "info");
    });

    it("prepends a clear-focus row when a focus already exists, selectable and routed to focus.clear", async () => {
      const pi = fakePi();
      const client = fakeClient((op, input) => {
        if (op === "focus.get") return { focus: { ref: "github:#1", title: "First bug", url: "https://x", status: "active", updatedAt: "now" } };
        if (op === "ledger.search") return { issues: ISSUES };
        if (op === "focus.clear") {
          expect(input).toEqual({});
          return { cleared: true };
        }
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\r"); // pick Browse & search
      await tick();
      const browser = lastComponent();
      expect(browser.render(80).join("\n")).toContain("Clear current focus");
      browser.handleInput("\r"); // first row is the clear-focus item
      await done;
      expect(ctx.ui.notify).toHaveBeenCalledWith("Focus cleared", "info");
    });

    it("pressing escape in the issue picker cancels without calling focus.set or focus.clear", async () => {
      const pi = fakePi();
      const client = fakeClient((op) => {
        if (op === "focus.get") return { focus: null };
        if (op === "ledger.search") return { issues: ISSUES };
        throw new Error(`unexpected op ${op}: escape should not trigger any further RPC call`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\r"); // pick Browse & search
      await tick();
      lastComponent().handleInput("\x1b"); // escape
      await done;
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("pressing 'o' opens the highlighted issue's real URL without closing the dialog", async () => {
      const pi = fakePi();
      const client = fakeClient((op) => {
        if (op === "focus.get") return { focus: null };
        if (op === "ledger.search") return { issues: ISSUES };
        throw new Error(`unexpected op ${op}: 'o' must not trigger focus.set/focus.clear`);
      });
      const opened: string[] = [];
      registerTicketsTui(pi as never, { getClient: async () => client, openUrl: (url) => opened.push(url) });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\r"); // pick Browse & search
      await tick();
      const browser = lastComponent();
      browser.handleInput("o"); // highlighted item defaults to the first row (github:#1)
      expect(opened).toEqual(["https://github.com/a/b/issues/1"]);
      browser.handleInput("\x1b"); // close the still-open dialog so the handler settles
      await done;
    });

    it("pressing 'v' pushes an issue detail view for the highlighted issue without closing the dialog", async () => {
      const pi = fakePi();
      const client = fakeClient((op, input) => {
        if (op === "focus.get") return { focus: null };
        if (op === "ledger.search") return { issues: ISSUES };
        if (op === "issue.get") {
          expect(input).toEqual({ ref: "github:#1" });
          return { issue: { ...ISSUES[0], description: "The full body" } };
        }
        if (op === "issue.comments") return { comments: [] };
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\r"); // pick Browse & search
      await tick();
      const list = lastComponent();
      list.handleInput("v"); // highlighted item defaults to the first row (github:#1)
      await tick();

      const detail = lastComponent();
      expect(detail).not.toBe(list);
      expect(detail.render(120).join("\n")).toContain("The full body");

      detail.handleInput("\x1b"); // back to the list
      await tick();
      list.handleInput("\x1b"); // close the still-open dialog so the handler settles
      await done;
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });
  });

  describe("Saved queries mode", () => {
    it("no saved queries notifies instead of opening the picker", async () => {
      const pi = fakePi();
      const client = fakeClient((op) => {
        if (op === "query.list") return { queries: [] };
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\x1b[B"); // down: Saved queries
      await tick();
      lastComponent().handleInput("\r");
      await done;
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No saved queries yet"), "info");
    });

    it("opens a saved-query picker, then browses the selected query's issues", async () => {
      const pi = fakePi();
      const client = fakeClient((op, input) => {
        if (op === "query.list") return { queries: [{ name: "bmptemp-sprint", backend: "jira", query: "...", description: "QE Scrum Board - Active Sprint" }] };
        if (op === "query.run") {
          expect(input).toEqual({ name: "bmptemp-sprint", limit: 100 });
          return { issues: ISSUES };
        }
        if (op === "focus.get") return { focus: null };
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\x1b[B"); // down: Saved queries
      await tick();
      lastComponent().handleInput("\r"); // pick Saved queries mode
      await tick();
      const picker = lastComponent();
      expect(picker.render(80).join("\n")).toContain("bmptemp-sprint");
      picker.handleInput("\r"); // pick the only saved query
      await tick();
      const browser = lastComponent();
      expect(browser.render(80).join("\n")).toContain("Query: bmptemp-sprint");
      browser.handleInput("\x1b"); // cancel browsing
      await done;
    });

    it("pressing 'v' pushes an issue detail view for the highlighted issue without closing the browser", async () => {
      const pi = fakePi();
      const client = fakeClient((op, input) => {
        if (op === "query.list") return { queries: [{ name: "sprint", backend: "jira", query: "..." }] };
        if (op === "query.run") return { issues: ISSUES };
        if (op === "focus.get") return { focus: null };
        if (op === "issue.get") {
          expect(input).toEqual({ ref: "github:#1" });
          return { issue: { ...ISSUES[0], description: "The full body" } };
        }
        if (op === "issue.comments") return { comments: [] };
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\x1b[B"); // down: Saved queries
      await tick();
      lastComponent().handleInput("\r"); // pick Saved queries mode
      await tick();
      lastComponent().handleInput("\r"); // pick the only saved query
      await tick();
      const browser = lastComponent();
      browser.handleInput("v"); // highlighted item defaults to the first row (github:#1)
      await tick();

      const detail = lastComponent();
      expect(detail).not.toBe(browser);
      expect(detail.render(120).join("\n")).toContain("The full body");

      detail.handleInput("\x1b"); // back to the browser
      await tick();
      browser.handleInput("\x1b"); // cancel browsing so the handler settles
      await done;
    });

    it("surfaces a query.run failure via notify instead of throwing", async () => {
      const pi = fakePi();
      const client = fakeClient((op) => {
        if (op === "query.list") return { queries: [{ name: "broken", backend: "jira", query: "nonsense" }] };
        if (op === "query.run") throw new Error("jira: invalid JQL");
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\x1b[B"); // down: Saved queries
      await tick();
      lastComponent().handleInput("\r"); // pick Saved queries mode
      await tick();
      lastComponent().handleInput("\r"); // pick the only saved query
      await done;
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("jira: invalid JQL"), "error");
    });
  });

  describe("Board view mode", () => {
    it("no saved queries notifies instead of opening the picker", async () => {
      const pi = fakePi();
      const client = fakeClient((op) => {
        if (op === "query.list") return { queries: [] };
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\x1b[B"); // down: Saved queries
      lastComponent().handleInput("\x1b[B"); // down again: Board view
      await tick();
      lastComponent().handleInput("\r");
      await done;
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No saved queries yet"), "info");
    });

    it("runs the selected saved query and renders a Kanban board grouped by status, closable with escape", async () => {
      const pi = fakePi();
      const client = fakeClient((op, input) => {
        if (op === "query.list") return { queries: [{ name: "sprint", backend: "jira", query: "..." }] };
        if (op === "query.run") {
          expect(input).toEqual({ name: "sprint", limit: 100 });
          return { issues: ISSUES };
        }
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\x1b[B"); // down: Saved queries
      lastComponent().handleInput("\x1b[B"); // down again: Board view
      await tick();
      lastComponent().handleInput("\r"); // pick Board view mode
      await tick();
      lastComponent().handleInput("\r"); // pick the only saved query
      await tick();
      const board = lastComponent();
      const rendered = board.render(120).join("\n");
      expect(rendered).toContain("Board: sprint");
      expect(rendered).toContain("First bug");
      expect(rendered).toContain("esc close");
      board.handleInput("\x1b");
      await done;
    });

    it("entering a card pushes an issue detail view with fields and comments, and escape returns to the board", async () => {
      const pi = fakePi();
      const client = fakeClient((op, input) => {
        if (op === "query.list") return { queries: [{ name: "sprint", backend: "jira", query: "..." }] };
        if (op === "query.run") return { issues: ISSUES };
        if (op === "issue.get") {
          expect(input).toEqual({ ref: "github:#1" });
          return { issue: { ...ISSUES[0], description: "Full description here", assignee: "Jane Doe" } };
        }
        if (op === "issue.comments") return { comments: [{ id: "1", body: "A real comment", author: "Alice" }] };
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\x1b[B"); // down: Saved queries
      lastComponent().handleInput("\x1b[B"); // down again: Board view
      await tick();
      lastComponent().handleInput("\r"); // pick Board view mode
      await tick();
      lastComponent().handleInput("\r"); // pick the only saved query
      await tick();

      const board = lastComponent();
      board.render(120); // the board's own first render selects "First bug" (github:#1)
      board.handleInput("\r"); // enter -- opens the detail view for the selected card
      await tick();

      const detail = lastComponent();
      expect(detail).not.toBe(board);
      const detailRendered = detail.render(120).join("\n");
      expect(detailRendered).toContain("First bug");
      expect(detailRendered).toContain("Assignee: Jane Doe");
      expect(detailRendered).toContain("Full description here");
      expect(detailRendered).toContain("Alice");
      expect(detailRendered).toContain("A real comment");

      detail.handleInput("\x1b"); // back to the board
      await tick();
      board.handleInput("\x1b"); // close the board
      await done;
    });

    it("surfaces a query.run failure via notify instead of throwing", async () => {
      const pi = fakePi();
      const client = fakeClient((op) => {
        if (op === "query.list") return { queries: [{ name: "broken", backend: "jira", query: "nonsense" }] };
        if (op === "query.run") throw new Error("jira: invalid JQL");
        throw new Error(`unexpected op ${op}`);
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput("\x1b[B"); // down: Saved queries
      lastComponent().handleInput("\x1b[B"); // down again: Board view
      await tick();
      lastComponent().handleInput("\r"); // pick Board view mode
      await tick();
      lastComponent().handleInput("\r"); // pick the only saved query
      await done;
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("jira: invalid JQL"), "error");
    });
  });
});
