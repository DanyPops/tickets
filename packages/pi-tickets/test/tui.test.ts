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
      custom: <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => Component) =>
        new Promise<T>((resolve) => {
          const fakeTui = { requestRender: () => {} };
          const component = factory(fakeTui, fakeTheme, {}, resolve);
          // Exposed so the test can drive it as if a user pressed keys.
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

const ISSUES = [
  { ref: "github:#1", id: "1", key: "#1", title: "First bug", status: "todo", priority: "high", url: "https://github.com/a/b/issues/1" },
  { ref: "jira:PROJ-1", id: "PROJ-1", key: "PROJ-1", title: "Second bug", status: "in_progress", priority: "medium", url: "https://a.atlassian.net/browse/PROJ-1" },
];

describe("registerTicketsTui", () => {
  it("registers the /tickets command and session_start / tool_execution_end handlers", () => {
    const pi = fakePi();
    registerTicketsTui(pi as never);
    expect(pi.commands.has("tickets")).toBe(true);
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

  it("/tickets with no pooled issues and no focus notifies instead of opening a dialog", async () => {
    const pi = fakePi();
    const client = fakeClient((op) => {
      if (op === "focus.get") return { focus: null };
      if (op === "ledger.search") return { issues: [] };
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.commands.get("tickets")?.handler(undefined, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No tickets pooled yet"), "info");
  });

  it("/tickets opens a dialog; pressing enter on the first item focuses it and notifies with the real URL", async () => {
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
    // Let the async op calls (focus.get / ledger.search) resolve before the dialog opens.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const component = (fakeCtx as unknown as { lastComponent: Component }).lastComponent;
    expect(component.render(80).join("\n")).toContain("github:#1");
    component.handleInput("\r"); // enter — selects the first (and only non-clear) item
    await done;
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("https://github.com/a/b/issues/1"), "info");
  });

  it("/tickets prepends a clear-focus row when a focus already exists, selectable and routed to focus.clear", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    const component = (fakeCtx as unknown as { lastComponent: Component }).lastComponent;
    expect(component.render(80).join("\n")).toContain("Clear current focus");
    component.handleInput("\r"); // first row is the clear-focus item
    await done;
    expect(ctx.ui.notify).toHaveBeenCalledWith("Focus cleared", "info");
  });

  it("/tickets passes a non-empty query through to ledger.search", async () => {
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

  it("pressing escape cancels without calling focus.set or focus.clear", async () => {
    const pi = fakePi();
    const client = fakeClient((op) => {
      if (op === "focus.get") return { focus: null };
      if (op === "ledger.search") return { issues: ISSUES };
      throw new Error(`unexpected op ${op}: escape should not trigger any further RPC call`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    const done = pi.commands.get("tickets")?.handler(undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const component = (fakeCtx as unknown as { lastComponent: Component }).lastComponent;
    component.handleInput("\x1b"); // escape
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    const component = (fakeCtx as unknown as { lastComponent: Component }).lastComponent;
    component.handleInput("o"); // highlighted item defaults to the first row (github:#1)
    expect(opened).toEqual(["https://github.com/a/b/issues/1"]);
    component.handleInput("\x1b"); // close the still-open dialog so the handler settles
    await done;
    expect(ctx.ui.notify).not.toHaveBeenCalled();
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

  it("registers the /query command", () => {
    const pi = fakePi();
    registerTicketsTui(pi as never);
    expect(pi.commands.has("query")).toBe(true);
  });

  it("/query with no saved queries notifies instead of opening a dialog", async () => {
    const pi = fakePi();
    const client = fakeClient((op) => {
      if (op === "query.list") return { queries: [] };
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.commands.get("query")?.handler(undefined, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No saved queries yet"), "info");
  });

  it("/query <name> runs that saved query directly, skipping the picker", async () => {
    const pi = fakePi();
    const client = fakeClient((op, input) => {
      if (op === "query.list") return { queries: [{ name: "bmptemp-sprint", backend: "jira", query: "...", createdAt: "now", updatedAt: "now" }] };
      if (op === "query.run") {
        expect(input).toEqual({ name: "bmptemp-sprint", limit: 100 });
        return { issues: ISSUES };
      }
      if (op === "focus.get") return { focus: null };
      if (op === "focus.set") return { focus: { ref: "github:#1", title: "First bug", url: "https://github.com/a/b/issues/1", status: "active", updatedAt: "now" } };
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    const done = pi.commands.get("query")?.handler("bmptemp-sprint", ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const component = (fakeCtx as unknown as { lastComponent: Component }).lastComponent;
    expect(component.render(80).join("\n")).toContain("Query: bmptemp-sprint");
    component.handleInput("\r");
    await done;
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("https://github.com/a/b/issues/1"), "info");
  });

  it("/query with no args opens a saved-query picker first, then browses the selected query's issues", async () => {
    const pi = fakePi();
    const client = fakeClient((op, input) => {
      if (op === "query.list") return { queries: [{ name: "bmptemp-sprint", backend: "jira", query: "...", description: "QE Scrum Board - Active Sprint", createdAt: "now", updatedAt: "now" }] };
      if (op === "query.run") {
        expect(input).toEqual({ name: "bmptemp-sprint", limit: 100 });
        return { issues: ISSUES };
      }
      if (op === "focus.get") return { focus: null };
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    const done = pi.commands.get("query")?.handler(undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const picker = (fakeCtx as unknown as { lastComponent: Component }).lastComponent;
    expect(picker.render(80).join("\n")).toContain("bmptemp-sprint");
    picker.handleInput("\r"); // pick the only saved query
    await new Promise((resolve) => setTimeout(resolve, 0));
    const browser = (fakeCtx as unknown as { lastComponent: Component }).lastComponent;
    expect(browser.render(80).join("\n")).toContain("Query: bmptemp-sprint");
    browser.handleInput("\x1b"); // cancel browsing
    await done;
  });

  it("/query surfaces a query.run failure via notify instead of throwing", async () => {
    const pi = fakePi();
    const client = fakeClient((op) => {
      if (op === "query.list") return { queries: [{ name: "broken", backend: "jira", query: "nonsense", createdAt: "now", updatedAt: "now" }] };
      if (op === "query.run") throw new Error("jira: invalid JQL");
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.commands.get("query")?.handler("broken", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("jira: invalid JQL"), "error");
  });

  it("registers the /board command", () => {
    const pi = fakePi();
    registerTicketsTui(pi as never);
    expect(pi.commands.has("board")).toBe(true);
  });

  it("/board with no saved queries notifies instead of opening a dialog", async () => {
    const pi = fakePi();
    const client = fakeClient((op) => {
      if (op === "query.list") return { queries: [] };
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.commands.get("board")?.handler(undefined, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No saved queries yet"), "info");
  });

  it("/board <name> runs that saved query and renders a Kanban board grouped by status, closable with escape", async () => {
    const pi = fakePi();
    const client = fakeClient((op, input) => {
      if (op === "query.list") return { queries: [{ name: "sprint", backend: "jira", query: "...", createdAt: "now", updatedAt: "now" }] };
      if (op === "query.run") {
        expect(input).toEqual({ name: "sprint", limit: 100 });
        return { issues: ISSUES };
      }
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    const done = pi.commands.get("board")?.handler("sprint", ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const component = (fakeCtx as unknown as { lastComponent: Component }).lastComponent;
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Board: sprint");
    expect(rendered).toContain("First bug");
    expect(rendered).toContain("esc close");
    component.handleInput("\x1b");
    await done;
  });

  it("/board surfaces a query.run failure via notify instead of throwing", async () => {
    const pi = fakePi();
    const client = fakeClient((op) => {
      if (op === "query.list") return { queries: [{ name: "broken", backend: "jira", query: "nonsense", createdAt: "now", updatedAt: "now" }] };
      if (op === "query.run") throw new Error("jira: invalid JQL");
      throw new Error(`unexpected op ${op}`);
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.commands.get("board")?.handler("broken", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("jira: invalid JQL"), "error");
  });
});
