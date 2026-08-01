import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { TicketService } from "../../src/application/service.js";
import { FOCUS_MIGRATIONS, FocusStore } from "../../src/daemon/focus.js";
import { LEDGER_MIGRATIONS, Ledger } from "../../src/daemon/ledger.js";
import { TICKET_OPERATIONS } from "../../src/daemon/ops.js";
import { SAVED_QUERY_MIGRATIONS, SavedQueryStore } from "../../src/daemon/saved-queries.js";
import { createTicketsVehicleRegistry } from "../../src/vehicle/tickets-vehicle.js";
import { FakeRepository } from "../support/fake-repository.js";

const PERMS = { permissions: ["tickets:read", "tickets:write"] };

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function harness() {
  db = openSqliteWithPragmas(":memory:", { migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS] });
  const ledger = new Ledger(db);
  const focusStore = new FocusStore(db);
  const queries = new SavedQueryStore(db);
  const github = new FakeRepository("github", [
    {
      ref: "github:#1",
      id: "1",
      key: "#1",
      title: "First",
      status: "todo",
      priority: "none",
      url: "https://github.com/acme/widgets/issues/1",
    },
  ]);
  const service = new TicketService({ github });
  const registry = createTicketsVehicleRegistry({ service, ledger, focusStore, queries, token: "test-token", version: "0.0.0-test" });
  return { registry, service, ledger, focusStore, queries };
}

describe("createTicketsVehicleRegistry", () => {
  it("registers every real ticket operation, dotted names preserved, daemon.shutdown deliberately excluded", () => {
    const { registry } = harness();
    const names = registry
      .manifest()
      .operations.map((op) => op.name)
      .sort();
    const expected = TICKET_OPERATIONS.filter((op) => op !== "daemon.shutdown").sort();
    expect(names).toEqual(expected);
    expect(names).not.toContain("daemon.shutdown");
  });

  it("no operation's own schema is itself an action-dispatch blob -- one honest operation per real action", () => {
    const { registry } = harness();
    for (const op of registry.manifest().operations) {
      const properties = (op.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(properties)).not.toContain("action");
    }
  });

  it("gives each action its own honest effect -- external-write for real GitHub/GitLab/Jira mutations, local-write for focus state, read otherwise", () => {
    const { registry } = harness();
    const effectOf = (name: string) => registry.manifest().operations.find((op) => op.name === name)?.effect;
    expect(effectOf("issue.list")).toBe("read");
    expect(effectOf("issue.get")).toBe("read");
    expect(effectOf("ledger.search")).toBe("read");
    expect(effectOf("issue.create")).toBe("external-write");
    expect(effectOf("issue.update")).toBe("external-write");
    expect(effectOf("issue.comment_add")).toBe("external-write");
    expect(effectOf("focus.set")).toBe("local-write");
    expect(effectOf("focus.clear")).toBe("local-write");
  });

  it("marks every read operation safely idempotent and every write operation unsafe", () => {
    const { registry } = harness();
    for (const op of registry.manifest().operations) {
      expect(op.idempotency.mode).toBe(op.effect === "read" ? "safe" : "unsafe");
    }
  });

  it("issue.list delegates to the real TicketService against the real backend, not a reimplementation", async () => {
    const { registry } = harness();
    const result = (await registry.invoke("issue.list", 1, { backend: "github" }, PERMS)) as { issues: { title: string }[] };
    expect(result.issues.map((i) => i.title)).toEqual(["First"]);
  });

  it("issue.list's tool schema exposes project/status/assignee/labels/limit as flat top-level properties, not an opaque filter object -- matching issue.search's own convention", () => {
    const { registry } = harness();
    const schema = registry.manifest().operations.find((op) => op.name === "issue.list")?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    const properties = Object.keys(schema.properties ?? {});
    expect(properties).toEqual(expect.arrayContaining(["backend", "project", "status", "assignee", "labels", "limit"]));
    expect(properties).not.toContain("filter");
  });

  it("issue.list forwards flat project/status/limit tool args into the real repository's ListFilter, unchanged behavior from the RPC/CLI's own nested-filter contract", async () => {
    const db = openSqliteWithPragmas(":memory:", { migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS] });
    const ledger = new Ledger(db);
    const focusStore = new FocusStore(db);
    const queries = new SavedQueryStore(db);
    const jira = new FakeRepository("jira", [
      { ref: "jira:PROJ-1", id: "1", key: "PROJ-1", title: "First", status: "todo", priority: "none", url: "https://example/PROJ-1" },
    ]);
    const service = new TicketService({ jira });
    const registry = createTicketsVehicleRegistry({ service, ledger, focusStore, queries, token: "test-token", version: "0.0.0-test" });

    await registry.invoke("issue.list", 1, { backend: "jira", project: "CNF", status: "todo", limit: 5 }, PERMS);

    expect(jira.lastListCall).toEqual({ project: "CNF", status: "todo", limit: 5 });
    db.close();
  });

  it("issue.get resolves a real issue by ref", async () => {
    const { registry } = harness();
    const result = (await registry.invoke("issue.get", 1, { ref: "github:#1" }, PERMS)) as { issue: { title: string } };
    expect(result.issue.title).toBe("First");
  });

  it("focus.set writes real focus state, readable back through focus.get, clearable through focus.clear", async () => {
    const { registry } = harness();
    const set = (await registry.invoke("focus.set", 1, { ref: "github:#1" }, PERMS)) as { focus: { ref: string; title: string } };
    expect(set.focus.ref).toBe("github:#1");
    expect(set.focus.title).toBe("First");

    const got = (await registry.invoke("focus.get", 1, {}, PERMS)) as { focus: { ref: string } | null };
    expect(got.focus?.ref).toBe("github:#1");

    const cleared = (await registry.invoke("focus.clear", 1, {}, PERMS)) as { cleared: boolean };
    expect(cleared.cleared).toBe(true);

    const afterClear = (await registry.invoke("focus.get", 1, {}, PERMS)) as { focus: unknown };
    expect(afterClear.focus).toBeNull();
  });

  it("issue.create performs a real, externally-visible write through the fake backend", async () => {
    const { registry } = harness();
    const result = (await registry.invoke("issue.create", 1, { backend: "github", input: { title: "New one" } }, PERMS)) as {
      issue: { title: string; ref: string };
    };
    expect(result.issue.title).toBe("New one");
    const listed = (await registry.invoke("issue.list", 1, { backend: "github" }, PERMS)) as { issues: { title: string }[] };
    expect(listed.issues.map((i) => i.title)).toContain("New one");
  });

  it("denies a call with no permissions granted, even for a read -- secure by default, not just documentation", async () => {
    const { registry } = harness();
    await expect(registry.invoke("issue.list", 1, { backend: "github" })).rejects.toThrow(/requires permissions/);
  });

  it("rejects a call missing a required field before the handler ever runs", async () => {
    const { registry } = harness();
    await expect(registry.invoke("issue.get", 1, {}, PERMS)).rejects.toThrow();
  });

  it("rejects an unknown backend -- the real UnknownBackendError survives as the wrapped VehicleError's cause, not swallowed", async () => {
    const { registry } = harness();
    try {
      await registry.invoke("issue.list", 1, { backend: "not-configured" }, PERMS);
      throw new Error("expected invoke to reject");
    } catch (error) {
      expect((error as Error).message).toContain("handler failed");
      expect(((error as Error).cause as Error)?.message).toMatch(/unknown backend/);
    }
  });

  it("query.save/list/run/remove round-trip a saved query through the real SavedQueryStore and TicketService", async () => {
    const { registry } = harness();
    const saved = (await registry.invoke("query.save", 1, { name: "q1", backend: "github", query: "First" }, PERMS)) as {
      query: { name: string };
    };
    expect(saved.query.name).toBe("q1");

    const listed = (await registry.invoke("query.list", 1, {}, PERMS)) as { queries: { name: string }[] };
    expect(listed.queries.map((q) => q.name)).toEqual(["q1"]);

    const ran = (await registry.invoke("query.run", 1, { name: "q1" }, PERMS)) as { issues: { title: string }[] };
    expect(ran.issues.map((i) => i.title)).toEqual(["First"]);

    const removed = (await registry.invoke("query.remove", 1, { name: "q1" }, PERMS)) as { removed: boolean };
    expect(removed.removed).toBe(true);
  });

  it("query.save's tool schema is flat (name/backend/query/description), matching every other operation's own convention", () => {
    const { registry } = harness();
    const schema = registry.manifest().operations.find((op) => op.name === "query.save")?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["name", "backend", "query", "description"]));
  });
});
