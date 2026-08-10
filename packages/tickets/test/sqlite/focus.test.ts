import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { FOCUS_MAX_SCOPES, FOCUS_MIGRATIONS, FocusStore, normalizeFocusScope } from "../../src/sqlite/focus.js";
import { LEDGER_MIGRATIONS } from "../../src/sqlite/ledger.js";
import { SAVED_QUERY_MIGRATIONS } from "../../src/sqlite/saved-queries.js";
import { WATCH_MIGRATIONS } from "../../src/sqlite/watches.js";

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// Migration versions are global across every sqlite/*.ts migration array (see watch-sync.test.ts's
// own comment on this) -- FOCUS_MIGRATIONS' own version 5 comes after saved-queries' 3 and
// watches' 4, so even a store-scoped test needs the full chain, not just ledger+focus.
function makeStore(): FocusStore {
  db = openSqliteWithPragmas(":memory:", {
    migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS, ...WATCH_MIGRATIONS],
  });
  return new FocusStore(db);
}

describe("normalizeFocusScope", () => {
  it('defaults an absent scope to "global" -- the bare CLI / legacy single-focus behavior', () => {
    expect(normalizeFocusScope(undefined)).toBe("global");
  });

  it("defaults an empty string the same way as absent", () => {
    expect(normalizeFocusScope("")).toBe("global");
  });

  it("passes a real scope through unchanged", () => {
    expect(normalizeFocusScope("session-abc")).toBe("session-abc");
  });

  it("rejects a scope longer than the bound rather than silently truncating it", () => {
    expect(() => normalizeFocusScope("x".repeat(129))).toThrow(/scope must be/);
  });
});

describe("FocusStore -- per-scope isolation (session-scoped focus)", () => {
  it("has no focus initially for any scope", () => {
    const store = makeStore();
    expect(store.get()).toBeUndefined();
    expect(store.get("session-a")).toBeUndefined();
  });

  it("set()/get() for one scope is invisible to another scope -- the core behavior this store exists for", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    store.set("jira:PROJ-1", "Second", "https://acme.atlassian.net/browse/PROJ-1", "session-b");

    expect(store.get("session-a")?.ref).toBe("github:#7");
    expect(store.get("session-b")?.ref).toBe("jira:PROJ-1");
  });

  it('an omitted scope on both set() and get() defaults to "global", independent of any real session scope', () => {
    const store = makeStore();
    store.set("session-only:#1", "Scoped", "https://x/1", "session-a");
    expect(store.get()).toBeUndefined();

    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7");
    expect(store.get()?.ref).toBe("github:#7");
    expect(store.get("session-a")?.ref).toBe("session-only:#1");
  });

  it("set() again for the same scope replaces that scope's own focus, without touching any other scope", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    store.set("jira:PROJ-1", "Second", "https://acme.atlassian.net/browse/PROJ-1", "session-b");
    const replaced = store.set("github:#8", "Third", "https://github.com/acme/widgets/issues/8", "session-a");

    expect(store.get("session-a")).toEqual(replaced);
    expect(store.get("session-a")?.ref).toBe("github:#8");
    expect(store.get("session-b")?.ref).toBe("jira:PROJ-1");
  });

  it("switching focus onto a new ref in one scope clears that scope's own prior pause, without touching another scope's pause state", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    store.pause("stepping away", "session-a");
    store.set("jira:PROJ-1", "Other", "https://x/other", "session-b");
    store.pause("elsewhere", "session-b");

    const second = store.set("jira:PROJ-2", "Second", "https://acme.atlassian.net/browse/PROJ-2", "session-a");
    expect(second.status).toBe("active");
    expect(second.pauseReason).toBeUndefined();
    expect(store.get("session-b")?.status).toBe("paused");
  });

  it("pause()/unpause() operate on exactly one scope's own row", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    store.set("jira:PROJ-1", "Other", "https://x/other", "session-b");

    const paused = store.pause("waiting on review", "session-a");
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("waiting on review");
    expect(store.get("session-a")).toEqual(paused);
    expect(store.get("session-b")?.status).toBe("active");

    const resumed = store.unpause("session-a");
    expect(resumed.status).toBe("active");
    expect(resumed.pauseReason).toBeUndefined();
    expect(store.get("session-b")?.status).toBe("active");
  });

  it("pause() throws when nothing is focused in that specific scope, even if another scope has an active focus", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    expect(() => store.pause("reason", "session-b")).toThrow(/no ticket is currently focused/);
  });

  it("pause() without a reason is allowed", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    const paused = store.pause(undefined, "session-a");
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBeUndefined();
  });

  it("pause() throws when already paused, rather than silently double-pausing", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    store.pause(undefined, "session-a");
    expect(() => store.pause(undefined, "session-a")).toThrow(/already paused/);
  });

  it("unpause() throws when nothing is focused in that scope", () => {
    const store = makeStore();
    expect(() => store.unpause("session-a")).toThrow(/no ticket is currently focused/);
  });

  it("unpause() throws when already active", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    expect(() => store.unpause("session-a")).toThrow(/already active/);
  });

  it("clear() removes only the given scope's focus and reports whether one existed there", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    store.set("jira:PROJ-1", "Other", "https://x/other", "session-b");

    expect(store.clear("session-c")).toBe(false);
    expect(store.clear("session-a")).toBe(true);
    expect(store.get("session-a")).toBeUndefined();
    expect(store.get("session-b")?.ref).toBe("jira:PROJ-1");
  });

  it("persists across store instances against the same database, per scope (survives a daemon restart)", () => {
    const database = openSqliteWithPragmas(":memory:", {
      migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS, ...WATCH_MIGRATIONS],
    });
    db = database;
    new FocusStore(database).set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    const reopened = new FocusStore(database);
    expect(reopened.get("session-a")?.ref).toBe("github:#7");
  });

  it("evicts the least-recently-updated scope once beyond FOCUS_MAX_SCOPES, rather than growing unbounded", () => {
    const store = makeStore();
    for (let i = 0; i < FOCUS_MAX_SCOPES; i++) {
      store.set(`github:#${i}`, `Issue ${i}`, `https://x/${i}`, `session-${i}`);
    }
    // session-0 is now the least-recently-updated scope; one more distinct scope should evict it.
    store.set("github:#extra", "Extra", "https://x/extra", "session-extra");

    expect(store.get("session-0")).toBeUndefined();
    expect(store.get("session-extra")?.ref).toBe("github:#extra");
    expect(store.get(`session-${FOCUS_MAX_SCOPES - 1}`)?.ref).toBe(`github:#${FOCUS_MAX_SCOPES - 1}`);
  });

  it("re-setting an existing scope never evicts anything, even already at the cap", () => {
    const store = makeStore();
    for (let i = 0; i < FOCUS_MAX_SCOPES; i++) {
      store.set(`github:#${i}`, `Issue ${i}`, `https://x/${i}`, `session-${i}`);
    }
    store.set("github:#0-updated", "Issue 0 updated", "https://x/0-updated", "session-0");

    expect(store.get("session-0")?.ref).toBe("github:#0-updated");
    expect(store.get("session-1")?.ref).toBe("github:#1");
  });

  it("reapStale(olderThanIso) deletes only scopes whose updatedAt is strictly before the cutoff, across every scope", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-old");
    const cutoff = new Date(Date.now() + 1000).toISOString();
    store.set("github:#8", "Second", "https://github.com/acme/widgets/issues/8", "session-new");
    // session-new's updatedAt is real "now", strictly before an artificial future cutoff too --
    // reapStale is purely a timestamp comparison, so both are removed by a cutoff this far ahead.
    const removed = store.reapStale(cutoff);
    expect(removed).toBe(2);
    expect(store.get("session-old")).toBeUndefined();
    expect(store.get("session-new")).toBeUndefined();
  });

  it("reapStale(olderThanIso) leaves a scope untouched when its updatedAt is at or after the cutoff", () => {
    const store = makeStore();
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7", "session-a");
    const removed = store.reapStale(past);
    expect(removed).toBe(0);
    expect(store.get("session-a")?.ref).toBe("github:#7");
  });
});
