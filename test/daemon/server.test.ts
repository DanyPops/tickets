import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openSqliteWithPragmas } from "@danypops/daemon-kit/storage";
import { TicketService } from "../../src/application/service.js";
import { buildApp } from "../../src/daemon/server.js";
import { Ledger, LEDGER_MIGRATIONS } from "../../src/daemon/ledger.js";
import { FakeRepository } from "../support/fake-repository.js";

const TOKEN = "test-token";
let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeApp() {
  db = openSqliteWithPragmas(":memory:", { migrations: LEDGER_MIGRATIONS });
  const ledger = new Ledger(db);
  const github = new FakeRepository("github", [
    { ref: "github:#1", id: "1", key: "#1", title: "First", status: "todo", priority: "none" },
  ]);
  const service = new TicketService({ github });
  const app = buildApp({ service, ledger, token: TOKEN, version: "0.0.0-test" });
  return { app, ledger, service };
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
});
