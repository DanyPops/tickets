import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { createTicketsVehicleRegistry, syncDiscoverAvailability } from "../../src/agent-tools/tickets-vehicle.js";
import { TicketService } from "../../src/issue/service.js";
import { FOCUS_MIGRATIONS, FocusStore } from "../../src/sqlite/focus.js";
import { LEDGER_MIGRATIONS, Ledger } from "../../src/sqlite/ledger.js";
import { SAVED_QUERY_MIGRATIONS, SavedQueryStore } from "../../src/sqlite/saved-queries.js";
import { WATCH_MIGRATIONS, WatchStore } from "../../src/sqlite/watches.js";
import { StageStore } from "../../src/stage/store.js";
import { FakeRepository, ReviewableFakeRepository, ReviewOnlyFakeRepository } from "../support/fake-repository.js";

/** Implements every discover.* optional capability, unlike FakeRepository -- proves availability tracks real capability, not a hardcoded "jira" name. */
class DiscoverableRepository extends FakeRepository {
  async discoverFields() {
    return {};
  }
  async discoverStatuses() {
    return {};
  }
  async discoverTemplate() {
    return undefined;
  }
  async discoverBoardQuickFilterJql() {
    return "project = X";
  }
  async discoverBoardFilterJql() {
    return "project = X";
  }
}

const DISCOVER_OPS = ["discover.fields", "discover.statuses", "discover.template", "discover.board_quickfilter", "discover.board_filter"];

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function harness(repos: Record<string, FakeRepository>) {
  db = openSqliteWithPragmas(":memory:", {
    migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS, ...WATCH_MIGRATIONS],
  });
  const ledger = new Ledger(db);
  const focusStore = new FocusStore(db);
  const queries = new SavedQueryStore(db);
  const stageStore = new StageStore();
  const watches = new WatchStore(db);
  const service = new TicketService(repos);
  const registry = createTicketsVehicleRegistry({
    service,
    ledger,
    focusStore,
    queries,
    stageStore,
    watches,
    token: "test-token",
    version: "0.0.0-test",
  });
  return { registry, service };
}

function availabilityOf(registry: ReturnType<typeof harness>["registry"], ops: readonly string[] = DISCOVER_OPS) {
  return Object.fromEntries(
    registry
      .manifest()
      .operations.filter((op) => ops.includes(op.name))
      .map((op) => [op.name, op.available]),
  );
}

describe("discover.* tool availability", () => {
  it("hides every discover.* operation when no configured backend supports any of them", () => {
    const { registry } = harness({ github: new FakeRepository("github", []) });
    const availability = availabilityOf(registry);
    for (const op of DISCOVER_OPS) expect(availability[op]).toBe(false);
  });

  it("attaches a real, non-empty reason when hidden", () => {
    const { registry } = harness({ github: new FakeRepository("github", []) });
    const op = registry.manifest().operations.find((o) => o.name === "discover.fields");
    expect(op?.unavailableReason).toMatch(/no configured backend/);
  });

  it("shows every discover.* operation once a backend implementing all of them is configured", () => {
    const { registry } = harness({ jira: new DiscoverableRepository("jira", []) });
    const availability = availabilityOf(registry);
    for (const op of DISCOVER_OPS) expect(availability[op]).toBe(true);
  });

  it("re-syncs to newly-hidden after a live backend swap removes the only capable backend", () => {
    const { registry, service } = harness({ jira: new DiscoverableRepository("jira", []) });
    expect(availabilityOf(registry)["discover.fields"]).toBe(true);

    service.setRepos({ github: new FakeRepository("github", []) });
    syncDiscoverAvailability(registry, service);

    expect(availabilityOf(registry)["discover.fields"]).toBe(false);
  });

  it("re-syncs to newly-shown after a live backend swap adds a capable backend", () => {
    const { registry, service } = harness({ github: new FakeRepository("github", []) });
    expect(availabilityOf(registry)["discover.fields"]).toBe(false);

    service.setRepos({ jira: new DiscoverableRepository("jira", []) });
    syncDiscoverAvailability(registry, service);

    expect(availabilityOf(registry)["discover.fields"]).toBe(true);
  });

  it("never hides a non-discover operation regardless of backend capability", () => {
    const { registry } = harness({ github: new FakeRepository("github", []) });
    const op = registry.manifest().operations.find((o) => o.name === "issue.list");
    expect(op?.available).toBe(true);
  });
});

const PR_OPS = ["issue.approve", "issue.merge", "issue.request_changes"];

describe("pull-request review tool availability", () => {
  it("hides issue.approve/issue.merge/issue.request_changes when no configured backend supports any of them", () => {
    const { registry } = harness({ jira: new FakeRepository("jira", []) });
    expect(availabilityOf(registry, PR_OPS)).toEqual({ "issue.approve": false, "issue.merge": false, "issue.request_changes": false });
  });

  it("shows issue.approve/issue.merge but not issue.request_changes for a GitLab-shaped (review-only) backend", () => {
    const { registry } = harness({ gitlab: new ReviewOnlyFakeRepository("gitlab", []) });
    expect(availabilityOf(registry, PR_OPS)).toEqual({ "issue.approve": true, "issue.merge": true, "issue.request_changes": false });
  });

  it("shows all three for a GitHub-shaped backend (full PullRequestReviewable + PullRequestChangesRequestable)", () => {
    const { registry } = harness({ github: new ReviewableFakeRepository("github", []) });
    expect(availabilityOf(registry, PR_OPS)).toEqual({ "issue.approve": true, "issue.merge": true, "issue.request_changes": true });
  });

  it("re-syncs when a live backend swap adds a review-capable backend", () => {
    const { registry, service } = harness({ jira: new FakeRepository("jira", []) });
    expect(availabilityOf(registry, PR_OPS)["issue.approve"]).toBe(false);

    service.setRepos({ github: new ReviewableFakeRepository("github", []) });
    syncDiscoverAvailability(registry, service);

    expect(availabilityOf(registry, PR_OPS)["issue.approve"]).toBe(true);
  });
});
