import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { TicketService } from "../../src/issue/service.js";
import { syncIssueWatches, syncQueryWatches } from "../../src/process/watch-sync.js";
import { FOCUS_MIGRATIONS } from "../../src/sqlite/focus.js";
import { LEDGER_MIGRATIONS } from "../../src/sqlite/ledger.js";
import { SAVED_QUERY_MIGRATIONS, SavedQueryStore } from "../../src/sqlite/saved-queries.js";
import { WATCH_MIGRATIONS, WatchStore } from "../../src/sqlite/watches.js";
import { FakeRepository } from "../support/fake-repository.js";

let db: Database | undefined;
let queriesDb: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  queriesDb?.close();
  queriesDb = undefined;
});

// See watches.test.ts's own comment: migration versions are global, so even a store-scoped test
// needs the full chain up to WATCH_MIGRATIONS's own version.
function makeWatches(): WatchStore {
  db = openSqliteWithPragmas(":memory:", {
    migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS, ...WATCH_MIGRATIONS],
  });
  return new WatchStore(db);
}

describe("syncIssueWatches", () => {
  it("does nothing when no issues are watched", async () => {
    const watches = makeWatches();
    const service = new TicketService({});
    await expect(syncIssueWatches(service, watches)).resolves.toBeUndefined();
  });

  it("fetches a watched issue and caches its snapshot, without recording an event on the very first observation", async () => {
    const watches = makeWatches();
    const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "Bug", status: "todo", priority: "none" }]);
    const service = new TicketService({ github });
    watches.subscribeIssue("github:#1");

    await syncIssueWatches(service, watches);

    expect(watches.getIssueSnapshot("github:#1")).toMatchObject({ ref: "github:#1", status: "todo" });
    expect(watches.eventsSince("", 0)).toEqual([]);
  });

  it("records a status-change event once the issue's status actually differs from the last snapshot", async () => {
    const watches = makeWatches();
    const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "Bug", status: "todo", priority: "none" }]);
    const service = new TicketService({ github });
    watches.subscribeIssue("github:#1");

    await syncIssueWatches(service, watches);
    await github.update("#1", { status: "in_progress" });
    const changes: unknown[] = [];
    await syncIssueWatches(service, watches, undefined, (c) => changes.push(c));

    expect(changes).toEqual([{ ref: "github:#1", changes: ["status: todo -> in_progress"] }]);
    const events = watches.eventsSince("", 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain("status: todo -> in_progress");
  });

  it("records a new-comment event once the comment count increases", async () => {
    const watches = makeWatches();
    let comments: Array<{ id: string; body: string }> = [];
    class CommentableRepository extends FakeRepository {
      override async listComments() {
        return comments;
      }
    }
    const github = new CommentableRepository("github", [
      { ref: "github:#1", id: "1", key: "#1", title: "Bug", status: "todo", priority: "none" },
    ]);
    const service = new TicketService({ github });
    watches.subscribeIssue("github:#1");
    await syncIssueWatches(service, watches);

    comments = [{ id: "c1", body: "hi" }];
    const changes: unknown[] = [];
    await syncIssueWatches(service, watches, undefined, (c) => changes.push(c));

    expect(changes).toEqual([{ ref: "github:#1", changes: ["1 new comment"] }]);
  });

  it("never fabricates a comment-count diff for a backend that doesn't support comments at all", async () => {
    const watches = makeWatches();
    class NoCommentsRepository extends FakeRepository {
      override listComments(): never {
        throw new Error("not supported");
      }
    }
    const github = new NoCommentsRepository("github", [
      { ref: "github:#1", id: "1", key: "#1", title: "Bug", status: "todo", priority: "none" },
    ]);
    const service = new TicketService({ github });
    watches.subscribeIssue("github:#1");
    await syncIssueWatches(service, watches);

    await github.update("#1", { title: "Bug (renamed)" });
    const changes: unknown[] = [];
    await syncIssueWatches(service, watches, undefined, (c) => changes.push(c));

    // No status/comment change, and no updatedAt to fall back on (FakeRepository never sets it) -- no event at all.
    expect(changes).toEqual([]);
  });

  it("isolates one ref's fetch failure from the rest of the batch", async () => {
    const watches = makeWatches();
    const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "Bug", status: "todo", priority: "none" }]);
    const service = new TicketService({ github });
    watches.subscribeIssue("github:#does-not-exist");
    watches.subscribeIssue("github:#1");

    await expect(syncIssueWatches(service, watches)).resolves.toBeUndefined();
    expect(watches.getIssueSnapshot("github:#1")).toBeDefined();
    expect(watches.getIssueSnapshot("github:#does-not-exist")).toBeUndefined();
  });

  it("skips a subscription whose schedule hasn't come due yet -- no fetch at all on that tick", async () => {
    const watches = makeWatches();
    const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "Bug", status: "todo", priority: "none" }]);
    const service = new TicketService({ github });
    watches.subscribeIssue("github:#1", { subscriberId: "alice", scheduleMs: 60_000 });

    await syncIssueWatches(service, watches, undefined, undefined, () => 0);
    expect(watches.getIssueSnapshot("github:#1")?.fetchedAt.getTime()).toBe(0);

    // Not due yet.
    await syncIssueWatches(service, watches, undefined, undefined, () => 30_000);
    expect(watches.getIssueSnapshot("github:#1")?.fetchedAt.getTime()).toBe(0);

    // Due now.
    await syncIssueWatches(service, watches, undefined, undefined, () => 61_000);
    expect(watches.getIssueSnapshot("github:#1")?.fetchedAt.getTime()).toBe(61_000);
  });

  it("a ref is checked if ANY of its subscribers is due, and every attached subscriber's lastCheckedAt is refreshed together", async () => {
    const watches = makeWatches();
    const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "Bug", status: "todo", priority: "none" }]);
    const service = new TicketService({ github });
    watches.subscribeIssue("github:#1", { subscriberId: "alice", scheduleMs: 5_000 });
    watches.subscribeIssue("github:#1", { subscriberId: "bob", scheduleMs: 60_000 });

    await syncIssueWatches(service, watches, undefined, undefined, () => 0);
    await syncIssueWatches(service, watches, undefined, undefined, () => 6_000);

    const subs = watches.issueSubscriptions();
    expect(subs.find((s) => s.subscriberId === "alice")?.lastCheckedAt?.getTime()).toBe(6_000);
    expect(subs.find((s) => s.subscriberId === "bob")?.lastCheckedAt?.getTime()).toBe(6_000);
  });
});

describe("syncQueryWatches", () => {
  function makeQueries(): SavedQueryStore {
    // FOCUS_MIGRATIONS' own re-scoping migration is version 5 (after watches' 4) -- see
    // watches.test.ts's own comment on migrations being global, not per-table.
    queriesDb = openSqliteWithPragmas(":memory:", {
      migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS, ...WATCH_MIGRATIONS],
    });
    return new SavedQueryStore(queriesDb);
  }

  it("does nothing when no queries are watched", async () => {
    const watches = makeWatches();
    const queries = makeQueries();
    const service = new TicketService({});
    await expect(syncQueryWatches(service, queries, watches)).resolves.toBeUndefined();
  });

  it("caches the matching ref set on first observation, without recording an event", async () => {
    const watches = makeWatches();
    const queries = makeQueries();
    const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "Bug", status: "todo", priority: "none" }]);
    const service = new TicketService({ github });
    queries.save("my-bugs", "github", "Bug");
    watches.subscribeQuery("my-bugs");

    const changes: unknown[] = [];
    await syncQueryWatches(service, queries, watches, undefined, (c) => changes.push(c));

    expect(watches.getQuerySnapshot("my-bugs")?.refs).toEqual(["github:#1"]);
    expect(changes).toEqual([]);
  });

  it("records an event when a new item starts matching the query", async () => {
    const watches = makeWatches();
    const queries = makeQueries();
    const github = new FakeRepository("github", [
      { ref: "github:#1", id: "1", key: "#1", title: "Bug one", status: "todo", priority: "none" },
    ]);
    const service = new TicketService({ github });
    queries.save("my-bugs", "github", "Bug");
    watches.subscribeQuery("my-bugs", { subscriberId: "alice" });
    await syncQueryWatches(service, queries, watches);

    await github.create({ title: "Bug two" });
    const changes: unknown[] = [];
    await syncQueryWatches(service, queries, watches, undefined, (c) => changes.push(c));

    expect(changes).toEqual([{ name: "my-bugs", added: ["github:FAKE-1"], removed: [] }]);
    const events = watches.eventsSince("alice", 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain("1 new: github:FAKE-1");
  });

  it("records an event when an item stops matching the query", async () => {
    const watches = makeWatches();
    const queries = makeQueries();
    const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "Bug", status: "todo", priority: "none" }]);
    const service = new TicketService({ github });
    queries.save("my-bugs", "github", "Bug");
    watches.subscribeQuery("my-bugs", { subscriberId: "alice" });
    await syncQueryWatches(service, queries, watches);

    await github.update("#1", { title: "Resolved, no longer a bug" });
    const changes: unknown[] = [];
    await syncQueryWatches(service, queries, watches, undefined, (c) => changes.push(c));

    expect(changes).toEqual([{ name: "my-bugs", added: [], removed: ["github:#1"] }]);
  });

  it("logs and skips a watched saved query that was since removed, rather than throwing", async () => {
    const watches = makeWatches();
    const queries = makeQueries();
    const service = new TicketService({});
    watches.subscribeQuery("gone");

    await expect(syncQueryWatches(service, queries, watches)).resolves.toBeUndefined();
  });
});
