import { describe, expect, it } from "bun:test";
import type { VehicleClient } from "@danypops/vehicle-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WatchEventsPoll } from "../src/watch-events-poll.ts";

interface FakeInvocation {
  name: string;
  version: number;
  input: unknown;
  options: unknown;
}

function fakeClient(results: unknown[]): { client: VehicleClient; calls: FakeInvocation[] } {
  const calls: FakeInvocation[] = [];
  let i = 0;
  const client: VehicleClient = {
    manifest: async () => ({ name: "tickets", version: "1.0.0", description: "", operations: [] }),
    invoke: async (name: string, version: number, input: unknown, options?: unknown) => {
      calls.push({ name, version, input, options });
      const result = results[Math.min(i, results.length - 1)];
      i++;
      return result as never;
    },
    close: async () => {},
  };
  return { client, calls };
}

function fakeSendMessage(): { pi: ExtensionAPI; sent: Array<{ content: unknown; options: unknown }> } {
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const pi = { sendMessage: (content: unknown, options: unknown) => sent.push({ content, options }) } as unknown as ExtensionAPI;
  return { pi, sent };
}

describe("WatchEventsPoll", () => {
  it("primes the cursor on its very first tick without delivering anything, even if events already exist", async () => {
    const { client, calls } = fakeClient([
      { events: [{ id: 5, kind: "issue", key: "github:#1", message: "status changed", createdAt: "x" }], lastId: 5 },
    ]);
    const { pi, sent } = fakeSendMessage();
    const poll = new WatchEventsPoll({ client, pi, subscriberId: "session-a", permissions: ["tickets:read"] });

    await poll.tick();

    expect(sent).toEqual([]);
    expect(calls[0]).toMatchObject({ name: "watch.events", version: 1, input: { subscriberId: "session-a", sinceId: undefined } });
  });

  it("delivers each new event via pi.sendMessage as a gentle followUp, once the cursor is primed", async () => {
    const { client } = fakeClient([
      { events: [], lastId: 5 },
      { events: [{ id: 6, kind: "issue", key: "github:#1", message: "github:#1 (Bug): status: todo -> done", createdAt: "x" }], lastId: 6 },
    ]);
    const { pi, sent } = fakeSendMessage();
    const poll = new WatchEventsPoll({ client, pi, subscriberId: "session-a", permissions: ["tickets:read"] });

    await poll.tick(); // primes
    await poll.tick(); // delivers

    expect(sent).toEqual([
      {
        content: { customType: "pi-tickets:watch-event", content: "[pi-tickets] github:#1 (Bug): status: todo -> done", display: true },
        options: { deliverAs: "followUp" },
      },
    ]);
  });

  it("advances sinceId to the server's own lastId, threading it into the next call", async () => {
    const { client, calls } = fakeClient([
      { events: [], lastId: 0 },
      { events: [], lastId: 7 },
    ]);
    const { pi } = fakeSendMessage();
    const poll = new WatchEventsPoll({ client, pi, subscriberId: "session-a", permissions: [] });

    await poll.tick();
    await poll.tick();

    expect(calls[1]?.input).toEqual({ subscriberId: "session-a", sinceId: 0 });
  });

  it("delivers every event from one tick's batch, in order", async () => {
    const { client } = fakeClient([
      { events: [], lastId: 0 },
      {
        events: [
          { id: 1, kind: "issue", key: "github:#1", message: "first", createdAt: "x" },
          { id: 2, kind: "query", key: "my-bugs", message: "second", createdAt: "x" },
        ],
        lastId: 2,
      },
    ]);
    const { pi, sent } = fakeSendMessage();
    const poll = new WatchEventsPoll({ client, pi, subscriberId: "session-a", permissions: [] });

    await poll.tick();
    await poll.tick();

    expect(sent.map((s) => (s.content as { content: string }).content)).toEqual(["[pi-tickets] first", "[pi-tickets] second"]);
  });

  it("never throws when the client rejects -- a transient daemon hiccup must not crash the extension host", async () => {
    const client: VehicleClient = {
      manifest: async () => ({ name: "tickets", version: "1.0.0", description: "", operations: [] }),
      invoke: async () => {
        throw new Error("daemon unreachable");
      },
      close: async () => {},
    };
    const { pi, sent } = fakeSendMessage();
    const poll = new WatchEventsPoll({ client, pi, subscriberId: "session-a", permissions: [] });

    await expect(poll.tick()).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("a failed tick never primes the cursor -- the next successful tick still primes rather than replaying", async () => {
    let shouldFail = true;
    const calls: FakeInvocation[] = [];
    const client: VehicleClient = {
      manifest: async () => ({ name: "tickets", version: "1.0.0", description: "", operations: [] }),
      invoke: async (name: string, version: number, input: unknown, options?: unknown) => {
        calls.push({ name, version, input, options });
        if (shouldFail) throw new Error("daemon unreachable");
        return { events: [{ id: 1, kind: "issue", key: "github:#1", message: "changed", createdAt: "x" }], lastId: 1 } as never;
      },
      close: async () => {},
    };
    const { pi, sent } = fakeSendMessage();
    const poll = new WatchEventsPoll({ client, pi, subscriberId: "session-a", permissions: [] });

    await poll.tick(); // fails
    shouldFail = false;
    await poll.tick(); // succeeds -- this is really the first successful tick, so it primes, doesn't deliver

    expect(calls[1]?.input).toMatchObject({ sinceId: undefined });
    expect(sent).toEqual([]);
  });

  it("start()/stop() are idempotent and start() ticks immediately without waiting for the first interval", async () => {
    const { client, calls } = fakeClient([{ events: [], lastId: 0 }]);
    const { pi } = fakeSendMessage();
    const poll = new WatchEventsPoll({ client, pi, subscriberId: "session-a", permissions: [], intervalMs: 60_000 });

    poll.start();
    poll.start(); // no-op, not a second timer
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);

    poll.stop();
    poll.stop(); // no-op
  });

  it("forwards the given permissions on every call", async () => {
    const { client, calls } = fakeClient([{ events: [], lastId: 0 }]);
    const { pi } = fakeSendMessage();
    const poll = new WatchEventsPoll({ client, pi, subscriberId: "session-a", permissions: ["tickets:read", "tickets:write"] });

    await poll.tick();

    expect(calls[0]?.options).toEqual({ permissions: ["tickets:read", "tickets:write"] });
  });
});
