/**
 * Composition root for the tickets daemon: wires paths, auth token, ledger
 * storage, real backend repositories, and the sync poller into the options
 * daemon-kit's startDaemon()/runDaemonProcess() expect. Everything here is
 * injectable so tests can substitute fake repositories and a scratch XDG
 * root instead of hitting real GitHub/GitLab/Jira or the real home directory.
 */
import type { Database } from "bun:sqlite";
import { createLogger, type Logger } from "@danypops/daemon-kit/logging";
import { ensureAuthToken, type PathEnvironment, resolveDaemonPaths } from "@danypops/daemon-kit/paths";
import { checkpoint, openSqliteWithPragmas } from "@danypops/daemon-kit/storage";
import type { StartDaemonOptions } from "@danypops/daemon-kit/daemon";
import { TicketService } from "../application/service.js";
import { buildRepositories, type Config, loadConfig } from "../config/config.js";
import type { IssueRepository } from "../ports/repository.js";
import { Ledger, LEDGER_MIGRATIONS } from "./ledger.js";
import { TICKETS_DAEMON_NAMES } from "./ops.js";
import { buildApp } from "./server.js";
import { createSyncTask } from "./poller.js";

export interface BootstrapOptions {
  pathEnv?: PathEnvironment;
  config?: Config;
  /** Injected directly in tests instead of building from config/env. */
  repos?: Record<string, IssueRepository>;
  version?: string;
  logger?: Logger;
  syncIntervalMs?: number;
  checkpointIntervalMs?: number;
  /**
   * Overrides the daemon.shutdown op's effect. Defaults to sending this
   * process SIGTERM, which daemon-kit's runDaemonProcess already handles
   * with a tested graceful stop (see main.ts). Tests override this instead
   * of self-signaling the test runner's own process.
   */
  onShutdownRequested?: () => void;
}

export interface BootstrappedDaemon {
  db: Database;
  ledger: Ledger;
  service: TicketService;
  options: StartDaemonOptions;
}

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 10 * 60_000;

export function bootstrap(opts: BootstrapOptions = {}): BootstrappedDaemon {
  const paths = resolveDaemonPaths(TICKETS_DAEMON_NAMES, opts.pathEnv);
  const token = ensureAuthToken(paths.token, "Tickets");
  const db = openSqliteWithPragmas(paths.database, { migrations: LEDGER_MIGRATIONS });
  const ledger = new Ledger(db);
  const logger = opts.logger ?? createLogger("tickets-daemon", { levelEnvVar: "TICKETS_LOG_LEVEL" });
  const repos = opts.repos ?? buildRepositories(opts.config ?? loadConfig());
  const service = new TicketService(repos);
  const version = opts.version ?? "0.0.0-dev";

  const options: StartDaemonOptions = {
    daemonLabel: "Tickets",
    handlePath: paths.handle,
    logger,
    maintenanceTasks: [
      createSyncTask(service, ledger, Object.keys(repos), opts.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS, logger),
      {
        name: "checkpoint",
        intervalMs: opts.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS,
        run: () => checkpoint(db),
      },
    ],
    buildApp: () =>
      buildApp({
        service,
        ledger,
        token,
        version,
        logger,
        onShutdownRequested: opts.onShutdownRequested ?? (() => process.kill(process.pid, "SIGTERM")),
      }),
    onShutdown: () => {
      db.close();
    },
  };

  return { db, ledger, service, options };
}
