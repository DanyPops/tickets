import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openSqliteWithPragmas } from "@danypops/daemon-kit/storage";
import { LEDGER_MIGRATIONS } from "../../src/daemon/ledger.js";
import { FOCUS_MIGRATIONS, FocusStore } from "../../src/daemon/focus.js";

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeStore(): FocusStore {
  db = openSqliteWithPragmas(":memory:", { migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS] });
  return new FocusStore(db);
}

describe("FocusStore", () => {
  it("has no focus initially", () => {
    const store = makeStore();
    expect(store.get()).toBeUndefined();
  });

  it("set() stores ref, title, and full url, landing active", () => {
    const store = makeStore();
    const focus = store.set("github:#7", "Fix the thing", "https://github.com/acme/widgets/issues/7");
    expect(focus).toEqual({
      ref: "github:#7",
      title: "Fix the thing",
      url: "https://github.com/acme/widgets/issues/7",
      status: "active",
      updatedAt: focus.updatedAt,
    });
    expect(store.get()).toEqual(focus);
  });

  it("set() again replaces the singleton rather than erroring — only one ticket is ever focused", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7");
    const second = store.set("jira:PROJ-1", "Second", "https://acme.atlassian.net/browse/PROJ-1");
    expect(store.get()).toEqual(second);
    expect(store.get()?.ref).toBe("jira:PROJ-1");
  });

  it("switching focus onto a new ref clears any prior pause — pausing one ticket must never leak into the next", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7");
    store.pause("stepping away");
    const second = store.set("jira:PROJ-1", "Second", "https://acme.atlassian.net/browse/PROJ-1");
    expect(second.status).toBe("active");
    expect(second.pauseReason).toBeUndefined();
  });

  it("pause() records a reason and flips status to paused", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7");
    const paused = store.pause("waiting on review");
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("waiting on review");
    expect(store.get()).toEqual(paused);
  });

  it("pause() without a reason is allowed", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7");
    const paused = store.pause();
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBeUndefined();
  });

  it("pause() throws when nothing is focused", () => {
    const store = makeStore();
    expect(() => store.pause()).toThrow(/no ticket is currently focused/);
  });

  it("pause() throws when already paused, rather than silently double-pausing", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7");
    store.pause();
    expect(() => store.pause()).toThrow(/already paused/);
  });

  it("unpause() flips status back to active and drops the pause reason", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7");
    store.pause("waiting on review");
    const resumed = store.unpause();
    expect(resumed.status).toBe("active");
    expect(resumed.pauseReason).toBeUndefined();
  });

  it("unpause() throws when nothing is focused", () => {
    const store = makeStore();
    expect(() => store.unpause()).toThrow(/no ticket is currently focused/);
  });

  it("unpause() throws when already active", () => {
    const store = makeStore();
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7");
    expect(() => store.unpause()).toThrow(/already active/);
  });

  it("clear() removes the focus and reports whether one existed", () => {
    const store = makeStore();
    expect(store.clear()).toBe(false);
    store.set("github:#7", "First", "https://github.com/acme/widgets/issues/7");
    expect(store.clear()).toBe(true);
    expect(store.get()).toBeUndefined();
  });

  it("persists across store instances against the same database (survives a daemon restart)", () => {
    const database = openSqliteWithPragmas(":memory:", { migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS] });
    db = database;
    new FocusStore(database).set("github:#7", "First", "https://github.com/acme/widgets/issues/7");
    const reopened = new FocusStore(database);
    expect(reopened.get()?.ref).toBe("github:#7");
  });
});
