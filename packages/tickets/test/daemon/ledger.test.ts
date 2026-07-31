import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { Ledger, LEDGER_MIGRATIONS } from "../../src/daemon/ledger.js";
import type { Issue } from "../../src/domain/issue.js";

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeLedger(): Ledger {
  db = openSqliteWithPragmas(":memory:", { migrations: LEDGER_MIGRATIONS });
  return new Ledger(db);
}

function issue(key: string, title: string, overrides: Partial<Issue> = {}): Issue {
  return { ref: `github:${key}`, id: key, key, title, status: "todo", priority: "none", ...overrides };
}

describe("Ledger", () => {
  it("upsert then get round-trips the full issue, not just indexed columns", () => {
    const ledger = makeLedger();
    ledger.upsert("github", issue("#1", "Fix the thing", { assignee: "alice", labels: ["bug"] }));
    const got = ledger.get("github:#1");
    expect(got?.assignee).toBe("alice");
    expect(got?.labels).toEqual(["bug"]);
  });

  it("upsert on the same ref replaces rather than duplicates", () => {
    const ledger = makeLedger();
    ledger.upsert("github", issue("#1", "Original title"));
    ledger.upsert("github", issue("#1", "Updated title"));
    expect(ledger.get("github:#1")?.title).toBe("Updated title");
    expect(ledger.listByBackend("github")).toHaveLength(1);
  });

  it("upsertMany populates the ledger from a list() sync pass", () => {
    const ledger = makeLedger();
    const count = ledger.upsertMany("jira", [issue("PROJ-1", "One"), issue("PROJ-2", "Two")]);
    expect(count).toBe(2);
    expect(ledger.listByBackend("jira")).toHaveLength(2);
  });

  it("search finds by title substring, bounded by limit", () => {
    const ledger = makeLedger();
    ledger.upsertMany("github", [issue("#1", "Fix login bug"), issue("#2", "Fix logout bug"), issue("#3", "Unrelated")]);
    const results = ledger.search("Fix", 1);
    expect(results).toHaveLength(1);
    expect(ledger.search("Fix", 10)).toHaveLength(2);
  });

  it("search scopes to one backend when given, ignoring title matches on other backends", () => {
    const ledger = makeLedger();
    ledger.upsertMany("github", [issue("#1", "Fix login bug")]);
    ledger.upsertMany("jira", [{ ...issue("PROJ-1", "Fix login bug"), ref: "jira:PROJ-1" }]);
    expect(ledger.search("Fix", 10)).toHaveLength(2);
    const scoped = ledger.search("Fix", 10, "jira");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.ref).toBe("jira:PROJ-1");
  });

  it("search limit is hard-capped even when a caller asks for more", () => {
    const ledger = makeLedger();
    const many = Array.from({ length: 10 }, (_, i) => issue(`#${i}`, `Item ${i}`));
    ledger.upsertMany("github", many);
    expect(ledger.search("Item", 100_000).length).toBeLessThanOrEqual(200);
  });

  it("stats groups counts per backend", () => {
    const ledger = makeLedger();
    ledger.upsertMany("github", [issue("#1", "A"), issue("#2", "B")]);
    ledger.upsertMany("jira", [issue("PROJ-1", "C")]);
    expect(ledger.stats()).toEqual([
      { backend: "github", count: 2 },
      { backend: "jira", count: 1 },
    ]);
  });

  it("get() returns undefined for a ref the ledger has never seen", () => {
    const ledger = makeLedger();
    expect(ledger.get("github:#404")).toBeUndefined();
  });
});
