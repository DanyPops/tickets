import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { createTicketsVehicleRegistry } from "../../src/agent-tools/tickets-vehicle.js";
import { GitHubRepository } from "../../src/github/github.js";
import { ApiError, BackendConnectionError } from "../../src/issue/errors.js";
import { type BackendCapabilities, TicketService } from "../../src/issue/service.js";
import { TICKET_OPERATIONS, type TicketOperation } from "../../src/rpc/ops.js";
import { FOCUS_MIGRATIONS, FocusStore } from "../../src/sqlite/focus.js";
import { LEDGER_MIGRATIONS, Ledger } from "../../src/sqlite/ledger.js";
import { SAVED_QUERY_MIGRATIONS, SavedQueryStore } from "../../src/sqlite/saved-queries.js";
import { SESSION_IDENTITY_MIGRATIONS, SqliteSessionIdentityStore } from "../../src/sqlite/session-identity.js";
import { WATCH_MIGRATIONS, WatchStore } from "../../src/sqlite/watches.js";
import { StageStore } from "../../src/stage/store.js";
import { FakeRepository } from "../support/fake-repository.js";

const PERMS = { permissions: ["tickets:read", "tickets:write"] };
const PERMS_WITH_APPROVAL = { permissions: ["tickets:read", "tickets:write", "vehicle:approvals:resolve"] };

/**
 * Drives a gated operation through the real approval-required/resolve dance
 * this environment's tickets-vehicle.ts turns on via configureApprovals():
 * invoke() once (expecting approval-required), grant it through
 * vehicle.approval.resolve, then retry with the minted capability -- the
 * same sequence registerVehicleTools' own ctx.ui.confirm() dance performs
 * automatically for a real Pi session with a human at the keyboard.
 */
async function invokeApproved(
  registry: ReturnType<typeof harness>["registry"],
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const failure = await registry.invoke(name, 1, input, PERMS).then(
    () => {
      throw new Error(`expected ${name} to require approval`);
    },
    (error: unknown) => error as { details?: { requestId?: string } },
  );
  const requestId = failure.details?.requestId;
  if (!requestId) throw new Error(`expected a requestId in ${name}'s approval-required failure`);
  const resolved = (await registry.invoke("vehicle.approval.resolve", 1, { requestId, decision: "granted" }, PERMS_WITH_APPROVAL)) as {
    capability?: string;
  };
  return registry.invoke(name, 1, input, { ...PERMS, approvalCapability: resolved.capability });
}

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function harness() {
  db = openSqliteWithPragmas(":memory:", {
    migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS, ...WATCH_MIGRATIONS, ...SESSION_IDENTITY_MIGRATIONS],
  });
  const ledger = new Ledger(db);
  const focusStore = new FocusStore(db);
  const queries = new SavedQueryStore(db);
  const stageStore = new StageStore();
  const watches = new WatchStore(db);
  const sessionIdentity = new SqliteSessionIdentityStore(db);
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
  const registry = createTicketsVehicleRegistry({
    service,
    ledger,
    focusStore,
    queries,
    stageStore,
    watches,
    sessionIdentity,
    token: "test-token",
    version: "0.0.0-test",
  });
  return { registry, service, ledger, focusStore, queries, stageStore, watches, sessionIdentity };
}

describe("createTicketsVehicleRegistry", () => {
  it("reports the real deps.version in the manifest identity, not a hardcoded placeholder", () => {
    const { registry } = harness();
    expect(registry.manifest().version).toBe("0.0.0-test");
  });

  it("registers every real ticket operation, dotted names preserved, daemon.shutdown/session.register/session.release deliberately excluded", () => {
    const { registry } = harness();
    const names = registry
      .manifest()
      .operations.map((op) => op.name)
      .sort();
    // vehicle.approval.resolve is VehicleRegistry's own built-in, registered by
    // configureApprovals() -- never a tickets operation itself, and (per
    // vehicle-client-pi's own exclusion) never projected as a callable Pi tool.
    // session.register/session.release are excluded the same way daemon.shutdown is: an
    // internal client<->daemon handshake (see rpc/server.ts's own session-identity armor doc
    // comment), never something an LLM should be able to call as a tool -- reached only via
    // the raw /api/v1/ops dispatch pi-tickets' own extension code uses directly.
    const EXCLUDED_FROM_VEHICLE = new Set(["daemon.shutdown", "session.register", "session.release"]);
    const expected = [...TICKET_OPERATIONS.filter((op) => !EXCLUDED_FROM_VEHICLE.has(op)), "vehicle.approval.resolve"].sort();
    expect(names).toEqual(expected);
    for (const excluded of EXCLUDED_FROM_VEHICLE) expect(names).not.toContain(excluded);
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
    // Drafting is free: staging and editing a draft never touch a live backend.
    expect(effectOf("stage.add")).toBe("local-write");
    expect(effectOf("stage.list")).toBe("read");
    expect(effectOf("stage.show")).toBe("read");
    expect(effectOf("stage.patch")).toBe("local-write");
    expect(effectOf("stage.drop")).toBe("local-write");
    // Committing is not: pushing a staged payload is the same real write issue.create/update/comment_add are.
    expect(effectOf("stage.push")).toBe("external-write");
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
    const db = openSqliteWithPragmas(":memory:", {
      migrations: [
        ...LEDGER_MIGRATIONS,
        ...FOCUS_MIGRATIONS,
        ...SAVED_QUERY_MIGRATIONS,
        ...WATCH_MIGRATIONS,
        ...SESSION_IDENTITY_MIGRATIONS,
      ],
    });
    const ledger = new Ledger(db);
    const focusStore = new FocusStore(db);
    const queries = new SavedQueryStore(db);
    const stageStore = new StageStore();
    const watches = new WatchStore(db);
    const sessionIdentity = new SqliteSessionIdentityStore(db);
    const jira = new FakeRepository("jira", [
      { ref: "jira:PROJ-1", id: "1", key: "PROJ-1", title: "First", status: "todo", priority: "none", url: "https://example/PROJ-1" },
    ]);
    const service = new TicketService({ jira });
    const registry = createTicketsVehicleRegistry({
      service,
      ledger,
      focusStore,
      queries,
      stageStore,
      watches,
      sessionIdentity,
      token: "test-token",
      version: "0.0.0-test",
    });

    await registry.invoke("issue.list", 1, { backend: "jira", project: "ENG", status: "todo", limit: 5 }, PERMS);

    expect(jira.lastListCall).toEqual({ project: "ENG", status: "todo", limit: 5 });
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

  it("issue.create requires approval before it commits -- a bare call with no capability gets approval-required, not the real write", async () => {
    const { registry } = harness();
    await expect(registry.invoke("issue.create", 1, { backend: "github", input: { title: "New one" } }, PERMS)).rejects.toMatchObject({
      code: "approval-required",
    });
    const listed = (await registry.invoke("issue.list", 1, { backend: "github" }, PERMS)) as { issues: { title: string }[] };
    expect(listed.issues.map((i) => i.title)).not.toContain("New one");
  });

  it("issue.create performs a real, externally-visible write through the fake backend once approved", async () => {
    const { registry } = harness();
    const result = (await invokeApproved(registry, "issue.create", { backend: "github", input: { title: "New one" } })) as {
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

  it("maps an unknown backend to validation instead of a generic internal failure", async () => {
    const { registry } = harness();
    const failure = await registry.invoke("issue.list", 1, { backend: "not-configured" }, PERMS).catch((error: unknown) => error);
    expect((failure as { category?: string }).category).toBe("validation");
    expect((failure as { code?: string }).code).toBe("operation-rejected");
    expect((failure as Error).message).toMatch(/unknown backend/);
  });

  it("backends.list exposes local credential-safe readiness without probing the provider", async () => {
    const { registry, service } = harness();
    let fetchCalls = 0;
    service.setRepos({
      github: new GitHubRepository("github", {
        owner: "private-owner",
        token: "token-must-not-leak",
        fetchImpl: (async () => {
          fetchCalls++;
          throw new Error("backends.list must remain local");
        }) as unknown as typeof fetch,
      }),
    });

    const result = (await registry.invoke("backends.list", 1, {}, PERMS)) as { backends: BackendCapabilities[] };
    expect(fetchCalls).toBe(0);
    expect(result.backends[0]?.readiness).toEqual({
      backendType: "github",
      connectivity: "not_checked",
      read: {
        state: "partial",
        missingConfiguration: ["GITHUB_REPO"],
        recovery: expect.stringContaining("organization search remains available"),
      },
      write: {
        state: "blocked",
        missingConfiguration: ["GITHUB_REPO"],
        recovery: expect.stringContaining("repository scope"),
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("token-must-not-leak");
    expect(serialized).not.toContain("private-owner");
  });

  it("reports a partially configured GitHub backend with an actionable recovery instead of handler-failed", async () => {
    const { registry, service } = harness();
    service.setRepos({ github: new GitHubRepository("github", { owner: "acme" }) });

    const failure = await registry.invoke("issue.list", 1, { backend: "github" }, PERMS).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "backend-not-configured",
      category: "validation",
      message: "github: repository is not configured; set GITHUB_REPO (or the backend's repo setting) and restart the tickets daemon",
      recovery: { message: expect.stringContaining("GITHUB_REPO") },
    });
  });

  it("classifies backend HTTP failures without exposing an arbitrary response body", async () => {
    class FailingRepository extends FakeRepository {
      override async list(): Promise<never> {
        throw new ApiError("gitlab", "GET", "https://gitlab.example/api/issues", 503, 'credential="must-not-leak"');
      }
    }
    const { registry, service } = harness();
    service.setRepos({ gitlab: new FailingRepository("gitlab") });

    const failure = await registry.invoke("issue.list", 1, { backend: "gitlab" }, PERMS).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "backend-unavailable",
      category: "unavailable",
      message: "gitlab: backend API is unavailable (503)",
      retryable: true,
      details: { backend: "gitlab", status: 503 },
    });
    expect(JSON.stringify(failure)).not.toContain("must-not-leak");
  });

  it("classifies DNS/VPN-style connection failures with concrete recovery guidance", async () => {
    class FailingRepository extends FakeRepository {
      override async list(): Promise<never> {
        throw new BackendConnectionError("gitlab", "unreachable", new Error("getaddrinfo token=must-not-leak"));
      }
    }
    const { registry, service } = harness();
    service.setRepos({ gitlab: new FailingRepository("gitlab") });

    const failure = await registry.invoke("issue.list", 1, { backend: "gitlab" }, PERMS).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "backend-unavailable",
      category: "unavailable",
      message: "gitlab: unable to reach the backend API; check the configured URL and network, VPN, or DNS connectivity",
      retryable: true,
      recovery: { message: expect.stringMatching(/VPN.*DNS/) },
    });
    expect(JSON.stringify(failure)).not.toContain("must-not-leak");
  });

  it("keeps genuinely unknown exceptions opaque", async () => {
    class FailingRepository extends FakeRepository {
      override async list(): Promise<never> {
        throw new Error("credential=must-not-leak");
      }
    }
    const { registry, service } = harness();
    service.setRepos({ github: new FailingRepository("github") });

    const failure = await registry.invoke("issue.list", 1, { backend: "github" }, PERMS).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "handler-failed",
      category: "internal",
      message: "Tickets operation failed unexpectedly",
    });
    expect(JSON.stringify(failure)).not.toContain("must-not-leak");
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

  it("ledger.search's tool schema exposes the same backend scoping its daemon contract, CLI --backend flag, and Ledger.search() itself already support", () => {
    const { registry } = harness();
    const schema = registry.manifest().operations.find((op) => op.name === "ledger.search")?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["query", "limit", "backend"]));
  });

  it("ledger.search actually scopes results to the requested backend when invoked through the tool, not just the CLI", async () => {
    const { registry, ledger } = harness();
    ledger.upsertMany("github", [
      { ref: "github:#9", id: "9", key: "#9", title: "Widget bug", status: "todo", priority: "none", url: "https://example/9" },
    ]);
    ledger.upsertMany("jira", [
      { ref: "jira:PROJ-9", id: "9", key: "PROJ-9", title: "Widget bug", status: "todo", priority: "none", url: "https://example/PROJ-9" },
    ]);
    const result = (await registry.invoke("ledger.search", 1, { query: "Widget", backend: "jira" }, PERMS)) as {
      issues: { ref: string }[];
    };
    expect(result.issues.map((i) => i.ref)).toEqual(["jira:PROJ-9"]);
  });

  it("every operation's tool schema declares exactly the properties its own daemon contract (ops.ts's TicketOpInputs) accepts, except issue.list's deliberate flat reshape via mapInput", () => {
    const { registry } = harness();
    const EXPECTED_PROPERTIES: Record<Exclude<TicketOperation, "daemon.shutdown" | "session.register" | "session.release">, string[]> = {
      "backends.list": [],
      "issue.list": [
        "backend",
        "project",
        "status",
        "assignee",
        "labels",
        "limit",
        "reportedByMe",
        "assignedToMe",
        "reviewRequestedOfMe",
        "qaContactIsMe",
      ],
      "issue.get": ["ref"],
      "issue.create": ["backend", "input"],
      "issue.update": ["ref", "input"],
      "issue.search": ["backend", "query", "limit", "project"],
      "issue.children": ["ref"],
      "issue.comments": ["ref"],
      "issue.comment_add": ["ref", "body"],
      "issue.approve": ["ref", "body"],
      "issue.request_changes": ["ref", "body"],
      "issue.merge": ["ref", "method"],
      "ledger.search": ["query", "limit", "backend"],
      "ledger.stats": [],
      "focus.set": ["ref"],
      "focus.get": [],
      "focus.pause": ["reason"],
      "focus.unpause": [],
      "focus.clear": [],
      "discover.fields": ["backend"],
      "discover.statuses": ["backend"],
      "discover.template": ["backend", "project", "issueType", "sampleSize"],
      "discover.board_quickfilter": ["backend", "boardId", "quickFilterId"],
      "discover.board_filter": ["backend", "boardId"],
      "query.save": ["name", "backend", "query", "description"],
      "query.list": [],
      "query.remove": ["name"],
      "query.run": ["name", "limit"],
      "issue.subscribe": ["ref", "subscriberId", "scheduleMs", "projectRoot"],
      "issue.unsubscribe": ["ref", "subscriberId"],
      "issue.subscribed": ["subscriberId"],
      "query.subscribe": ["name", "subscriberId", "scheduleMs", "projectRoot"],
      "query.unsubscribe": ["name", "subscriberId"],
      "query.subscribed": ["subscriberId"],
      "watch.events": ["subscriberId", "sinceId", "limit"],
      "stage.add": ["payload"],
      "stage.list": [],
      "stage.show": ["id"],
      "stage.patch": ["id", "fields"],
      "stage.drop": ["id"],
      "stage.push": ["id"],
    };
    for (const [op, expected] of Object.entries(EXPECTED_PROPERTIES)) {
      const schema = registry.manifest().operations.find((o) => o.name === op)?.inputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([...expected].sort());
    }
  });
});

describe("staging: drafting is free, committing requires approval", () => {
  it("stage.add/list/show/patch/drop never require approval -- no capability needed, they never fail with approval-required", async () => {
    const { registry } = harness();
    const added = (await registry.invoke("stage.add", 1, { payload: { kind: "comment", ref: "github:#1", body: "draft" } }, PERMS)) as {
      item: { id: string };
    };
    await registry.invoke("stage.list", 1, {}, PERMS);
    await registry.invoke("stage.show", 1, { id: added.item.id }, PERMS);
    await registry.invoke("stage.patch", 1, { id: added.item.id, fields: { body: "revised draft" } }, PERMS);
    const dropped = (await registry.invoke("stage.drop", 1, { id: added.item.id }, PERMS)) as { dropped: boolean };
    expect(dropped.dropped).toBe(true);
  });

  it("stage.push requires approval before it commits, exactly like a direct issue.create call", async () => {
    const { registry } = harness();
    const added = (await registry.invoke(
      "stage.add",
      1,
      { payload: { kind: "create", backend: "github", input: { title: "Staged" } } },
      PERMS,
    )) as {
      item: { id: string };
    };
    await expect(registry.invoke("stage.push", 1, { id: added.item.id }, PERMS)).rejects.toMatchObject({ code: "approval-required" });
    const listed = (await registry.invoke("issue.list", 1, { backend: "github" }, PERMS)) as { issues: { title: string }[] };
    expect(listed.issues.map((i) => i.title)).not.toContain("Staged");
  });

  it("a too-verbose staged comment can be revised for free before it's ever committed, then commits only once approved", async () => {
    const { registry, stageStore } = harness();
    const staged = stageStore.add({ kind: "comment", ref: "github:#1", body: "way too verbose, needs trimming" });

    await registry.invoke("stage.patch", 1, { id: staged.id, fields: { body: "concise" } }, PERMS);

    const result = (await invokeApproved(registry, "stage.push", { id: staged.id })) as { result: { comment: { body: string } } };
    expect(result.result.comment.body).toBe("concise");
    expect(stageStore.list()).toEqual([]);
  });

  it("a denied approval leaves the staged item in place, still editable and re-pushable", async () => {
    const { registry, stageStore } = harness();
    const staged = stageStore.add({ kind: "comment", ref: "github:#1", body: "draft" });

    const failure = await registry.invoke("stage.push", 1, { id: staged.id }, PERMS).then(
      () => {
        throw new Error("expected approval-required");
      },
      (error: unknown) => error as { details?: { requestId?: string } },
    );
    const requestId = failure.details?.requestId;
    await registry.invoke("vehicle.approval.resolve", 1, { requestId, decision: "denied" }, PERMS_WITH_APPROVAL);

    expect(stageStore.list().map((item) => item.id)).toEqual([staged.id]);
    await expect(registry.invoke("stage.push", 1, { id: staged.id }, PERMS)).rejects.toMatchObject({ code: "approval-required" });
  });
});

describe("issue/query watch subscriptions", () => {
  it("issue.subscribe defaults subscriberId from the real call's own callerSessionId when not given explicitly", async () => {
    const { registry } = harness();
    await registry.invoke("issue.subscribe", 1, { ref: "github:#1" }, { ...PERMS, callerSessionId: "session-a" });

    const subscribed = (await registry.invoke("issue.subscribed", 1, { subscriberId: "session-a" }, PERMS)) as {
      watches: { ref: string }[];
    };
    expect(subscribed.watches.map((w) => w.ref)).toEqual(["github:#1"]);
  });

  it("issue.subscribed never leaks another subscriber's own watches", async () => {
    const { registry } = harness();
    await registry.invoke("issue.subscribe", 1, { ref: "github:#1", subscriberId: "alice" }, PERMS);
    await registry.invoke("issue.subscribe", 1, { ref: "github:#1", subscriberId: "bob" }, PERMS);

    const alice = (await registry.invoke("issue.subscribed", 1, { subscriberId: "alice" }, PERMS)) as { watches: unknown[] };
    const anonymous = (await registry.invoke("issue.subscribed", 1, {}, PERMS)) as { watches: unknown[] };
    expect(alice.watches).toHaveLength(1);
    expect(anonymous.watches).toHaveLength(0);
  });

  it("issue.unsubscribe is idempotent and removes only that one subscriber's watch", async () => {
    const { registry } = harness();
    await registry.invoke("issue.subscribe", 1, { ref: "github:#1", subscriberId: "alice" }, PERMS);
    await registry.invoke("issue.unsubscribe", 1, { ref: "github:#1", subscriberId: "alice" }, PERMS);
    await expect(registry.invoke("issue.unsubscribe", 1, { ref: "github:#1", subscriberId: "alice" }, PERMS)).resolves.toEqual({
      unsubscribed: true,
    });

    const subscribed = (await registry.invoke("issue.subscribed", 1, { subscriberId: "alice" }, PERMS)) as { watches: unknown[] };
    expect(subscribed.watches).toHaveLength(0);
  });

  it("query.subscribe/subscribed/unsubscribe mirror the issue-level shape", async () => {
    const { registry } = harness();
    await registry.invoke("query.save", 1, { name: "q1", backend: "github", query: "First" }, PERMS);
    await registry.invoke("query.subscribe", 1, { name: "q1", subscriberId: "alice" }, PERMS);

    const subscribed = (await registry.invoke("query.subscribed", 1, { subscriberId: "alice" }, PERMS)) as { watches: { name: string }[] };
    expect(subscribed.watches.map((w) => w.name)).toEqual(["q1"]);

    await registry.invoke("query.unsubscribe", 1, { name: "q1", subscriberId: "alice" }, PERMS);
    const afterUnsubscribe = (await registry.invoke("query.subscribed", 1, { subscriberId: "alice" }, PERMS)) as { watches: unknown[] };
    expect(afterUnsubscribe.watches).toHaveLength(0);
  });

  it("watch.events reports nothing until a subscribed sync tick observes and records a real change", async () => {
    const { registry, watches } = harness();
    await registry.invoke("issue.subscribe", 1, { ref: "github:#1", subscriberId: "alice" }, PERMS);

    const before = (await registry.invoke("watch.events", 1, { subscriberId: "alice" }, PERMS)) as { events: unknown[]; lastId: number };
    expect(before.events).toEqual([]);

    // Simulates the background sync task observing a real change and recording it -- watch.events
    // itself never computes a diff, only reads what was already recorded.
    watches.recordEvent("issue", "github:#1", "status: todo -> done");

    const after = (await registry.invoke("watch.events", 1, { subscriberId: "alice", sinceId: before.lastId }, PERMS)) as {
      events: { message: string }[];
      lastId: number;
    };
    expect(after.events.map((e) => e.message)).toEqual(["status: todo -> done"]);
    expect(after.lastId).toBeGreaterThan(before.lastId);
  });

  it("watch.events never surfaces an event for a key this subscriber isn't (or is no longer) watching", async () => {
    const { registry, watches } = harness();
    await registry.invoke("issue.subscribe", 1, { ref: "github:#1", subscriberId: "alice" }, PERMS);
    watches.recordEvent("issue", "github:#2", "unrelated change");

    const result = (await registry.invoke("watch.events", 1, { subscriberId: "alice" }, PERMS)) as { events: unknown[] };
    expect(result.events).toEqual([]);
  });

  it("issue.subscribe/unsubscribe/subscribed/watch.events are all local-write/read, never gated behind approval", async () => {
    const { registry } = harness();
    // A bare call with no approvalCapability succeeding at all (not rejecting approval-required)
    // is the proof these are local-write, unlike issue.create/update/comment_add.
    await expect(registry.invoke("issue.subscribe", 1, { ref: "github:#1" }, PERMS)).resolves.toEqual({ subscribed: true });
    await expect(registry.invoke("issue.subscribed", 1, {}, PERMS)).resolves.toBeTruthy();
  });
});

describe("session-scoped ticket focus (Vehicle tool-call path)", () => {
  it("focus.set/get default their scope from the real call's own callerSessionId -- the same host-derived, never-model-settable identity issue.subscribe already relies on", async () => {
    const { registry } = harness();
    await registry.invoke("focus.set", 1, { ref: "github:#1" }, { ...PERMS, callerSessionId: "session-a" });

    const sessionA = (await registry.invoke("focus.get", 1, {}, { ...PERMS, callerSessionId: "session-a" })) as {
      focus: { ref: string } | null;
    };
    const sessionB = (await registry.invoke("focus.get", 1, {}, { ...PERMS, callerSessionId: "session-b" })) as {
      focus: { ref: string } | null;
    };
    const noSession = (await registry.invoke("focus.get", 1, {}, PERMS)) as { focus: { ref: string } | null };

    expect(sessionA.focus?.ref).toBe("github:#1");
    expect(sessionB.focus).toBeNull();
    expect(noSession.focus).toBeNull();
  });

  it("focus.pause/unpause/clear all resolve the same callerSessionId-derived scope as focus.set/get", async () => {
    const { registry } = harness();
    await registry.invoke("focus.set", 1, { ref: "github:#1" }, { ...PERMS, callerSessionId: "session-a" });

    const paused = (await registry.invoke("focus.pause", 1, {}, { ...PERMS, callerSessionId: "session-a" })) as {
      focus: { status: string };
    };
    expect(paused.focus.status).toBe("paused");

    // A different session never had anything focused -- pausing it must fail, proving this
    // really is scope isolation and not a lucky global-state coincidence.
    await expect(registry.invoke("focus.pause", 1, {}, { ...PERMS, callerSessionId: "session-b" })).rejects.toThrow();

    const cleared = (await registry.invoke("focus.clear", 1, {}, { ...PERMS, callerSessionId: "session-a" })) as { cleared: boolean };
    expect(cleared.cleared).toBe(true);
  });

  it("an explicit sessionId in the tool call's own input still wins over callerSessionId, the same precedence issue.subscribe's subscriberId already has", async () => {
    const { registry } = harness();
    await registry.invoke("focus.set", 1, { ref: "github:#1", sessionId: "explicit-scope" }, { ...PERMS, callerSessionId: "session-a" });

    const explicit = (await registry.invoke("focus.get", 1, { sessionId: "explicit-scope" }, PERMS)) as { focus: { ref: string } | null };
    const implicit = (await registry.invoke("focus.get", 1, {}, { ...PERMS, callerSessionId: "session-a" })) as {
      focus: { ref: string } | null;
    };
    expect(explicit.focus?.ref).toBe("github:#1");
    expect(implicit.focus).toBeNull();
  });

  it("focus_set/focus_get/focus_pause/focus_unpause/focus_clear never advertise a sessionId property in their own tool schema -- the model can't see or set it, it's transport metadata only", () => {
    const { registry } = harness();
    for (const name of ["focus.set", "focus.get", "focus.pause", "focus.unpause", "focus.clear"]) {
      const schema = registry.manifest().operations.find((op) => op.name === name)?.inputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(schema.properties ?? {})).not.toContain("sessionId");
      expect(Object.keys(schema.properties ?? {})).not.toContain("sessionSecret");
    }
  });
});
