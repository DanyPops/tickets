import { describe, expect, it } from "bun:test";
import type { TicketsRpcClient } from "@danypops/tickets";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { FocusOverlay } from "../src/focus-overlay.ts";

function fakeClient(call: (op: string, input: unknown) => Promise<unknown>): TicketsRpcClient {
  return { call: call as TicketsRpcClient["call"] } as unknown as TicketsRpcClient;
}

function focusClient(focus: unknown, calls: unknown[] = []): TicketsRpcClient {
  return fakeClient(async (op, input) => {
    if (op !== "focus.get") throw new Error(`unexpected op ${op}`);
    calls.push(input);
    return { focus };
  });
}

describe("FocusOverlay", () => {
  it("registers the widget once refresh() finds a real focus", async () => {
    let registeredKey: string | undefined;
    const uiCtx = {
      setWidget: (key: string, factory: unknown) => {
        if (factory !== undefined) registeredKey = key;
      },
    } as unknown as ExtensionUIContext;

    const overlay = new FocusOverlay(focusClient({ ref: "jira:CNF-1", title: "x", url: "https://x", status: "active" }), "session-1");
    overlay.setUI(uiCtx);
    await overlay.refresh();

    expect(registeredKey).toBeDefined();
  });

  it("hides (unregisters) the widget once refresh() finds no focus at all", async () => {
    let focus: unknown = { ref: "jira:CNF-1", title: "x", url: "https://x", status: "active" };
    const setWidgetCalls: unknown[] = [];
    const uiCtx = { setWidget: (_key: string, factory: unknown) => setWidgetCalls.push(factory) } as unknown as ExtensionUIContext;

    const overlay = new FocusOverlay(
      fakeClient(async () => ({ focus })),
      "session-1",
    );
    overlay.setUI(uiCtx);
    await overlay.refresh();
    expect(setWidgetCalls.at(-1)).toBeDefined();

    focus = null;
    await overlay.refresh();
    expect(setWidgetCalls.at(-1)).toBeUndefined();
  });

  it("carries this overlay's own sessionId on every focus.get call", async () => {
    const calls: unknown[] = [];
    const overlay = new FocusOverlay(focusClient(null, calls), "session-for-focus");
    overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);
    await overlay.refresh();
    expect(calls).toEqual([{ sessionId: "session-for-focus" }]);
  });

  it("never throws, even when the daemon is unreachable or rendering itself fails", async () => {
    const overlay = new FocusOverlay(
      fakeClient(async () => {
        throw new Error("daemon unavailable");
      }),
      "session-1",
    );
    overlay.setUI({} as ExtensionUIContext);
    await expect(overlay.refresh()).resolves.toBeUndefined();
  });

  it("does nothing (no throw) when refresh() is called before setUI()", async () => {
    const overlay = new FocusOverlay(focusClient({ ref: "jira:CNF-1", title: "x", url: "https://x", status: "active" }), "session-1");
    await expect(overlay.refresh()).resolves.toBeUndefined();
  });

  it("startPolling/stopPolling/dispose manage a bounded fallback poll, same as every other overlay in this ecosystem", async () => {
    let calls = 0;
    const overlay = new FocusOverlay(
      fakeClient(async () => {
        calls += 1;
        return { focus: null };
      }),
      "session-1",
    );
    overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);

    overlay.startPolling(5);
    await new Promise((resolve) => setTimeout(resolve, 25));
    overlay.stopPolling();
    const callsAfterStop = calls;
    expect(callsAfterStop).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toBe(callsAfterStop);

    overlay.dispose();
  });

  it("dispose() unregisters the widget and stops polling", async () => {
    const setWidgetCalls: unknown[] = [];
    const uiCtx = { setWidget: (_key: string, factory: unknown) => setWidgetCalls.push(factory) } as unknown as ExtensionUIContext;
    const overlay = new FocusOverlay(focusClient({ ref: "jira:CNF-1", title: "x", url: "https://x", status: "active" }), "session-1");
    overlay.setUI(uiCtx);
    await overlay.refresh();
    expect(setWidgetCalls.at(-1)).toBeDefined();

    overlay.dispose();
    expect(setWidgetCalls.at(-1)).toBeUndefined();
  });
});
