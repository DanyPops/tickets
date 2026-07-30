import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { TicketService } from "../../src/application/service.js";
import { buildApp } from "../../src/daemon/server.js";
import { FOCUS_MIGRATIONS, FocusStore } from "../../src/daemon/focus.js";
import { Ledger, LEDGER_MIGRATIONS } from "../../src/daemon/ledger.js";
import { createTicketsVehicleRegistry } from "../../src/vehicle/tickets-vehicle.js";
import { FakeRepository } from "../support/fake-repository.js";

const TOKEN = "test-token";
let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeApp() {
  db = openSqliteWithPragmas(":memory:", { migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS] });
  const ledger = new Ledger(db);
  const focusStore = new FocusStore(db);
  const github = new FakeRepository("github", [
    { ref: "github:#1", id: "1", key: "#1", title: "First", status: "todo", priority: "none", url: "https://github.com/acme/widgets/issues/1" },
  ]);
  const service = new TicketService({ github });
  const baseDeps = { service, ledger, focusStore, token: TOKEN, version: "0.0.0-test" };
  const app = buildApp({ ...baseDeps, vehicleRegistry: createTicketsVehicleRegistry(baseDeps) });
  return { app, ledger, focusStore, service };
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
    const setBody = (await setRes.json()) as { result: { focus: { ref: string; title: string; url: string; status: string; updatedAt: string } } };
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
    ledger.upsert("github", { ref: "github:#1", id: "1", key: "#1", title: "Ledger version", status: "todo", priority: "none", url: "https://github.com/acme/widgets/issues/1" });
    const spy = service.get.bind(service);
    let liveCalls = 0;
    service.get = async (ref: string) => {
      liveCalls++;
      return spy(ref);
    };
    const res = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.set", input: { ref: "github:#1" } }) }));
    const body = (await res.json()) as { result: { focus: { title: string } } };
    expect(body.result.focus.title).toBe("Ledger version");
    expect(liveCalls).toBe(0);
  });

  it("focus.set on an unknown ref maps to 404, same as issue.get", async () => {
    const { app } = makeApp();
    const res = await app.fetch(req("/api/v1/ops", { method: "POST", body: JSON.stringify({ op: "focus.set", input: { ref: "github:#999" } }) }));
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
    db = openSqliteWithPragmas(":memory:", { migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS] });
    const ledger = new Ledger(db);
    const focusStore = new FocusStore(db);
    const service = new TicketService({});
    let calls = 0;
    const baseDeps = {
      service,
      ledger,
      focusStore,
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
});
