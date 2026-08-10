import { afterEach, describe, expect, it, mock } from "bun:test";
import type { TicketsRpcClient } from "@danypops/tickets";
import type { KeyBinding, MnemonicContext } from "malevich-tui-components";
import { assertNoMnemonicConflicts } from "malevich-tui-components";
import { resetSessionSecretsForTests } from "../src/session-identity.js";
import { registerTicketsTui } from "../src/tui.js";

// This module's own session-secret cache is a shared singleton across every test in this file
// (and, since bun test runs one process, every OTHER test file too) -- reset after each test so
// one test's session_start registration never leaks a cached secret into a later, unrelated
// test that happens to reuse the same default session id ("test-session").
afterEach(() => {
  resetSessionSecretsForTests();
});

interface Component {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

/** Every op gets a harmless default (empty/none) unless overridden -- several tabs' own content load in the background concurrently as soon as the panel opens (each backend's Issues list, and every raw-query backend's Saved-queries/Board pickers each call query.list independently), so a test that only cares about one tab still needs the others' background calls to resolve to *something* instead of throwing "unexpected op". */
// biome-ignore lint/suspicious/noExplicitAny: test doubles; each override's own input shape varies per op, not worth a per-op union here.
type OpHandler = (input: any) => unknown;

function fakeClient(overrides: Partial<Record<string, OpHandler>> = {}): TicketsRpcClient {
  const defaults: Record<string, OpHandler> = {
    "focus.get": () => ({ focus: null }),
    "ledger.search": () => ({ issues: [] }),
    "query.list": () => ({ queries: [] }),
    "session.register": (input: { sessionId: string }) => ({ sessionId: input.sessionId, secret: "test-secret" }),
    "session.release": () => ({ released: true }),
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

/** Minimal fake theme: pass strings through unstyled, matching how tests elsewhere treat theme.fg/bold/inverse/bg as identity. */
const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
  underline: (text: string) => text,
};

// A theme that wraps text in genuine ANSI SGR codes, the way every real pi
// theme does -- unlike fakeTheme's identity passthrough, which can never
// exercise a bug that only shows up once content actually contains escape
// sequences (confirmed live in pi-packed's identical panel: Envelope's
// default measure counts ANSI escape bytes as visible characters, so a
// more-styled row got padded as if it were longer than it really is).
const ANSI_CODE = "\u001b[38;5;208m";
const ANSI_RESET = "\u001b[0m";
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching a real ANSI escape sequence, not an accidental control character.
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;
const realishTheme = {
  fg: (_color: string, text: string) => `${ANSI_CODE}${text}${ANSI_RESET}`,
  bg: (_color: string, text: string) => `${ANSI_CODE}${text}${ANSI_RESET}`,
  bold: (text: string) => `${ANSI_CODE}${text}${ANSI_RESET}`,
  inverse: (text: string) => `${ANSI_CODE}${text}${ANSI_RESET}`,
  underline: (text: string) => `${ANSI_CODE}${text}${ANSI_RESET}`,
};
function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_PATTERN, "");
}

function fakeCtx(theme: typeof fakeTheme = fakeTheme, sessionId = "test-session") {
  return {
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      theme,
      notify: mock(() => {}),
      setStatus: mock(() => {}),
      custom: mock(
        <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => Component, _options?: unknown) =>
          new Promise<T>((resolve) => {
            const fakeTui = { terminal: { rows: 40 }, requestRender: () => {} };
            const component = factory(fakeTui, theme, {}, resolve);
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

// Pi supports several independent pi.on(event, ...) registrations for the same event (e.g. this
// module's own session_start alongside registerVehicleStatusRefresh's) -- an array per event,
// not a single overwritten slot, is what makes that real behavior reproducible here.
function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, { description?: string; handler: (args: string | undefined, ctx: unknown) => unknown }>();
  return {
    on: mock((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }),
    registerCommand: mock((name: string, options: { description?: string; handler: (args: string | undefined, ctx: unknown) => unknown }) =>
      commands.set(name, options),
    ),
    handlers,
    commands,
  };
}

/** Fires every handler registered for this event, in registration order -- the real Pi runtime's own fan-out semantics. */
async function fireEvent(pi: ReturnType<typeof fakePi>, event: string, arg: unknown, ctx: unknown): Promise<void> {
  for (const handler of pi.handlers.get(event) ?? []) await handler(arg, ctx);
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
  {
    ref: "jira:PROJ-1",
    id: "PROJ-1",
    key: "PROJ-1",
    title: "Second bug",
    status: "in_progress",
    priority: "medium",
    url: "https://a.atlassian.net/browse/PROJ-1",
  },
];

const ONE_PLAIN_BACKEND = { backends: [{ name: "github", supportsRawQuery: false }] };
const ONE_RAW_QUERY_BACKEND = { backends: [{ name: "jira", supportsRawQuery: true }] };
const MIXED_BACKENDS = {
  backends: [
    { name: "github", supportsRawQuery: false },
    { name: "jira", supportsRawQuery: true },
  ],
};

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
      "focus.get": () => ({
        focus: hasFocus ? { ref: "github:#1", title: "First bug", url: "https://x", status: "active", updatedAt: "now" } : null,
      }),
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await fireEvent(pi, "session_start", {}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("tickets-focus", undefined);

    hasFocus = true;
    await fireEvent(pi, "session_start", {}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("tickets-focus", "\ud83c\udfaf github:#1");
  });

  it("session_start registers this session's own identity, caching the secret; session_shutdown releases it with that same secret", async () => {
    const pi = fakePi();
    const registerCalls: unknown[] = [];
    const releaseCalls: unknown[] = [];
    const client = fakeClient({
      "session.register": (input) => {
        registerCalls.push(input);
        return { sessionId: input.sessionId, secret: "the-real-secret" };
      },
      "session.release": (input) => {
        releaseCalls.push(input);
        return { released: true };
      },
      "focus.set": (input) => ({
        focus: { ref: (input as { ref: string }).ref, title: "x", url: "https://y", status: "active", updatedAt: "now" },
      }),
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx(fakeTheme, "session-real");
    await fireEvent(pi, "session_start", {}, ctx);
    expect(registerCalls).toEqual([{ sessionId: "session-real" }]);

    // Once registered, a later focus-mutating call from this exact session carries the cached secret.
    const { focusSessionFields } = await import("../src/session-identity.js");
    expect(focusSessionFields("session-real")).toEqual({ sessionId: "session-real", sessionSecret: "the-real-secret" });

    await fireEvent(pi, "session_shutdown", {}, ctx);
    expect(releaseCalls).toEqual([{ sessionId: "session-real", sessionSecret: "the-real-secret" }]);
    // Released -- the cache no longer has anything for this session id.
    expect(focusSessionFields("session-real")).toEqual({ sessionId: "session-real" });
  });

  it("session_start's identity registration is best-effort -- a daemon-unavailable failure never throws or blocks the rest of session_start", async () => {
    const pi = fakePi();
    const client = fakeClient({
      "session.register": () => {
        throw new Error("daemon unreachable");
      },
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await expect(fireEvent(pi, "session_start", {}, ctx)).resolves.toBeUndefined();
    // The rest of session_start (the footer status refresh) still ran despite the failed registration.
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("tickets-focus", undefined);
  });

  it("refreshStatus's own focus.get call carries this session's own sessionId, the same as IssueListComponent's", async () => {
    const pi = fakePi();
    const calls: unknown[] = [];
    const client = fakeClient({
      "focus.get": (input) => {
        calls.push(input);
        return { focus: null };
      },
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx(fakeTheme, "session-for-status");
    await fireEvent(pi, "session_start", {}, ctx);

    const getCall = calls.find((c) => (c as { sessionId?: string }).sessionId === "session-for-status");
    expect(getCall).toBeDefined();
  });

  it("tool_execution_end refreshes status only for a real tickets Vehicle tool", async () => {
    const pi = fakePi();
    const client = fakeClient({
      "focus.get": () => ({ focus: { ref: "jira:PROJ-1", title: "x", url: "https://x", status: "paused", updatedAt: "now" } }),
    });
    registerTicketsTui(pi as never, { getClient: async () => client });

    const ctx = fakeCtx();
    await fireEvent(pi, "tool_execution_end", { toolName: "bash" }, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();

    await fireEvent(pi, "tool_execution_end", { toolName: "focus_set" }, ctx);
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
    it("shows one tab per plain backend, and one submenu tab (grouping Issues/Queries/Board) for one with raw-query support", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => MIXED_BACKENDS });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      const outerBar = panel.render(80).join("\n");
      expect(outerBar).toContain("GitHub");
      expect(outerBar).toContain("Jira");
      // The submenu's own three tabs aren't shown at all until Jira itself is active.
      expect(outerBar).not.toContain("Issues");
      expect(outerBar).not.toContain("Queries");
      expect(outerBar).not.toContain("Board");

      panel.handleInput(TAB); // GitHub -> Jira
      const withSubmenu = panel.render(80).join("\n");
      expect(withSubmenu).toContain("Issues");
      expect(withSubmenu).toContain("Queries");
      expect(withSubmenu).toContain("Board");

      panel.handleInput(ESCAPE); // Jira submenu -> home (GitHub)
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("keeps every rendered line at the exact same real (ANSI-stripped) width under genuine theme styling, not a plain fake theme", async () => {
      // The actual regression test for a real bug (confirmed live in
      // pi-packed's identical panel): every other test in this file uses
      // fakeTheme's identity passthrough, which can never exercise a bug
      // that only shows up once content contains real ANSI escape codes --
      // exactly why Envelope needs an explicit ANSI-aware measure, not its
      // own default (raw .length).
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => MIXED_BACKENDS, "ledger.search": () => ({ issues: ISSUES }) });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx(realishTheme);
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const rendered = lastComponent().render(80);

      const widths = new Set(rendered.map((line) => stripAnsi(line).length));
      expect(widths).toEqual(new Set([80])); // every line, every column -- not a mix of widths

      lastComponent().handleInput(ESCAPE);
      await done;
    });

    it("Tab/Shift-Tab cycle provider tabs at the outer level, wrapping at both ends", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => MIXED_BACKENDS });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB); // GitHub -> Jira
      expect(panel.render(80).join("\n")).toContain("Issues"); // Jira's own submenu is now showing
      // Once inside Jira, Tab stays drilled into ITS own three tabs (see the
      // next test) rather than bubbling back out to the outer provider bar --
      // escape (ascend) then Tab is how you get back to cycling providers.
      panel.handleInput(ESCAPE); // Jira (at its own home) -> outer home (GitHub)
      expect(panel.render(80).join("\n")).not.toContain("Issues");
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("once inside Jira's own submenu, Tab/Shift-Tab and Left/Right both cycle ITS three tabs instead of the outer provider bar", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => MIXED_BACKENDS });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      panel.handleInput(TAB); // GitHub -> Jira
      panel.handleInput(TAB); // Jira's own Issues -> Queries (not back out to GitHub)
      expect(panel.render(80).join("\n")).toContain("No saved queries yet for Jira");
      panel.handleInput(RIGHT); // Queries -> Board (Left/Right works the same as Tab one level down)
      expect(panel.render(80).join("\n")).toContain("No saved queries yet for Jira"); // Board's own empty state (no saved query to run)
      panel.handleInput(LEFT); // back to Queries
      panel.handleInput(LEFT); // back to Issues (Jira's own home)
      expect(panel.render(80).join("\n")).toContain("No Jira tickets pooled yet");
      panel.handleInput(ESCAPE); // Jira (at its own home) -> outer home (GitHub)
      panel.handleInput(ESCAPE); // home -- closes
      await done;
    });

    it("a provider mnemonic instantly activates its tab; a submenu mnemonic only resolves once that submenu is already active", async () => {
      const pi = fakePi();
      const client = fakeClient({ "backends.list": () => MIXED_BACKENDS, "ledger.search": () => ({ issues: ISSUES }) });
      registerTicketsTui(pi as never, { getClient: async () => client });

      const ctx = fakeCtx();
      const done = pi.commands.get("tickets")?.handler(undefined, ctx);
      await tick();
      const panel = lastComponent();
      // 'b' (Jira's own Board mnemonic) does nothing from GitHub -- it's scoped
      // to Jira's own submenu, not reachable at the outer level at all.
      panel.handleInput("b");
      expect(panel.render(80).join("\n")).toContain("github:#1");

      panel.handleInput("j"); // jumps straight to Jira
      expect(panel.render(80).join("\n")).toContain("jira:PROJ-1"); // Jira's own home (Issues), pooled issues shown
      panel.handleInput("b"); // now resolves, scoped to the active submenu
      expect(panel.render(80).join("\n")).toContain("No saved queries yet for Jira");

      panel.handleInput("h"); // back to GitHub from anywhere, including mid-submenu
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
      registerTicketsTui(pi as never, {
        getClient: async () => client,
        openSettings: async () => {
          settingsOpened++;
        },
      });

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
          expect(input).toEqual({ ref: "github:#1", sessionId: "test-session" });
          return {
            focus: { ref: "github:#1", title: "First bug", url: "https://github.com/a/b/issues/1", status: "active", updatedAt: "now" },
          };
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
          expect(input).toEqual({ sessionId: "test-session" });
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
        "query.list": () => ({
          queries: [{ name: "short-alias", backend: "jira", query: "...", description: "Human-Readable Board Name" }],
        }),
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
      // A strong assertion, not just "the label is still somewhere on screen"
      // (always true regardless of which tab is active) -- the real
      // regression check for a live bug: a captured Left/Right previously
      // still fell through to TabbedContainer's own cycle-on-arrow handling
      // and silently switched away from the board.
      const afterRight = panel.render(120).join("\n");
      expect(afterRight).toContain("Board: sprint");
      expect(afterRight).toContain("\u2503 Second bug"); // selection marker moved to the 2nd column's card
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

  describe("the panel's real keybindings (mnemonic conflict detection)", () => {
    // Mirrors the real two-level reachable-at-once set: the outer panel's
    // own dispatcher (provider mnemonics + settings), then -- only once
    // Jira is the active provider -- its own submenu dispatcher (i/q/b),
    // then whichever single leaf within THAT submenu is active. Issues, a
    // Saved-queries tab while browsing (it swaps in the exact same
    // IssueListComponent -- see saved-query-view.ts), and a Board tab (its
    // own 'o', see board-view.ts's handleInput) are SIBLING leaves under
    // the submenu -- never simultaneously active, so freely allowed to
    // reuse a key among themselves; only collisions shared with an
    // ancestor (the submenu's own i/q/b, or the outer panel's h/l/j/s)
    // count as real.
    const PANEL_MNEMONIC_TREE: MnemonicContext = {
      name: "panel",
      bindings: [
        { key: "h", description: "jump: GitHub" },
        { key: "l", description: "jump: GitLab" },
        { key: "j", description: "jump: Jira" },
        { key: "s", description: "open settings" },
      ],
      children: [
        {
          name: "Jira's own submenu",
          bindings: [
            { key: "i", description: "jump: Issues" },
            { key: "q", description: "jump: Queries" },
            { key: "b", description: "jump: Board" },
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
            {
              name: "a Saved-queries tab while browsing",
              bindings: [
                { key: "v", description: "view issue detail" },
                { key: "o", description: "open in browser" },
                { key: "r", description: "reload" },
              ],
            },
            {
              name: "a Board tab while showing a board",
              bindings: [{ key: "o", description: "open in browser" }],
            },
          ],
        },
      ],
    };

    it("has zero real conflicts anywhere in the tree", () => {
      expect(() => assertNoMnemonicConflicts(PANEL_MNEMONIC_TREE)).not.toThrow();
    });

    // A deliberately introduced conflict, to prove the check above isn't
    // vacuously passing on an empty or trivial tree.
    it("genuinely detects a conflict when one is deliberately introduced", () => {
      const submenu = PANEL_MNEMONIC_TREE.children![0]!;
      const broken: MnemonicContext = {
        ...PANEL_MNEMONIC_TREE,
        children: [
          {
            ...submenu,
            children: submenu.children!.map((child) =>
              child.name === "a Board tab while showing a board"
                ? { ...child, bindings: [...child.bindings, { key: "j", description: "a fake conflicting Jira-jump binding" }] }
                : child,
            ),
          },
        ],
      };
      expect(() => assertNoMnemonicConflicts(broken)).toThrow();
    });

    it("the submenu's own i/q/b never collide with the outer panel's h/l/j/s", () => {
      const outer = new Set(PANEL_MNEMONIC_TREE.bindings.map((b) => b.key));
      const submenu = PANEL_MNEMONIC_TREE.children![0]!;
      for (const binding of submenu.bindings) expect(outer.has(binding.key)).toBe(false);
    });
  });
});
