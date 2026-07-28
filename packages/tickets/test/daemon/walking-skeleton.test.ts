/**
 * Wires every real piece (daemon-kit's paths/storage/daemon + tickets' own
 * ledger/server/poller/bootstrap) into one running daemon, over a real
 * loopback socket, authenticated with a real generated token, against a
 * fake IssueRepository (no real GitHub/GitLab/Jira call). Proves the
 * daemon-kit integration end to end before wiring real credentials.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonHandle } from "@danypops/daemon-kit/paths";
import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
import { startDaemon } from "@danypops/daemon-kit/daemon";
import { bootstrap } from "../../src/daemon/bootstrap.js";
import type { TicketOpInputs, TicketOperation, TicketOpOutputs } from "../../src/daemon/ops.js";
import { FakeRepository } from "../support/fake-repository.js";

let daemon: RunningDaemon | undefined;
let tmpRoot: string | undefined;

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});

describe("tickets daemon walking skeleton", () => {
  it("boots on daemon-kit, authenticates, serves real ops, and pools into the ledger", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tickets-daemon-skeleton-"));
    const pathEnv = { env: { XDG_DATA_HOME: tmpRoot, XDG_STATE_HOME: tmpRoot, XDG_RUNTIME_DIR: tmpRoot, XDG_CONFIG_HOME: tmpRoot } };

    const github = new FakeRepository("github", [
      { ref: "github:#1", id: "1", key: "#1", title: "Skeleton issue", status: "todo", priority: "none", url: "https://github.com/acme/widgets/issues/1" },
    ]);

    const { options, ledger, db } = await bootstrap({
      pathEnv,
      repos: { github },
      version: "0.0.0-skeleton",
      syncIntervalMs: 20,
    });

    daemon = startDaemon(options);

    const handle = readDaemonHandle(options.handlePath);
    expect(handle?.port).toBe(daemon.port);

    // Read the real token daemon-kit generated for this scratch state dir.
    const { ensureAuthToken, resolveDaemonPaths } = await import("@danypops/daemon-kit/paths");
    const { TICKETS_DAEMON_NAMES } = await import("../../src/daemon/ops.js");
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
    expect(backends.backends).toEqual(["github"]);

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

  it("wrong token is rejected before any op runs", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tickets-daemon-skeleton-auth-"));
    const pathEnv = { env: { XDG_DATA_HOME: tmpRoot, XDG_STATE_HOME: tmpRoot, XDG_RUNTIME_DIR: tmpRoot, XDG_CONFIG_HOME: tmpRoot } };
    const { options } = await bootstrap({ pathEnv, repos: {}, version: "0.0.0-skeleton" });
    daemon = startDaemon(options);

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
    daemon = startDaemon(options);

    const { ensureAuthToken, resolveDaemonPaths } = await import("@danypops/daemon-kit/paths");
    const { TICKETS_DAEMON_NAMES } = await import("../../src/daemon/ops.js");
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
    // Simulates `enigma login gitlab` happening after the daemon already booted: the
    // first buildRepositories() call sees only github, the second (what the refresh
    // task re-resolves to) also has gitlab.
    let calls = 0;
    const buildRepositories = async (): Promise<Record<string, typeof github>> => {
      calls++;
      return calls === 1 ? { github } : { github, gitlab };
    };

    const { options, db } = await bootstrap({
      pathEnv,
      config: { backends: {} },
      buildRepositories,
      version: "0.0.0-skeleton",
      backendRefreshIntervalMs: 20,
    });

    daemon = startDaemon(options);

    const { ensureAuthToken, resolveDaemonPaths } = await import("@danypops/daemon-kit/paths");
    const { TICKETS_DAEMON_NAMES } = await import("../../src/daemon/ops.js");
    const paths = resolveDaemonPaths(TICKETS_DAEMON_NAMES, pathEnv);
    const token = ensureAuthToken(paths.token, "Tickets");
    const client = new AuthenticatedRpcClient<TicketOperation, TicketOpInputs, TicketOpOutputs>(
      `http://${daemon.host}:${daemon.port}`,
      token,
      { label: "Tickets" },
    );

    const before = await client.call("backends.list", {});
    expect(before.backends).toEqual(["github"]);

    // Give the refresh task at least one tick.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const after = await client.call("backends.list", {});
    expect(after.backends.sort()).toEqual(["github", "gitlab"]);

    const got = await client.call("issue.get", { ref: "gitlab:1" });
    expect(got.issue.title).toBe("Newly configured");

    db.close();
  });
});
