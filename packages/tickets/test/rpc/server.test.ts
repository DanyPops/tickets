import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { createTicketsVehicleRegistry } from "../../src/agent-tools/tickets-vehicle.js";
import { TicketService } from "../../src/issue/service.js";
import { buildApp } from "../../src/rpc/server.js";
import { FOCUS_MIGRATIONS, FocusStore } from "../../src/sqlite/focus.js";
import { LEDGER_MIGRATIONS, Ledger } from "../../src/sqlite/ledger.js";
import { SAVED_QUERY_MIGRATIONS, SavedQueryStore } from "../../src/sqlite/saved-queries.js";
import { StageStore } from "../../src/stage/store.js";
import { ReviewableFakeRepository } from "../support/fake-repository.js";

const TOKEN = "test-token";
let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeApp() {
  db = openSqliteWithPragmas(":memory:", { migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS] });
  const ledger = new Ledger(db);
  const focusStore = new FocusStore(db);
  const queries = new SavedQueryStore(db);
  const stageStore = new StageStore();
  const github = new ReviewableFakeRepository("github", [
    {
      ref: "github:#1",
      id: "1",
      key: "#1",
      title: "First",
      status: "todo",
      priority: "none",
      url: "https://github.com/acme/widgets/issues/1",
    },
    {
      ref: "github:#5",
      id: "5",
      key: "#5",
      title: "A PR",
      status: "todo",
      priority: "none",
      url: "https://github.com/acme/widgets/pull/5",
    },
  ]);
  const service = new TicketService({ github });
  const baseDeps = { service, ledger, focusStore, queries, stageStore, token: TOKEN, version: "0.0.0-test" };
  const app = buildApp({ ...baseDeps, vehicleRegistry: createTicketsVehicleRegistry(baseDeps) });
  return { app, ledger, focusStore, queries, stageStore, service, github };
}

function req(path: string, init: RequestInit = {}, token = TOKEN): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://daemon.local${path}`, { ...init, headers });
}

describe("daemon HTTP surface", () => {
  it("rejects requests without a valid bearer token", async () => {
    const { app } = makeApp();
    const res = await app.fetch(req("/health", {}, ""));
    expect(res.status).toBe(401);
  });

  it("serves /health and /ready", async () => {
    const { app } = makeApp();
    const health = await app.fetch(req("/health"));
    expect(health.status).toBe(200);
    const body = (await health.json()) as { version: string };
    expect(body.version).toBe("0.0.0-test");

    const ready = await app.fetch(req("/ready"));
    expect(ready.status).toBe(200);
  });

  it("GET /api/v1/ops lists every operation the CLI and pi-tickets extension can call", async () => {
    const { app } = makeApp();
    const res = await app.fetch(req("/api/v1/ops"));
    const body = (await res.json()) as { operations: string[] };
    expect(body.operations).toContain("issue.get");
    expect(body.operations).toContain("ledger.search");
  });

  it("dispatches issue.get and returns the same shape TicketService returns", async () => {
    const { app } = makeApp();
    const res = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "issue.get", input: { ref: "github:#1" } }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { issue: { title: string } } };
    expect(body.result.issue.title).toBe("First");
  });

  it("dispatches issue.approve, returning the reviewed issue", async () => {
    const { app, github } = makeApp();
    const res = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "issue.approve", input: { ref: "github:#5", body: "lgtm" } }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { issue: { pullRequest?: { reviewers?: unknown[] } } } };
    expect(body.result.issue.pullRequest?.reviewers).toEqual([{ username: "approver", state: "approved" }]);
    expect(github.lastApproveCall).toEqual({ key: "#5", body: "lgtm" });
  });

  it("dispatches issue.merge with a method, returning the merged issue", async () => {
    const { app, github } = makeApp();
    const res = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "issue.merge", input: { ref: "github:#5", method: "squash" } }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { issue: { pullRequest?: { merged?: boolean } } } };
    expect(body.result.issue.pullRequest?.merged).toBe(true);
    expect(github.lastMergeCall).toEqual({ key: "#5", method: "squash" });
  });

  it("dispatches issue.request_changes, returning the reviewed issue", async () => {
    const { app, github } = makeApp();
    const res = await app.fetch(
      req("/api/v1/ops", {
        method: "POST",
        body: JSON.stringify({ op: "issue.request_changes", input: { ref: "github:#5", body: "fix the tests" } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { issue: { pullRequest?: { reviewers?: unknown[] } } } };
    expect(body.result.issue.pullRequest?.reviewers).toEqual([{ username: "reviewer", state: "changes_requested" }]);
    expect(github.lastRequestChangesCall).toEqual({ key: "#5", body: "fix the tests" });
  });

  it("maps UnknownBackendError to HTTP 400, not 500", async () => {
    const { app } = makeApp();
    const res = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "issue.list", input: { backend: "nope" } }) }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown op name before touching the service", async () => {
    const { app } = makeApp();
    const res = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "issue.delete_everything", input: {} }) }));
    expect(res.status).toBe(400);
  });

  it("ledger.search reads from the local ledger, independent of any live backend call", async () => {
    const { app, ledger } = makeApp();
    ledger.upsert("github", { ref: "github:#99", id: "99", key: "#99", title: "Cached only", status: "todo", priority: "none" });
    const res = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "ledger.search", input: { query: "Cached" } }) }),
    );
    const body = (await res.json()) as { result: { issues: { title: string }[] } };
    expect(body.result.issues[0]?.title).toBe("Cached only");
  });

  it("focus.set resolves the ref's real url from the live backend and focus.get returns it back", async () => {
    const { app } = makeApp();
    const setRes = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.set", input: { ref: "github:#1" } }) }),
    );
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as {
      result: { focus: { ref: string; title: string; url: string; status: string; updatedAt: string } };
    };
    expect(setBody.result.focus).toEqual({
      ref: "github:#1",
      title: "First",
      url: "https://github.com/acme/widgets/issues/1",
      status: "active",
      updatedAt: setBody.result.focus.updatedAt,
    });

    const getRes = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.get", input: {} }) }));
    const getBody = (await getRes.json()) as { result: { focus: { ref: string } | null } };
    expect(getBody.result.focus?.ref).toBe("github:#1");
  });

  it("focus.set warms the ledger with the resolved issue when it wasn't already cached", async () => {
    const { app, ledger } = makeApp();
    expect(ledger.get("github:#1")).toBeUndefined();
    await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.set", input: { ref: "github:#1" } }) }));
    expect(ledger.get("github:#1")?.title).toBe("First");
  });

  it("focus.set prefers an already-cached ledger entry over a live call", async () => {
    const { app, ledger, service } = makeApp();
    ledger.upsert("github", {
      ref: "github:#1",
      id: "1",
      key: "#1",
      title: "Ledger version",
      status: "todo",
      priority: "none",
      url: "https://github.com/acme/widgets/issues/1",
    });
    const spy = service.get.bind(service);
    let liveCalls = 0;
    service.get = async (ref: string) => {
      liveCalls++;
      return spy(ref);
    };
    const res = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.set", input: { ref: "github:#1" } }) }),
    );
    const body = (await res.json()) as { result: { focus: { title: string } } };
    expect(body.result.focus.title).toBe("Ledger version");
    expect(liveCalls).toBe(0);
  });

  it("focus.set on an unknown ref maps to 404, same as issue.get", async () => {
    const { app } = makeApp();
    const res = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.set", input: { ref: "github:#999" } }) }),
    );
    expect(res.status).toBe(404);
  });

  it("focus.pause / focus.unpause / focus.clear round-trip through real state transitions, invalid ones map to 400", async () => {
    const { app } = makeApp();
    await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.set", input: { ref: "github:#1" } }) }));

    const badUnpause = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.unpause", input: {} }) }));
    expect(badUnpause.status).toBe(400); // already active

    const pauseRes = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.pause", input: { reason: "waiting on review" } }) }),
    );
    expect(pauseRes.status).toBe(200);
    const pauseBody = (await pauseRes.json()) as { result: { focus: { status: string; pauseReason?: string } } };
    expect(pauseBody.result.focus.status).toBe("paused");
    expect(pauseBody.result.focus.pauseReason).toBe("waiting on review");

    const unpauseRes = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.unpause", input: {} }) }));
    const unpauseBody = (await unpauseRes.json()) as { result: { focus: { status: string } } };
    expect(unpauseBody.result.focus.status).toBe("active");

    const clearRes = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.clear", input: {} }) }));
    const clearBody = (await clearRes.json()) as { result: { cleared: boolean } };
    expect(clearBody.result.cleared).toBe(true);

    const getAfterClear = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.get", input: {} }) }));
    const getAfterClearBody = (await getAfterClear.json()) as { result: { focus: unknown } };
    expect(getAfterClearBody.result.focus).toBeNull();
  });

  it("daemon.shutdown responds before invoking onShutdownRequested, never calls it synchronously", async () => {
    db = openSqliteWithPragmas(":memory:", { migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS] });
    const ledger = new Ledger(db);
    const focusStore = new FocusStore(db);
    const queries = new SavedQueryStore(db);
    const stageStore = new StageStore();
    const service = new TicketService({});
    let calls = 0;
    const baseDeps = {
      service,
      ledger,
      focusStore,
      queries,
      stageStore,
      token: TOKEN,
      version: "0.0.0-test",
      onShutdownRequested: () => {
        calls++;
      },
    };
    const app = buildApp({ ...baseDeps, vehicleRegistry: createTicketsVehicleRegistry(baseDeps) });

    const res = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "daemon.shutdown", input: {} }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { stopping: boolean } };
    expect(body.result.stopping).toBe(true);
    // Not called yet — the handler defers it so this very response can flush first.
    expect(calls).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(1);
  });

  it("query.save then query.list round-trips a saved query", async () => {
    const { app } = makeApp();
    const saveRes = await app.fetch(
      req("/api/v1/ops", {
        method: "POST",
        body: JSON.stringify({ op: "query.save", input: { name: "q1", backend: "github", query: "First" } }),
      }),
    );
    expect(saveRes.status).toBe(200);
    const saveBody = (await saveRes.json()) as { result: { query: { name: string; backend: string; query: string } } };
    expect(saveBody.result.query).toMatchObject({ name: "q1", backend: "github", query: "First" });

    const listRes = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "query.list", input: {} }) }));
    const listBody = (await listRes.json()) as { result: { queries: { name: string }[] } };
    expect(listBody.result.queries.map((q) => q.name)).toEqual(["q1"]);
  });

  it("query.run executes a saved query's raw query against its backend", async () => {
    const { app } = makeApp();
    await app.fetch(
      req("/api/v1/ops", {
        method: "POST",
        body: JSON.stringify({ op: "query.save", input: { name: "q1", backend: "github", query: "First" } }),
      }),
    );
    const runRes = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "query.run", input: { name: "q1" } }) }),
    );
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { result: { issues: { title: string }[] } };
    expect(runBody.result.issues.map((i) => i.title)).toEqual(["First"]);
  });

  it("query.run on an unknown saved-query name maps to 404", async () => {
    const { app } = makeApp();
    const res = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "query.run", input: { name: "nope" } }) }));
    expect(res.status).toBe(404);
  });

  it("query.remove deletes a saved query", async () => {
    const { app } = makeApp();
    await app.fetch(
      req("/api/v1/ops", {
        method: "POST",
        body: JSON.stringify({ op: "query.save", input: { name: "q1", backend: "github", query: "First" } }),
      }),
    );
    const removeRes = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "query.remove", input: { name: "q1" } }) }),
    );
    const removeBody = (await removeRes.json()) as { result: { removed: boolean } };
    expect(removeBody.result.removed).toBe(true);
    const listRes = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "query.list", input: {} }) }));
    const listBody = (await listRes.json()) as { result: { queries: unknown[] } };
    expect(listBody.result.queries).toEqual([]);
  });

  it("stage.add then stage.show round-trips a staged create payload", async () => {
    const { app } = makeApp();
    const payload = { kind: "create", backend: "github", input: { title: "Draft issue" } };
    const addRes = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "stage.add", input: { payload } }) }));
    expect(addRes.status).toBe(200);
    const addBody = (await addRes.json()) as { result: { item: { id: string; payload: unknown } } };
    expect(addBody.result.item.payload).toEqual(payload);

    const showRes = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "stage.show", input: { id: addBody.result.item.id } }) }),
    );
    const showBody = (await showRes.json()) as { result: { item: { id: string } } };
    expect(showBody.result.item.id).toBe(addBody.result.item.id);
  });

  it("stage.list lists everything currently staged; stage.drop removes one item", async () => {
    const { app } = makeApp();
    const add = async (body: string) =>
      (
        (await app
          .fetch(
            req("/api/v1/ops", {
              method: "POST",
              body: JSON.stringify({ op: "stage.add", input: { payload: { kind: "comment", ref: "github:#1", body } } }),
            }),
          )
          .then((res) => res.json())) as { result: { item: { id: string } } }
      ).result.item;
    const first = await add("draft one");
    await add("draft two");

    const listRes = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "stage.list", input: {} }) }));
    const listBody = (await listRes.json()) as { result: { items: unknown[] } };
    expect(listBody.result.items).toHaveLength(2);

    const dropRes = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "stage.drop", input: { id: first.id } }) }),
    );
    const dropBody = (await dropRes.json()) as { result: { dropped: boolean } };
    expect(dropBody.result.dropped).toBe(true);

    const afterRes = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "stage.list", input: {} }) }));
    const afterBody = (await afterRes.json()) as { result: { items: unknown[] } };
    expect(afterBody.result.items).toHaveLength(1);
  });

  it("stage.patch edits a staged payload's text fields in place before it's pushed", async () => {
    const { app } = makeApp();
    const addRes = await app.fetch(
      req("/api/v1/ops", {
        method: "POST",
        body: JSON.stringify({ op: "stage.add", input: { payload: { kind: "comment", ref: "github:#1", body: "too verbose comment" } } }),
      }),
    );
    const addBody = (await addRes.json()) as { result: { item: { id: string } } };

    const patchRes = await app.fetch(
      req("/api/v1/ops", {
        method: "POST",
        body: JSON.stringify({ op: "stage.patch", input: { id: addBody.result.item.id, fields: { body: "concise comment" } } }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { result: { item: { payload: { body: string } } } };
    expect(patchBody.result.item.payload.body).toBe("concise comment");
  });

  it("stage.show on an unknown id maps to 404, same as issue.get", async () => {
    const { app } = makeApp();
    const res = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "stage.show", input: { id: "nope" } }) }));
    expect(res.status).toBe(404);
  });

  it("stage.push commits a staged create payload to the real backend and drops it from the stage", async () => {
    const { app, stageStore } = makeApp();
    const staged = stageStore.add({ kind: "create", backend: "github", input: { title: "Pushed from stage" } });

    const pushRes = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "stage.push", input: { id: staged.id } }) }),
    );
    expect(pushRes.status).toBe(200);
    const pushBody = (await pushRes.json()) as { result: { result: { issue: { title: string; ref: string } } } };
    expect(pushBody.result.result.issue.title).toBe("Pushed from stage");

    expect(stageStore.list()).toEqual([]);

    const listRes = await app.fetch(
      req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "issue.list", input: { backend: "github" } }) }),
    );
    const listBody = (await listRes.json()) as { result: { issues: { title: string }[] } };
    expect(listBody.result.issues.map((i) => i.title)).toContain("Pushed from stage");
  });

  it("stage.push on an unknown/expired id maps to 404 and never touches the backend", async () => {
    const { app } = makeApp();
    const res = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "stage.push", input: { id: "nope" } }) }));
    expect(res.status).toBe(404);
  });
});
