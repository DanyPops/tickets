/**
 * Wires every real piece (vehicle-server's paths/storage/daemon + tickets' own
 * ledger/server/poller/bootstrap) into one running daemon, over a real
 * loopback socket, authenticated with a real generated token, against a
 * fake IssueRepository (no real GitHub/GitLab/Jira call). Proves the
 * vehicle-server integration end to end before wiring real credentials.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { startDaemon } from "@danypops/vehicle-server/daemon";
import { readDaemonHandle } from "@danypops/vehicle-server/paths";
import type { BackendCapabilities } from "../../src/issue/service.js";
import { bootstrap } from "../../src/process/bootstrap.js";
import type { TicketOperation, TicketOpInputs, TicketOpOutputs } from "../../src/rpc/ops.js";
import { FakeRepository } from "../support/fake-repository.js";

/** FakeRepository implements only the RawQueryable capability, none of the five discover ones. */
const GITHUB_CAPABILITIES_ONLY_RAW_QUERY: BackendCapabilities = {
  name: "github",
  readiness: {
    backendType: "github",
    connectivity: "not_checked",
    read: { state: "unknown", missingConfiguration: [], recovery: "This adapter does not expose local configuration readiness." },
    write: { state: "unknown", missingConfiguration: [], recovery: "This adapter does not expose local configuration readiness." },
  },
  supportsRawQuery: true,
  supportsFieldDiscovery: false,
  supportsStatusDiscovery: false,
  supportsTemplateDiscovery: false,
  supportsBoardQuickFilterDiscovery: false,
  supportsBoardFilterDiscovery: false,
  supportsPullRequestReview: false,
  supportsPullRequestChangesRequest: false,
};

let daemon: RunningDaemon | undefined;
let tmpRoot: string | undefined;

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});

describe("tickets daemon bootstrap integration", () => {
  it("boots on vehicle-server, authenticates, serves real ops, and pools into the ledger", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tickets-daemon-skeleton-"));
    const pathEnv = { env: { XDG_DATA_HOME: tmpRoot, XDG_STATE_HOME: tmpRoot, XDG_RUNTIME_DIR: tmpRoot, XDG_CONFIG_HOME: tmpRoot } };

    const github = new FakeRepository("github", [
      {
        ref: "github:#1",
        id: "1",
        key: "#1",
        title: "Skeleton issue",
        status: "todo",
        priority: "none",
        url: "https://github.com/acme/widgets/issues/1",
      },
    ]);

    const { options, ledger, db } = await bootstrap({
      pathEnv,
      repos: { github },
      version: "0.0.0-skeleton",
      syncIntervalMs: 20,
    });

    daemon = await startDaemon(options);

    const handle = readDaemonHandle(options.handlePath);
    expect(handle?.port).toBe(daemon.port);

    // Read the real token vehicle-server generated for this scratch state dir.
    const { ensureAuthToken, resolveDaemonPaths } = await import("@danypops/vehicle-server/paths");
    const { TICKETS_DAEMON_NAMES } = await import("../../src/rpc/ops.js");
    const paths = resolveDaemonPaths(TICKETS_DAEMON_NAMES, pathEnv);
    const token = ensureAuthToken(paths.token, "Tickets");

    const client = new AuthenticatedRpcClient<TicketOperation, TicketOpInputs, TicketOpOutputs>(
      `http://${daemon.host}:${daemon.port}`,
      token,
      { label: "Tickets" },
    );

    expect(await client.health()).toEqual({ ok: true, version: "0.0.0-skeleton" });
    expect(await client.operations()).toContain("issue.get");

    const backends = await client.call("backends.list", {});
    expect(backends.backends).toEqual([GITHUB_CAPABILITIES_ONLY_RAW_QUERY]);

    const got = await client.call("issue.get", { ref: "github:#1" });
    expect(got.issue.title).toBe("Skeleton issue");

    // The poller runs on its own schedule, independent of the client asking
    // for anything — give it one tick, then confirm the ledger has it without
    // any further client call to the "live" backend.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const ledgerHit = await client.call("ledger.search", { query: "Skeleton" });
    expect(ledgerHit.issues[0]?.title).toBe("Skeleton issue");
    expect(ledger.stats()).toEqual([{ backend: "github", count: 1 }]);

    // Focus survives as its own real op against the real daemon+SQLite stack,
    // carrying the issue's full web URL, not just its ref.
    const focused = await client.call("focus.set", { ref: "github:#1" });
    expect(focused.focus.url).toBe("https://github.com/acme/widgets/issues/1");
    const readBack = await client.call("focus.get", {});
    expect(readBack.focus?.ref).toBe("github:#1");

    db.close();
  });

  it("a real Vehicle-surface op call (the path Pi/pi-tickets' own RemoteVehicleClient actually uses) is recorded by the wired-in metrics store", async () => {
    // Deliberately NOT AuthenticatedRpcClient/`/api/v1/ops` here -- that's tickets' own separate,
    // hand-written native RPC surface (see server.ts's own buildApp: `/vehicle/*` and
    // `/api/v1/ops` are two independent dispatch paths sharing one HTTP app and one
    // TICKET_OP_HANDLERS table, but only the former ever reaches vehicleRegistry.invoke(), which
    // is where the metrics middleware is wired). pi-tickets' own real vehicle-client.ts uses
    // RemoteVehicleClient (`@danypops/vehicle-client/http`) against exactly this surface -- this
    // test proves metrics capture the path that actually matters (agent/Pi-driven usage), and its
    // own doc comment records the honest limitation: a caller using AuthenticatedRpcClient
    // directly (tickets' own CLI, or another daemon calling tickets natively) bypasses it.
    const { RemoteVehicleClient } = await import("@danypops/vehicle-client/http");
    tmpRoot = mkdtempSync(join(tmpdir(), "tickets-daemon-metrics-"));
    const pathEnv = { env: { XDG_DATA_HOME: tmpRoot, XDG_STATE_HOME: tmpRoot, XDG_RUNTIME_DIR: tmpRoot, XDG_CONFIG_HOME: tmpRoot } };
    const github = new FakeRepository("github", [
      { ref: "github:#1", id: "1", key: "#1", title: "Skeleton issue", status: "todo", priority: "none" },
    ]);
    const { options, metrics, db } = await bootstrap({ pathEnv, repos: { github }, version: "0.0.0-skeleton" });
    daemon = await startDaemon(options);

    const { ensureAuthToken, resolveDaemonPaths } = await import("@danypops/vehicle-server/paths");
    const { TICKETS_DAEMON_NAMES } = await import("../../src/rpc/ops.js");
    const paths = resolveDaemonPaths(TICKETS_DAEMON_NAMES, pathEnv);
    const token = ensureAuthToken(paths.token, "Tickets");
    const vehicleClient = new RemoteVehicleClient({ baseUrl: `http://${daemon.host}:${daemon.port}`, token });

    const manifest = await vehicleClient.manifest();
    expect(manifest.operations.map((op) => op.name)).toContain("metrics.query");
    expect(manifest.operations.map((op) => op.name)).toContain("metrics.recordClientEvent");

    const got = (await vehicleClient.invoke("issue.get", 1, { ref: "github:#1" }, { permissions: ["tickets:read", "tickets:write"] })) as {
      issue: { title: string };
    };
    expect(got.issue.title).toBe("Skeleton issue");

    // Read the metrics store directly (bootstrap's own returned handle) rather than through
    // metrics.query's own RPC path -- equivalent data, no extra round trip needed for this test.
    const rows = metrics.query({ toolName: "issue.get" });
    expect(rows[0]).toMatchObject({ count: 1, successCount: 1, failureCount: 0 });

    await vehicleClient.close();
    db.close();
  });

  it("wrong token is rejected before any op runs", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tickets-daemon-skeleton-auth-"));
    const pathEnv = { env: { XDG_DATA_HOME: tmpRoot, XDG_STATE_HOME: tmpRoot, XDG_RUNTIME_DIR: tmpRoot, XDG_CONFIG_HOME: tmpRoot } };
    const { options } = await bootstrap({ pathEnv, repos: {}, version: "0.0.0-skeleton" });
    daemon = await startDaemon(options);

    const badClient = new AuthenticatedRpcClient<TicketOperation, TicketOpInputs, TicketOpOutputs>(
      `http://${daemon.host}:${daemon.port}`,
      "wrong-token",
      { label: "Tickets" },
    );
    await expect(badClient.health()).rejects.toThrow();
  });

  it("daemon.shutdown is wired through bootstrap's injectable onShutdownRequested, never the test process's own signal handling", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tickets-daemon-skeleton-shutdown-"));
    const pathEnv = { env: { XDG_DATA_HOME: tmpRoot, XDG_STATE_HOME: tmpRoot, XDG_RUNTIME_DIR: tmpRoot, XDG_CONFIG_HOME: tmpRoot } };
    let requested = 0;
    const { options } = await bootstrap({
      pathEnv,
      repos: {},
      version: "0.0.0-skeleton",
      onShutdownRequested: () => {
        requested++;
      },
    });
    daemon = await startDaemon(options);

    const { ensureAuthToken, resolveDaemonPaths } = await import("@danypops/vehicle-server/paths");
    const { TICKETS_DAEMON_NAMES } = await import("../../src/rpc/ops.js");
    const paths = resolveDaemonPaths(TICKETS_DAEMON_NAMES, pathEnv);
    const token = ensureAuthToken(paths.token, "Tickets");
    const client = new AuthenticatedRpcClient<TicketOperation, TicketOpInputs, TicketOpOutputs>(
      `http://${daemon.host}:${daemon.port}`,
      token,
      { label: "Tickets" },
    );

    const result = await client.call("daemon.shutdown", {});
    expect(result.stopping).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(requested).toBe(1);
  });

  it("a backend added after startup becomes callable live, with no restart, via the backend-refresh maintenance task", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tickets-daemon-skeleton-refresh-"));
    const pathEnv = { env: { XDG_DATA_HOME: tmpRoot, XDG_STATE_HOME: tmpRoot, XDG_RUNTIME_DIR: tmpRoot, XDG_CONFIG_HOME: tmpRoot } };

    const github = new FakeRepository("github", [
      { ref: "github:#1", id: "1", key: "#1", title: "Skeleton issue", status: "todo", priority: "none" },
    ]);
    const gitlab = new FakeRepository("gitlab", [
      { ref: "gitlab:1", id: "1", key: "1", title: "Newly configured", status: "todo", priority: "none" },
    ]);
    // Simulates `enigma login gitlab` happening after the daemon already booted: every
    // buildRepositories() call sees only github until the test flips gitlabAvailable,
    // however many times the refresh task happens to have already run by then --
    // vehicle-server's own maintenance-task scheduler now runs a task once immediately
    // at startup *in addition to* its interval (a deliberate self-healing gap fix), so a
    // fixed "first call vs. later calls" counter would race unpredictably against however
    // many refreshes land before the test gets to read the pre-flip state.
    let gitlabAvailable = false;
    const buildRepositories = async (): Promise<Record<string, typeof github>> => {
      return gitlabAvailable ? { github, gitlab } : { github };
    };

    const { options, db } = await bootstrap({
      pathEnv,
      config: { backends: {} },
      buildRepositories,
      version: "0.0.0-skeleton",
      backendRefreshIntervalMs: 20,
    });

    daemon = await startDaemon(options);

    const { ensureAuthToken, resolveDaemonPaths } = await import("@danypops/vehicle-server/paths");
    const { TICKETS_DAEMON_NAMES } = await import("../../src/rpc/ops.js");
    const paths = resolveDaemonPaths(TICKETS_DAEMON_NAMES, pathEnv);
    const token = ensureAuthToken(paths.token, "Tickets");
    const client = new AuthenticatedRpcClient<TicketOperation, TicketOpInputs, TicketOpOutputs>(
      `http://${daemon.host}:${daemon.port}`,
      token,
      { label: "Tickets" },
    );

    const before = await client.call("backends.list", {});
    expect(before.backends).toEqual([GITHUB_CAPABILITIES_ONLY_RAW_QUERY]);

    gitlabAvailable = true;

    // Give the refresh task at least one tick.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const after = await client.call("backends.list", {});
    expect(after.backends.map((b) => b.name).sort()).toEqual(["github", "gitlab"]);

    const got = await client.call("issue.get", { ref: "gitlab:1" });
    expect(got.issue.title).toBe("Newly configured");

    db.close();
  });
});
