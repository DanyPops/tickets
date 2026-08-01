import { describe, expect, it, mock } from "bun:test";
import type { KeyBinding, MnemonicContext } from "malevich-tui-components";
import { assertNoMnemonicConflicts } from "malevich-tui-components";
import type { TicketsRpcClient } from "@danypops/tickets";
import { registerTicketsTui } from "../src/tui.js";

interface Component {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

/** Every op gets a harmless default (empty/none) unless overridden -- several tabs' own content load in the background concurrently as soon as the panel opens (each backend's Issues list, and every raw-query backend's Saved-queries/Board pickers each call query.list independently), so a test that only cares about one tab still needs the others' background calls to resolve to *something* instead of throwing "unexpected op". */
// biome-ignore-file -- test doubles; each override's own input shape varies per op, not worth a per-op union here.
type OpHandler = (input: any) => unknown;

function fakeClient(overrides: Partial<Record<string, OpHandler>> = {}): TicketsRpcClient {
  const defaults: Record<string, OpHandler> = {
    "focus.get": () => ({ focus: null }),
    "ledger.search": () => ({ issues: [] }),
    "query.list": () => ({ queries: [] }),
  };
  const handler = { ...defaults, ...overrides };
  return {
    call: mock((op: string, input: unknown) => {
      const fn = handler[op];
      if (!fn) throw new Error(`unexpected op ${op}`);
      return Promise.resolve(fn(input));
    }),
  } as unknown as TicketsRpcClient;
}

/** Minimal fake theme: pass strings through unstyled, matching how tests elsewhere treat theme.fg/bold/inverse as identity. */
const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
  underline: (text: string) => text,
};

function fakeCtx() {
  return {
    ui: {
      theme: fakeTheme,
      notify: mock(() => {}),
      setStatus: mock(() => {}),
      custom: mock(<T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => Component, _options?: unknown) =>
        new Promise<T>((resolve) => {
          const fakeTui = { terminal: { rows: 40 }, requestRender: () => {} };
          const component = factory(fakeTui, fakeTheme, {}, resolve);
          // Exposed so the test can drive it as if a user pressed keys. Each
          // call (including one nested inside another, e.g. the panel handing
          // off to a pushed detail view) overwrites this -- a test reads it
          // again after the transition it just triggered.
          (fakeCtx as unknown as { lastComponent?: Component }).lastComponent = component;
        }),
      ),
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

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESCAPE = "\x1b";
const TAB = "\t";
const ENTER = "\r";

const ISSUES = [
  { ref: "github:#1", id: "1", key: "#1", title: "First bug", status: "todo", priority: "high", url: "https://github.com/a/b/issues/1" },
  { ref: "jira:PROJ-1", id: "PROJ-1", key: "PROJ-1", title: "Second bug", status: "in_progress", priority: "medium", url: "https://a.atlassian.net/browse/PROJ-1" },
];

const ONE_PLAIN_BACKEND = { backends: [{ name: "github", supportsRawQuery: false }] };
const ONE_RAW_QUERY_BACKEND = { backends: [{ name: "jira", supportsRawQuery: true }] };
const MIXED_BACKENDS = { backends: [{ name: "github", supportsRawQuery: false }, { name: "jira", supportsRawQuery: true }] };

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
    const client = fakeClient({
      "focus.get": () => ({ focus: hasFocus ? { ref: "github:#1", title: "First bug", url: "https://x", status: "active", updatedAt: "now" } : null }),
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("tickets-focus", undefined);

    hasFocus = true;
    await pi.handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("tickets-focus", "\ud83c\udfaf github:#1");
  });

  it("tool_execution_end refreshes status only for a real tickets Vehicle tool", async () => {
    const pi = fakePi();
    const client = fakeClient({ "focus.get": () => ({ focus: { ref: "jira:PROJ-1", title: "x", url: "https://x", status: "paused", updatedAt: "now" } }) });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.handlers.get("tool_execution_end")?.({ toolName: "bash" }, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();

    await pi.handlers.get("tool_execution_end")?.({ toolName: "focus_set" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("tickets-focus", "\u23f8 jira:PROJ-1");
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

  describe("/tickets <query> quick search", () => {
    it("searches every configured backend directly, with no provider/mode picker in between", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "ledger.search": (input) => {
          expect(input).toEqual({ query: "bug", limit: 100, backend: undefined });
          return { issues: ISSUES };
        },
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler("bug", ctx);
      await tick();
      expect(lastComponent().render(80).join("\n")).toContain("github:#1");
      lastComponent().handleInput(ESCAPE);
      await done;
    });

    it("renders an inline empty-state message instead of a toast when nothing matches", async () => {
      const pi = fakePi();
      const client = fakeClient({ "ledger.search": () => ({ issues: [] }) });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler("bug", ctx);
      await tick();
      expect(lastComponent().render(80).join("\n")).toContain('No pooled tickets matching "bug" yet');
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      lastComponent().handleInput(ESCAPE);
      await done;
    });
  });

  it("no backends configured notifies instead of opening any panel", async () => {
    const pi = fakePi();
    const client = fakeClient();
    (client.call as ReturnType<typeof mock>).mockImplementationOnce(() => Promise.resolve({ backends: [] }));
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await pi.commands.get("tickets")?.handler(undefined, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No backends configured"), "info");
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  describe("the panel's tab bar", () => {
    it("shows one tab per plain backend, and three (Issues/Queries/Board) for one with raw-query support", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => MIXED_BACKENDS });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const rendered = lastComponent().render(80).join("\n");
      expect(rendered).toContain("GitHub");
      expect(rendered).toContain("Jira Issues");
      expect(rendered).toContain("Jira Queries");
      expect(rendered).toContain("Jira Board");
      lastComponent().handleInput(ESCAPE); // home (GitHub) -- closes directly
      await done;
    });

    it("Tab/Shift-Tab cycle tabs, wrapping at both ends", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => MIXED_BACKENDS });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB); // GitHub -> Jira Issues
      expect(panel.render(80).join("\n")).toContain("Jira Issues");
      panel.handleInput(TAB); // -> Jira Queries
      panel.handleInput(TAB); // -> Jira Board
      panel.handleInput(TAB); // wraps back to GitHub
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("Left/Right cycle tabs the same as Tab, unless the active tab captures them", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => MIXED_BACKENDS });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(RIGHT);
      expect(panel.render(80).join("\n")).toContain("Jira Issues");
      panel.handleInput(LEFT);
      expect(panel.render(80).join("\n")).toContain("GitHub");
      panel.handleInput(ESCAPE);
      await done;
    });

    it("a mnemonic instantly activates its tab from anywhere, without conflicting with pooled-typeahead browsing", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => MIXED_BACKENDS, "ledger.search": () => ({ issues: ISSUES }) });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput("b"); // Jira Board
      expect(panel.render(80).join("\n")).toContain("Jira Board");
      panel.handleInput("h"); // back to GitHub
      expect(panel.render(80).join("\n")).toContain("github:#1");
      panel.handleInput(ESCAPE);
      await done;
    });

    it("a mnemonic for a tab that doesn't exist is a no-op, not a crash", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => ONE_PLAIN_BACKEND, "ledger.search": () => ({ issues: ISSUES }) });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput("j"); // no Jira tab configured
      expect(panel.render(80).join("\n")).toContain("github:#1");
      panel.handleInput(ESCAPE);
      await done;
    });

    it("'s' opens settings via the injected dependency and returns to the still-open panel", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => ONE_PLAIN_BACKEND });
      let settingsOpened = 0;
      registerTicketsTui(pi as never, { getClient: async () => client, openSettings: async () => { settingsOpened++; } });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput("s");
      await tick();
      expect(settingsOpened).toBe(1);
      expect(lastComponent()).toBe(panel); // no separate settings overlay pushed -- same ctx.ui.custom call
      panel.handleInput(ESCAPE);
      await done;
    });

    it("escape from a non-home tab returns to the home (first) tab instead of closing the panel", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => MIXED_BACKENDS, "ledger.search": () => ({ issues: ISSUES }) });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB); // -> Jira Issues
      panel.handleInput(ESCAPE); // back to home (GitHub), not closed
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(panel.render(80).join("\n")).toContain("github:#1");

      panel.handleInput(ESCAPE); // home -- actually closes now
      await done;
    });
  });

  describe("an Issues tab", () => {
    it("renders an inline empty-state message when nothing is pooled yet", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => ONE_PLAIN_BACKEND, "ledger.search": () => ({ issues: [] }) });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      expect(lastComponent().render(80).join("\n")).toContain("No GitHub tickets pooled yet");
      lastComponent().handleInput(ESCAPE);
      await done;
    });

    it("pressing enter on the first item focuses it and notifies with the real URL", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_PLAIN_BACKEND,
        "ledger.search": (input) => {
          expect(input).toEqual({ query: "", limit: 100, backend: "github" });
          return { issues: ISSUES };
        },
        "focus.set": (input) => {
          expect(input).toEqual({ ref: "github:#1" });
          return { focus: { ref: "github:#1", title: "First bug", url: "https://github.com/a/b/issues/1", status: "active", updatedAt: "now" } };
        },
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      expect(panel.render(80).join("\n")).toContain("github:#1");
      panel.handleInput(ENTER); // selects the first (and only non-clear) item
      await tick();
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("https://github.com/a/b/issues/1"), "info");
      panel.handleInput(ESCAPE);
      await done;
    });

    it("prepends a clear-focus row when a focus already exists, selectable and routed to focus.clear", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_PLAIN_BACKEND,
        "focus.get": () => ({ focus: { ref: "github:#1", title: "First bug", url: "https://x", status: "active", updatedAt: "now" } }),
        "ledger.search": () => ({ issues: ISSUES }),
        "focus.clear": (input) => {
          expect(input).toEqual({});
          return { cleared: true };
        },
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      expect(panel.render(80).join("\n")).toContain("Clear current focus");
      panel.handleInput(ENTER); // first row is the clear-focus item
      await tick();
      expect(ctx.ui.notify).toHaveBeenCalledWith("Focus cleared", "info");
      panel.handleInput(ESCAPE);
      await done;
    });

    it("pressing escape closes the panel without calling focus.set or focus.clear", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => ONE_PLAIN_BACKEND, "ledger.search": () => ({ issues: ISSUES }) });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      lastComponent().handleInput(ESCAPE);
      await done;
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("pressing 'o' opens the highlighted issue's real URL without closing the panel", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => ONE_PLAIN_BACKEND, "ledger.search": () => ({ issues: ISSUES }) });
      const opened: string[] = [];
      registerTicketsTui(pi as never, { getClient: async () => client, openUrl: (url) => opened.push(url) });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput("o"); // highlighted item defaults to the first row (github:#1)
      expect(opened).toEqual(["https://github.com/a/b/issues/1"]);
      panel.handleInput(ESCAPE);
      await done;
    });

    it("pressing 'v' pushes an issue detail view for the highlighted issue without closing the panel", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_PLAIN_BACKEND,
        "ledger.search": () => ({ issues: ISSUES }),
        "issue.get": (input) => {
          expect(input).toEqual({ ref: "github:#1" });
          return { issue: { ...ISSUES[0], description: "The full body" } };
        },
        "issue.comments": () => ({ comments: [] }),
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput("v"); // highlighted item defaults to the first row (github:#1)
      await tick();

      const detail = lastComponent();
      expect(detail).not.toBe(panel);
      expect(detail.render(120).join("\n")).toContain("The full body");

      detail.handleInput(ESCAPE); // back to the panel
      await tick();
      panel.handleInput(ESCAPE); // close
      await done;
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("pressing 'r' reloads from source", async () => {
      const pi = fakePi();
      let calls = 0;
      const client = fakeClient({
        "backends.list": () => ONE_PLAIN_BACKEND,
        "ledger.search": () => {
          calls++;
          return { issues: calls === 1 ? [] : ISSUES };
        },
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      expect(panel.render(80).join("\n")).toContain("No GitHub tickets pooled yet");
      panel.handleInput("r");
      await tick();
      expect(panel.render(80).join("\n")).toContain("github:#1");
      panel.handleInput(ESCAPE);
      await done;
    });
  });

  describe("a Saved-queries tab", () => {
    it("renders an inline empty-state message when this backend has no saved queries", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => ONE_RAW_QUERY_BACKEND, "query.list": () => ({ queries: [] }) });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB); // Jira Issues -> Jira Queries
      await tick();
      expect(panel.render(80).join("\n")).toContain("No saved queries yet for Jira");
      panel.handleInput(ESCAPE); // Queries (picker, not captured) -> home
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("filters out saved queries belonging to a different backend", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_RAW_QUERY_BACKEND,
        "query.list": () => ({ queries: [{ name: "gh-triage", backend: "github", query: "..." }] }),
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB);
      await tick();
      expect(panel.render(80).join("\n")).toContain("No saved queries yet for Jira");
      panel.handleInput(ESCAPE);
      panel.handleInput(ESCAPE);
      await done;
    });

    it("the picker leads with the human description and pushes the internal name into the secondary column", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_RAW_QUERY_BACKEND,
        "query.list": () => ({ queries: [{ name: "short-alias", backend: "jira", query: "...", description: "Human-Readable Board Name" }] }),
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB);
      await tick();
      const rendered = panel.render(80).join("\n");
      const nameIndex = rendered.indexOf("Human-Readable Board Name");
      const aliasIndex = rendered.indexOf("(short-alias)");
      expect(nameIndex).toBeGreaterThanOrEqual(0);
      expect(aliasIndex).toBeGreaterThan(nameIndex);
      panel.handleInput(ESCAPE);
      panel.handleInput(ESCAPE);
      await done;
    });

    it("picking a saved query browses its issues; escape returns to the picker instead of leaving the tab", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_RAW_QUERY_BACKEND,
        "query.list": () => ({ queries: [{ name: "bmptemp-sprint", backend: "jira", query: "...", description: "QE Scrum Board" }] }),
        "query.run": (input) => {
          expect(input).toEqual({ name: "bmptemp-sprint", limit: 100 });
          return { issues: ISSUES };
        },
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB);
      await tick();
      expect(panel.render(80).join("\n")).toContain("bmptemp-sprint");
      panel.handleInput(ENTER); // pick the only saved query
      await tick();
      expect(panel.render(80).join("\n")).toContain("Query: bmptemp-sprint");

      panel.handleInput(ESCAPE); // back to the picker, not out of the tab
      expect(panel.render(80).join("\n")).toContain("bmptemp-sprint");
      expect(ctx.ui.notify).not.toHaveBeenCalled();

      panel.handleInput(ESCAPE); // now leaves the tab -> home
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("pressing 'v' while browsing pushes an issue detail view", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_RAW_QUERY_BACKEND,
        "query.list": () => ({ queries: [{ name: "sprint", backend: "jira", query: "..." }] }),
        "query.run": () => ({ issues: ISSUES }),
        "issue.get": (input) => {
          expect(input).toEqual({ ref: "github:#1" });
          return { issue: { ...ISSUES[0], description: "The full body" } };
        },
        "issue.comments": () => ({ comments: [] }),
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB);
      await tick();
      panel.handleInput(ENTER);
      await tick();
      panel.handleInput("v");
      await tick();

      const detail = lastComponent();
      expect(detail).not.toBe(panel);
      expect(detail.render(120).join("\n")).toContain("The full body");

      detail.handleInput(ESCAPE);
      await tick();
      panel.handleInput(ESCAPE); // browse -> picker
      panel.handleInput(ESCAPE); // picker -> home
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("surfaces a query.run failure inline instead of throwing", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_RAW_QUERY_BACKEND,
        "query.list": () => ({ queries: [{ name: "broken", backend: "jira", query: "nonsense" }] }),
        "query.run": () => {
          throw new Error("jira: invalid JQL");
        },
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB);
      await tick();
      panel.handleInput(ENTER);
      await tick();
      expect(panel.render(80).join("\n")).toContain("jira: invalid JQL");
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      panel.handleInput(ESCAPE); // browse (error state still counts as "browsing") -> picker
      panel.handleInput(ESCAPE); // -> home
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });
  });

  describe("a Board tab", () => {
    it("renders an inline empty-state message when this backend has no saved queries", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => ONE_RAW_QUERY_BACKEND, "query.list": () => ({ queries: [] }) });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB); // Issues -> Queries
      panel.handleInput(TAB); // Queries -> Board
      await tick();
      expect(panel.render(80).join("\n")).toContain("No saved queries yet for Jira");
      panel.handleInput(ESCAPE); // Board (picker, not captured) -> home
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("runs the selected saved query and renders a Kanban board grouped by status", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_RAW_QUERY_BACKEND,
        "query.list": () => ({ queries: [{ name: "sprint", backend: "jira", query: "..." }] }),
        "query.run": (input) => {
          expect(input).toEqual({ name: "sprint", limit: 100 });
          return { issues: ISSUES };
        },
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB);
      panel.handleInput(TAB);
      await tick();
      panel.handleInput(ENTER); // pick the only saved query
      await tick();
      const rendered = panel.render(120).join("\n");
      expect(rendered).toContain("Board: sprint");
      expect(rendered).toContain("First bug");
      expect(rendered).toContain("esc close");
      panel.handleInput(ESCAPE); // board -> picker
      panel.handleInput(ESCAPE); // picker -> home
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("left/right navigate the board's own columns instead of cycling the panel's tabs", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_RAW_QUERY_BACKEND,
        "query.list": () => ({ queries: [{ name: "sprint", backend: "jira", query: "..." }] }),
        "query.run": () => ({ issues: ISSUES }),
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB);
      panel.handleInput(TAB);
      await tick();
      panel.handleInput(ENTER);
      await tick();
      panel.handleInput(RIGHT); // moves the board's own column selection, not the tab bar
      expect(panel.render(120).join("\n")).toContain("Jira Board"); // still on the same tab
      panel.handleInput(ESCAPE); // board -> picker
      panel.handleInput(ESCAPE); // picker -> home
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("entering a card pushes an issue detail view, and escape returns to the board (not the picker)", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_RAW_QUERY_BACKEND,
        "query.list": () => ({ queries: [{ name: "sprint", backend: "jira", query: "..." }] }),
        "query.run": () => ({ issues: ISSUES }),
        "issue.get": (input) => {
          expect(input).toEqual({ ref: "github:#1" });
          return { issue: { ...ISSUES[0], description: "Full description here", assignee: "Jane Doe" } };
        },
        "issue.comments": () => ({ comments: [{ id: "1", body: "A real comment", author: "Alice" }] }),
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB);
      panel.handleInput(TAB);
      await tick();
      panel.handleInput(ENTER);
      await tick();

      panel.render(120); // the board's own first render selects "First bug" (github:#1)
      panel.handleInput(ENTER); // opens the detail view for the selected card
      await tick();

      const detail = lastComponent();
      expect(detail).not.toBe(panel);
      const detailRendered = detail.render(120).join("\n");
      expect(detailRendered).toContain("First bug");
      expect(detailRendered).toContain("Assignee: Jane Doe");
      expect(detailRendered).toContain("Full description here");
      expect(detailRendered).toContain("Alice");
      expect(detailRendered).toContain("A real comment");

      detail.handleInput(ESCAPE); // back to the board
      await tick();
      expect(panel.render(120).join("\n")).toContain("Board: sprint");

      panel.handleInput(ESCAPE); // board -> picker
      panel.handleInput(ESCAPE); // picker -> home
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("surfaces a query.run failure inline instead of throwing, without ever entering the board state", async () => {
      const pi = fakePi();
      const client = fakeClient({
        "backends.list": () => ONE_RAW_QUERY_BACKEND,
        "query.list": () => ({ queries: [{ name: "broken", backend: "jira", query: "nonsense" }] }),
        "query.run": () => {
          throw new Error("jira: invalid JQL");
        },
      });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB);
      panel.handleInput(TAB);
      await tick();
      panel.handleInput(ENTER);
      await tick();
      expect(panel.render(80).join("\n")).toContain("jira: invalid JQL");
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      // A failed query.run never transitions BoardTabComponent into its
      // "board" state (unlike Saved-queries, which always renders its own
      // IssueListComponent, error or not) -- the picker is still showing, so
      // escape isn't captured: it goes straight to the host's own tab-jump.
      panel.handleInput(ESCAPE); // Board (picker, not captured) -> home
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });
  });

  describe("mnemonic keybindings never collide with a tab's own action keys", () => {
    it("the panel's tab mnemonics (h/l/i/q/b), settings (s), and every Issues tab's own v/o/r are all distinct", () => {
      // Mirrors the real reachable-at-once set: the panel's own top-level
      // dispatcher (mnemonics + settings) plus whichever single tab's own
      // content is active -- an Issues tab is the leaf every backend has at
      // least one of, and the only one with its own single-letter actions.
      const root: MnemonicContext = {
        name: "panel",
        bindings: [
          { key: "h", description: "jump: GitHub" },
          { key: "l", description: "jump: GitLab" },
          { key: "i", description: "jump: Jira Issues" },
          { key: "q", description: "jump: Jira Queries" },
          { key: "b", description: "jump: Jira Board" },
          { key: "s", description: "open settings" },
        ],
        children: [
          {
            name: "an Issues tab",
            bindings: [
              { key: "v", description: "view issue detail" } satisfies KeyBinding,
              { key: "o", description: "open in browser" },
              { key: "r", description: "reload" },
            ],
          },
        ],
      };
      expect(() => assertNoMnemonicConflicts(root)).not.toThrow();
    });
  });
});
