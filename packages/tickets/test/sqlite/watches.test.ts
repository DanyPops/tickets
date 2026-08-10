import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { FOCUS_MIGRATIONS } from "../../src/sqlite/focus.js";
import { LEDGER_MIGRATIONS } from "../../src/sqlite/ledger.js";
import { SAVED_QUERY_MIGRATIONS } from "../../src/sqlite/saved-queries.js";
import { WATCH_MIGRATIONS, WatchStore } from "../../src/sqlite/watches.js";

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// Migration versions are global across the whole daemon schema (see storage.ts's runMigrations),
// not restartable per-domain -- even a store-scoped unit test needs the full chain leading up to
// WATCH_MIGRATIONS's own version, exactly like every other sqlite/*.test.ts in this package.
function makeStore(): WatchStore {
  db = openSqliteWithPragmas(":memory:", {
    migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS, ...WATCH_MIGRATIONS],
  });
  return new WatchStore(db);
}

describe("WatchStore: issue watches", () => {
  it("subscribeIssue then isIssueSubscribed round-trips, defaulting subscriberId to ''", () => {
    const watches = makeStore();
    expect(watches.isIssueSubscribed("github:#1")).toBe(false);
    watches.subscribeIssue("github:#1");
    expect(watches.isIssueSubscribed("github:#1")).toBe(true);
    expect(watches.isIssueSubscribed("github:#1", "")).toBe(true);
  });

  it("several subscribers can independently watch the same ref", () => {
    const watches = makeStore();
    watches.subscribeIssue("github:#1", { subscriberId: "alice" });
    watches.subscribeIssue("github:#1", { subscriberId: "bob" });

    expect(watches.isIssueSubscribed("github:#1", "alice")).toBe(true);
    expect(watches.isIssueSubscribed("github:#1", "bob")).toBe(true);
    expect(watches.issueSubscriptions()).toHaveLength(2);
  });

  it("unsubscribeIssue removes only that one subscriber's row, idempotent on a second call", () => {
    const watches = makeStore();
    watches.subscribeIssue("github:#1", { subscriberId: "alice" });
    watches.subscribeIssue("github:#1", { subscriberId: "bob" });

    watches.unsubscribeIssue("github:#1", "alice");
    expect(watches.isIssueSubscribed("github:#1", "alice")).toBe(false);
    expect(watches.isIssueSubscribed("github:#1", "bob")).toBe(true);

    expect(() => watches.unsubscribeIssue("github:#1", "alice")).not.toThrow();
  });

  it("re-subscribing the same (ref, subscriber) updates scheduleMs/projectRoot in place, rather than duplicating", () => {
    const watches = makeStore();
    watches.subscribeIssue("github:#1", { subscriberId: "alice", scheduleMs: 1000 });
    watches.subscribeIssue("github:#1", { subscriberId: "alice", scheduleMs: 5000, projectRoot: "/tmp/proj" });

    const subs = watches.issueSubscriptionsFor("alice");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ ref: "github:#1", scheduleMs: 5000, projectRoot: "/tmp/proj" });
  });

  it("issueSubscriptionsFor scopes to one subscriber only", () => {
    const watches = makeStore();
    watches.subscribeIssue("github:#1", { subscriberId: "alice" });
    watches.subscribeIssue("github:#2", { subscriberId: "bob" });

    expect(watches.issueSubscriptionsFor("alice").map((s) => s.ref)).toEqual(["github:#1"]);
    expect(watches.issueSubscriptionsFor("bob").map((s) => s.ref)).toEqual(["github:#2"]);
  });

  it("markIssueChecked stamps lastCheckedAt for that exact subscription only", () => {
    const watches = makeStore();
    watches.subscribeIssue("github:#1", { subscriberId: "alice" });
    watches.subscribeIssue("github:#1", { subscriberId: "bob" });
    const at = new Date(12345);

    watches.markIssueChecked("github:#1", "alice", at);

    const subs = watches.issueSubscriptions();
    expect(subs.find((s) => s.subscriberId === "alice")?.lastCheckedAt?.getTime()).toBe(12345);
    expect(subs.find((s) => s.subscriberId === "bob")?.lastCheckedAt).toBeUndefined();
  });

  it("issue snapshot get/upsert round-trips every field, including an undefined updatedAt", () => {
    const watches = makeStore();
    expect(watches.getIssueSnapshot("github:#1")).toBeUndefined();

    watches.upsertIssueSnapshot({ ref: "github:#1", status: "todo", commentCount: 2, fetchedAt: new Date(1000) });
    expect(watches.getIssueSnapshot("github:#1")).toEqual({
      ref: "github:#1",
      status: "todo",
      updatedAt: undefined,
      commentCount: 2,
      fetchedAt: new Date(1000),
    });

    watches.upsertIssueSnapshot({
      ref: "github:#1",
      status: "in_progress",
      updatedAt: "2026-01-01T00:00:00Z",
      commentCount: 3,
      fetchedAt: new Date(2000),
    });
    expect(watches.getIssueSnapshot("github:#1")).toEqual({
      ref: "github:#1",
      status: "in_progress",
      updatedAt: "2026-01-01T00:00:00Z",
      commentCount: 3,
      fetchedAt: new Date(2000),
    });
  });
});

describe("WatchStore: query watches", () => {
  it("subscribeQuery/isQuerySubscribed/unsubscribeQuery mirror the issue-watch shape", () => {
    const watches = makeStore();
    expect(watches.isQuerySubscribed("my-bugs")).toBe(false);
    watches.subscribeQuery("my-bugs", { subscriberId: "alice" });
    expect(watches.isQuerySubscribed("my-bugs", "alice")).toBe(true);
    watches.unsubscribeQuery("my-bugs", "alice");
    expect(watches.isQuerySubscribed("my-bugs", "alice")).toBe(false);
  });

  it("query snapshot get/upsert round-trips the refs list", () => {
    const watches = makeStore();
    expect(watches.getQuerySnapshot("my-bugs")).toBeUndefined();

    watches.upsertQuerySnapshot({ name: "my-bugs", refs: ["github:#1", "github:#2"], fetchedAt: new Date(1000) });
    expect(watches.getQuerySnapshot("my-bugs")).toEqual({ name: "my-bugs", refs: ["github:#1", "github:#2"], fetchedAt: new Date(1000) });
  });

  it("queryWatchSubscriptionsFor scopes to one subscriber only", () => {
    const watches = makeStore();
    watches.subscribeQuery("q1", { subscriberId: "alice" });
    watches.subscribeQuery("q2", { subscriberId: "bob" });

    expect(watches.queryWatchSubscriptionsFor("alice").map((s) => s.name)).toEqual(["q1"]);
  });
});

describe("WatchStore: change events", () => {
  it("recordEvent then eventsSince(0) returns it, scoped to a currently-subscribed key", () => {
    const watches = makeStore();
    watches.subscribeIssue("github:#1", { subscriberId: "alice" });

    watches.recordEvent("issue", "github:#1", "status: todo -> done", new Date(1000));

    const events = watches.eventsSince("alice", 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "issue", key: "github:#1", message: "status: todo -> done" });
    expect(events[0]?.id).toBeGreaterThan(0);
  });

  it("eventsSince never returns an event for a key this subscriber never subscribed to", () => {
    const watches = makeStore();
    watches.subscribeIssue("github:#1", { subscriberId: "alice" });
    watches.recordEvent("issue", "github:#1", "changed", new Date(1000));
    watches.recordEvent("issue", "github:#2", "changed", new Date(1000));

    const events = watches.eventsSince("alice", 0);
    expect(events.map((e) => e.key)).toEqual(["github:#1"]);
  });

  it("eventsSince never returns an event for a key this subscriber has since unsubscribed from", () => {
    const watches = makeStore();
    watches.subscribeIssue("github:#1", { subscriberId: "alice" });
    watches.recordEvent("issue", "github:#1", "changed", new Date(1000));
    watches.unsubscribeIssue("github:#1", "alice");

    expect(watches.eventsSince("alice", 0)).toEqual([]);
  });

  it("eventsSince(sinceId) excludes everything at or before the cursor, includes everything after", () => {
    const watches = makeStore();
    watches.subscribeIssue("github:#1", { subscriberId: "alice" });
    watches.recordEvent("issue", "github:#1", "first", new Date(1000));
    const firstId = watches.eventsSince("alice", 0)[0]!.id;
    watches.recordEvent("issue", "github:#1", "second", new Date(2000));

    const events = watches.eventsSince("alice", firstId);
    expect(events.map((e) => e.message)).toEqual(["second"]);
  });

  it("scopes query events the same way, via query_watches", () => {
    const watches = makeStore();
    watches.subscribeQuery("my-bugs", { subscriberId: "alice" });
    watches.recordEvent("query", "my-bugs", "1 new: github:#9", new Date(1000));
    watches.recordEvent("query", "other-query", "irrelevant", new Date(1000));

    const events = watches.eventsSince("alice", 0);
    expect(events.map((e) => e.key)).toEqual(["my-bugs"]);
  });

  it("latestEventId is 0 with no events, and the id of the most recent one otherwise", () => {
    const watches = makeStore();
    expect(watches.latestEventId()).toBe(0);
    watches.subscribeIssue("github:#1");
    watches.recordEvent("issue", "github:#1", "changed", new Date(1000));
    expect(watches.latestEventId()).toBeGreaterThan(0);
  });

  it("eventsSince respects a bounded limit", () => {
    const watches = makeStore();
    watches.subscribeIssue("github:#1", { subscriberId: "alice" });
    for (let i = 0; i < 5; i++) watches.recordEvent("issue", "github:#1", `change ${i}`, new Date(1000 + i));

    expect(watches.eventsSince("alice", 0, 2)).toHaveLength(2);
  });
});
