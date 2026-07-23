import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openSqliteWithPragmas } from "@danypops/daemon-kit/storage";
import { TicketService } from "../../src/application/service.js";
import { Ledger, LEDGER_MIGRATIONS } from "../../src/daemon/ledger.js";
import { syncOnce } from "../../src/daemon/poller.js";
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
    const github = new FakeRepository("github", [
      { ref: "github:#1", id: "1", key: "#1", title: "A", status: "todo", priority: "none" },
    ]);
    const jira = new FakeRepository("jira", [
      { ref: "jira:PROJ-1", id: "1", key: "PROJ-1", title: "B", status: "todo", priority: "none" },
    ]);
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

  it("a failing backend is reported and skipped, other backends still sync", async () => {
    db = openSqliteWithPragmas(":memory:", { migrations: LEDGER_MIGRATIONS });
    const ledger = new Ledger(db);
    const broken = new FakeRepository("broken");
    broken.list = async () => {
      throw new Error("rate limited");
    };
    const github = new FakeRepository("github", [
      { ref: "github:#1", id: "1", key: "#1", title: "A", status: "todo", priority: "none" },
    ]);
    const service = new TicketService({ broken, github });

    const results = await syncOnce(service, ledger, ["broken", "github"]);

    expect(results[0]).toEqual({ backend: "broken", synced: 0, error: "rate limited" });
    expect(results[1]).toEqual({ backend: "github", synced: 1 });
    expect(ledger.stats()).toEqual([{ backend: "github", count: 1 }]);
  });
});
