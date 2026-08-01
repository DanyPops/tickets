import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { FOCUS_MIGRATIONS } from "../../src/daemon/focus.js";
import { LEDGER_MIGRATIONS } from "../../src/daemon/ledger.js";
import { SAVED_QUERY_MIGRATIONS, SavedQueryStore } from "../../src/daemon/saved-queries.js";

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// Migration versions are sequential across the whole daemon schema (see bootstrap.ts),
// not scoped per-table -- SAVED_QUERY_MIGRATIONS alone starts at version 3, so a
// standalone harness needs the same full migration chain bootstrap.ts always applies.
function harness(): SavedQueryStore {
  db = openSqliteWithPragmas(":memory:", { migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS] });
  return new SavedQueryStore(db);
}

describe("SavedQueryStore", () => {
  it("save() then get() round-trips a saved query", () => {
    const store = harness();
    const saved = store.save("bmptemp-sprint", "jira", "project = BMPTEMP AND sprint in openSprints()", "QE Scrum Board - Active Sprint");
    expect(saved.name).toBe("bmptemp-sprint");
    expect(saved.backend).toBe("jira");
    expect(saved.query).toBe("project = BMPTEMP AND sprint in openSprints()");
    expect(saved.description).toBe("QE Scrum Board - Active Sprint");

    const got = store.get("bmptemp-sprint");
    expect(got).toEqual(saved);
  });

  it("get() returns undefined for a name that was never saved", () => {
    const store = harness();
    expect(store.get("nope")).toBeUndefined();
  });

  it("save() under an existing name updates it in place, preserving the original createdAt", () => {
    const store = harness();
    const first = store.save("q1", "jira", "project = A");
    const second = store.save("q1", "jira", "project = B", "updated description");
    expect(second.query).toBe("project = B");
    expect(second.description).toBe("updated description");
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.list()).toHaveLength(1);
  });

  it("list() returns every saved query, sorted by name", () => {
    const store = harness();
    store.save("zeta", "jira", "project = Z");
    store.save("alpha", "jira", "project = A");
    expect(store.list().map((q) => q.name)).toEqual(["alpha", "zeta"]);
  });

  it("remove() deletes a saved query and returns true", () => {
    const store = harness();
    store.save("q1", "jira", "project = A");
    expect(store.remove("q1")).toBe(true);
    expect(store.get("q1")).toBeUndefined();
  });

  it("remove() on a name that doesn't exist is a no-op, returns false, not an error", () => {
    const store = harness();
    expect(store.remove("nope")).toBe(false);
  });
});
