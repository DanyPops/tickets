import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { TicketService } from "../../src/application/service.js";
import { LEDGER_MIGRATIONS, Ledger } from "../../src/daemon/ledger.js";
import { createSyncTask, syncOnce } from "../../src/daemon/poller.js";
import { FakeRepository } from "../support/fake-repository.js";

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("syncOnce", () => {
  it("pools every configured backend into the ledger in one pass", async () => {
    db = openSqliteWithPragmas(":memory:", { migrations: LEDGER_MIGRATIONS });
    const ledger = new Ledger(db);
    const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "A", status: "todo", priority: "none" }]);
    const jira = new FakeRepository("jira", [{ ref: "jira:PROJ-1", id: "1", key: "PROJ-1", title: "B", status: "todo", priority: "none" }]);
    const service = new TicketService({ github, jira });

    const results = await syncOnce(service, ledger, ["github", "jira"]);

    expect(results).toEqual([
      { backend: "github", synced: 1 },
      { backend: "jira", synced: 1 },
    ]);
    expect(ledger.stats().sort((a, b) => a.backend.localeCompare(b.backend))).toEqual([
      { backend: "github", count: 1 },
      { backend: "jira", count: 1 },
    ]);
  });

  it("prefers a backend's own expanded sync scope (SyncScopeExpandable) over its plain default-project list()", async () => {
    db = openSqliteWithPragmas(":memory:", { migrations: LEDGER_MIGRATIONS });
    const ledger = new Ledger(db);
    const jira = new FakeRepository("jira", [
      { ref: "jira:WIDGET-1", id: "1", key: "WIDGET-1", title: "default project issue", status: "todo", priority: "none" },
      { ref: "jira:ENG-1", id: "2", key: "ENG-1", title: "eng issue", status: "todo", priority: "none" },
    ]);
    // FakeRepository.runQuery treats its query arg as a plain substring title
    // filter, unlike real JQL -- "issue" matches both seeded titles, so this
    // proves syncOnce routed through runQuery (real JQL would use a project
    // list -- see jira.ts's real buildSyncQuery()), not that a real JQL
    // string matches by substring.
    jira.syncQuery = "issue";
    const service = new TicketService({ jira });

    await syncOnce(service, ledger, ["jira"]);

    expect(jira.lastRunQueryCall).toEqual({ query: "issue", limit: 50 });
    expect(jira.lastListCall).toBeUndefined();
    expect(ledger.stats()).toEqual([{ backend: "jira", count: 2 }]);
  });

  it("a failing backend is reported and skipped, other backends still sync", async () => {
    db = openSqliteWithPragmas(":memory:", { migrations: LEDGER_MIGRATIONS });
    const ledger = new Ledger(db);
    const broken = new FakeRepository("broken");
    broken.list = async () => {
      throw new Error("rate limited");
    };
    const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "A", status: "todo", priority: "none" }]);
    const service = new TicketService({ broken, github });

    const results = await syncOnce(service, ledger, ["broken", "github"]);

    expect(results[0]).toEqual({ backend: "broken", synced: 0, error: "rate limited" });
    expect(results[1]).toEqual({ backend: "github", synced: 1 });
    expect(ledger.stats()).toEqual([{ backend: "github", count: 1 }]);
  });
});

describe("createSyncTask", () => {
  it("reads the backend list fresh on every run — a backend added after the task was created is synced on its next tick", async () => {
    db = openSqliteWithPragmas(":memory:", { migrations: LEDGER_MIGRATIONS });
    const ledger = new Ledger(db);
    const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "A", status: "todo", priority: "none" }]);
    const service = new TicketService({ github });
    const task = createSyncTask(service, ledger, 60_000);

    await task.run();
    expect(ledger.stats()).toEqual([{ backend: "github", count: 1 }]);

    const jira = new FakeRepository("jira", [{ ref: "jira:PROJ-1", id: "1", key: "PROJ-1", title: "B", status: "todo", priority: "none" }]);
    service.setRepos({ github, jira });

    await task.run();
    expect(ledger.stats().sort((a, b) => a.backend.localeCompare(b.backend))).toEqual([
      { backend: "github", count: 1 },
      { backend: "jira", count: 1 },
    ]);
  });
});
