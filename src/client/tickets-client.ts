/**
 * Node/Bun-portable client for the tickets daemon. Neither the CLI nor the
 * pi-tickets extension opens the daemon's SQLite ledger directly or talks to
 * GitHub/GitLab/Jira itself — both go through this authenticated RPC client,
 * spawning the (Bun-only) daemon on first use if it isn't already running.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonHandle } from "@danypops/daemon-kit/paths";
import { ensureAuthToken, readDaemonHandle, resolveDaemonPaths } from "@danypops/daemon-kit/paths";
import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import { packageRoot } from "../util/package-root.js";
import { TICKETS_DAEMON_NAMES, type TicketOpInputs, type TicketOperation, type TicketOpOutputs } from "../daemon/ops.js";

export function ticketsPaths(env?: Record<string, string | undefined>) {
  return resolveDaemonPaths(TICKETS_DAEMON_NAMES, env ? { env } : {});
}

async function isAlive(handle: DaemonHandle, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Absolute path to the daemon's real entry point, resolved from this package's own root. Used both to spawn it on demand and to point a systemd unit's ExecStart at it (see cli/systemd-service.ts). */
export function resolveDaemonEntryPath(): string {
  const root = packageRoot(dirname(fileURLToPath(import.meta.url)));
  return join(root, "src", "daemon", "main.ts");
}

function spawnDaemon(): void {
  const child = spawn("bun", ["run", resolveDaemonEntryPath()], { detached: true, stdio: "ignore" });
  child.unref();
}

async function waitForHandle(handlePath: string, timeoutMs: number): Promise<DaemonHandle | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handle = readDaemonHandle(handlePath);
    if (handle) return handle;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

export interface EnsureDaemonOptions {
  /** false: fail immediately with a clear message instead of spawning the daemon. */
  autoStart?: boolean;
  timeoutMs?: number;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 4_000;

export async function ensureDaemonRunning(
  opts: EnsureDaemonOptions = {},
): Promise<{ baseUrl: string; token: string }> {
  const paths = ticketsPaths();
  const token = ensureAuthToken(paths.token, "Tickets");

  const existing = readDaemonHandle(paths.handle);
  if (existing && (await isAlive(existing, token))) {
    return { baseUrl: `http://${existing.host}:${existing.port}`, token };
  }

  if (opts.autoStart === false) {
    throw new Error(
      "tickets daemon is not running. Start it with `npm run daemon` (or `bun run src/daemon/main.ts`).",
    );
  }

  spawnDaemon();
  const handle = await waitForHandle(paths.handle, opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
  if (!handle || !(await isAlive(handle, token))) {
    throw new Error("tickets daemon did not become ready within the timeout");
  }
  return { baseUrl: `http://${handle.host}:${handle.port}`, token };
}

export type TicketsRpcClient = AuthenticatedRpcClient<TicketOperation, TicketOpInputs, TicketOpOutputs>;

export async function createTicketsClient(opts: EnsureDaemonOptions = {}): Promise<TicketsRpcClient> {
  const { baseUrl, token } = await ensureDaemonRunning(opts);
  return new AuthenticatedRpcClient<TicketOperation, TicketOpInputs, TicketOpOutputs>(baseUrl, token, {
    label: "Tickets",
  });
}
