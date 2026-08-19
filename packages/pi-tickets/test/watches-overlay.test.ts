import { describe, expect, it } from "bun:test";
import type { VehicleClient } from "@danypops/vehicle-core";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { WatchesOverlay } from "../src/watches-overlay.ts";

function fakeClient(invoke: (name: string) => Promise<unknown>): VehicleClient {
  return {
    async manifest() {
      return { name: "tickets", version: "0.0.0", description: "", operations: [] };
    },
    invoke: invoke as VehicleClient["invoke"],
    async close() {},
  } as unknown as VehicleClient;
}

function watchesClient(issueWatches: unknown[], queryWatches: unknown[]): VehicleClient {
  return fakeClient(async (name: string) => {
    if (name === "issue.subscribed") return { watches: issueWatches };
    if (name === "query.subscribed") return { watches: queryWatches };
    throw new Error(`unexpected operation ${name}`);
  });
}

describe("WatchesOverlay", () => {
  it("registers the widget once refresh() finds at least one watch", async () => {
    let registeredKey: string | undefined;
    const uiCtx = {
      setWidget: (key: string, factory: unknown) => {
        if (factory !== undefined) registeredKey = key;
      },
    } as unknown as ExtensionUIContext;

    const overlay = new WatchesOverlay(watchesClient([{ ref: "jira:CNF-1" }], []), []);
    overlay.setUI(uiCtx);
    await overlay.refresh();

    expect(registeredKey).toBeDefined();
  });

  it("hides (unregisters) the widget once refresh() finds no watches at all", async () => {
    let issueWatches: unknown[] = [{ ref: "jira:CNF-1" }];
    const setWidgetCalls: unknown[] = [];
    const uiCtx = { setWidget: (_key: string, factory: unknown) => setWidgetCalls.push(factory) } as unknown as ExtensionUIContext;

    const overlay = new WatchesOverlay(
      fakeClient(async (name: string) => (name === "issue.subscribed" ? { watches: issueWatches } : { watches: [] })),
      [],
    );
    overlay.setUI(uiCtx);
    await overlay.refresh();
    expect(setWidgetCalls.at(-1)).toBeDefined();

    issueWatches = [];
    await overlay.refresh();
    expect(setWidgetCalls.at(-1)).toBeUndefined();
  });

  it("never throws, even when the daemon is unreachable or rendering itself fails", async () => {
    const overlay = new WatchesOverlay(
      fakeClient(async () => {
        throw new Error("daemon unavailable");
      }),
      [],
    );
    overlay.setUI({} as ExtensionUIContext);
    await expect(overlay.refresh()).resolves.toBeUndefined();
  });

  it("does nothing (no throw) when refresh() is called before setUI()", async () => {
    const overlay = new WatchesOverlay(watchesClient([{ ref: "jira:CNF-1" }], []), []);
    await expect(overlay.refresh()).resolves.toBeUndefined();
  });

  it("startPolling/stopPolling/dispose manage a bounded fallback poll, same as every other overlay in this ecosystem", async () => {
    let calls = 0;
    const overlay = new WatchesOverlay(
      fakeClient(async () => {
        calls += 1;
        return { watches: [] };
      }),
      [],
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
    const overlay = new WatchesOverlay(watchesClient([{ ref: "jira:CNF-1" }], []), []);
    overlay.setUI(uiCtx);
    await overlay.refresh();
    expect(setWidgetCalls.at(-1)).toBeDefined();

    overlay.dispose();
    expect(setWidgetCalls.at(-1)).toBeUndefined();
  });
});
