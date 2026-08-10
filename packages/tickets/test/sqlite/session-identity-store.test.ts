import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { FOCUS_MIGRATIONS } from "../../src/sqlite/focus.js";
import { LEDGER_MIGRATIONS } from "../../src/sqlite/ledger.js";
import { SAVED_QUERY_MIGRATIONS } from "../../src/sqlite/saved-queries.js";
import { SESSION_IDENTITY_MIGRATIONS, SqliteSessionIdentityStore } from "../../src/sqlite/session-identity.js";
import { WATCH_MIGRATIONS } from "../../src/sqlite/watches.js";

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeStore(): SqliteSessionIdentityStore {
  db = openSqliteWithPragmas(":memory:", {
    migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS, ...WATCH_MIGRATIONS, ...SESSION_IDENTITY_MIGRATIONS],
  });
  return new SqliteSessionIdentityStore(db);
}

describe("SqliteSessionIdentityStore", () => {
  it("find() returns undefined for a session id never registered", () => {
    const store = makeStore();
    expect(store.find("session-a")).toBeUndefined();
  });

  it("upsert() then find() round-trips a record exactly", () => {
    const store = makeStore();
    store.upsert({
      sessionId: "session-a",
      secretHash: "hash-1",
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    expect(store.find("session-a")).toEqual({
      sessionId: "session-a",
      secretHash: "hash-1",
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("upsert() under an existing session id replaces the record in place (re-registration rotates the secret)", () => {
    const store = makeStore();
    store.upsert({
      sessionId: "session-a",
      secretHash: "hash-1",
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    store.upsert({
      sessionId: "session-a",
      secretHash: "hash-2",
      registeredAt: "2026-01-02T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    });
    expect(store.find("session-a")?.secretHash).toBe("hash-2");
    expect(store.count()).toBe(1);
  });

  it("remove() deletes the record; a second remove() is a harmless no-op", () => {
    const store = makeStore();
    store.upsert({ sessionId: "session-a", secretHash: "hash-1", registeredAt: "now", lastSeenAt: "now" });
    store.remove("session-a");
    expect(store.find("session-a")).toBeUndefined();
    expect(() => store.remove("session-a")).not.toThrow();
  });

  it("touch() updates only lastSeenAt, leaving every other field untouched", () => {
    const store = makeStore();
    store.upsert({
      sessionId: "session-a",
      secretHash: "hash-1",
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    store.touch("session-a", "2026-06-01T00:00:00.000Z");
    expect(store.find("session-a")).toEqual({
      sessionId: "session-a",
      secretHash: "hash-1",
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("count() reports the total number of registered sessions", () => {
    const store = makeStore();
    expect(store.count()).toBe(0);
    store.upsert({ sessionId: "session-a", secretHash: "h", registeredAt: "now", lastSeenAt: "now" });
    store.upsert({ sessionId: "session-b", secretHash: "h", registeredAt: "now", lastSeenAt: "now" });
    expect(store.count()).toBe(2);
  });

  it("persists across store instances against the same database (survives a daemon restart)", () => {
    const database = openSqliteWithPragmas(":memory:", {
      migrations: [
        ...LEDGER_MIGRATIONS,
        ...FOCUS_MIGRATIONS,
        ...SAVED_QUERY_MIGRATIONS,
        ...WATCH_MIGRATIONS,
        ...SESSION_IDENTITY_MIGRATIONS,
      ],
    });
    db = database;
    new SqliteSessionIdentityStore(database).upsert({ sessionId: "session-a", secretHash: "h", registeredAt: "now", lastSeenAt: "now" });
    expect(new SqliteSessionIdentityStore(database).find("session-a")?.secretHash).toBe("h");
  });
});
