/**
 * Composition root for the tickets daemon: wires paths, auth token, ledger
 * storage, real backend repositories, and the sync poller into the options
 * vehicle-server's startDaemon()/runDaemonProcess() expect. Everything here is
 * injectable so tests can substitute fake repositories and a scratch XDG
 * root instead of hitting real GitHub/GitLab/Jira or the real home directory.
 */
import type { Database } from "bun:sqlite";
import type { StartDaemonOptions } from "@danypops/vehicle-server/daemon";
import { createLogger, type Logger } from "@danypops/vehicle-server/logging";
import { ensureAuthToken, type PathEnvironment, resolveDaemonPaths } from "@danypops/vehicle-server/paths";
import { checkpoint, openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { createTicketsVehicleRegistry, syncDiscoverAvailability } from "../agent-tools/tickets-vehicle.js";
import { type BuildRepositories, buildRepositories, type Config, createBackendRefreshTask, loadConfig } from "../config/config.js";
import type { IssueRepository } from "../issue/repository.js";
import { TicketService } from "../issue/service.js";
import { TICKETS_DAEMON_NAMES } from "../rpc/ops.js";
import { buildApp, type TicketsAppDeps } from "../rpc/server.js";
import { FOCUS_MIGRATIONS, FocusStore } from "../sqlite/focus.js";
import { LEDGER_MIGRATIONS, Ledger } from "../sqlite/ledger.js";
import { SAVED_QUERY_MIGRATIONS, SavedQueryStore } from "../sqlite/saved-queries.js";
import { StageStore } from "../stage/store.js";
import { createSyncTask } from "./poller.js";

export interface BootstrapOptions {
  pathEnv?: PathEnvironment;
  config?: Config;
  /**
   * Injected directly in tests instead of building from config/env. Also
   * disables the live backend-refresh task -- an injected repo set is a
   * fixed test fixture, not something to re-resolve from Enigma/config.
   */
  repos?: Record<string, IssueRepository>;
  /** Injected in tests to control which backends a refresh cycle resolves to, without a real Enigma/GitHub/GitLab/Jira. */
  buildRepositories?: BuildRepositories;
  version?: string;
  logger?: Logger;
  syncIntervalMs?: number;
  checkpointIntervalMs?: number;
  /** How often the live backend set re-resolves from config/env/Enigma. Ignored when repos is injected. */
  backendRefreshIntervalMs?: number;
  /**
   * Overrides the daemon.shutdown op's effect. Defaults to sending this
   * process SIGTERM, which vehicle-server's runDaemonProcess already handles
   * with a tested graceful stop (see main.ts). Tests override this instead
   * of self-signaling the test runner's own process.
   */
  onShutdownRequested?: () => void;
}

export interface BootstrappedDaemon {
  db: Database;
  ledger: Ledger;
  focusStore: FocusStore;
  queries: SavedQueryStore;
  stageStore: StageStore;
  service: TicketService;
  options: StartDaemonOptions;
}

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_BACKEND_REFRESH_INTERVAL_MS = 30_000;

export async function bootstrap(opts: BootstrapOptions = {}): Promise<BootstrappedDaemon> {
  const paths = resolveDaemonPaths(TICKETS_DAEMON_NAMES, opts.pathEnv);
  const token = ensureAuthToken(paths.token, "Tickets");
  const db = openSqliteWithPragmas(paths.database, { migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS] });
  const ledger = new Ledger(db);
  const focusStore = new FocusStore(db);
  const queries = new SavedQueryStore(db);
  const stageStore = new StageStore();
  const logger = opts.logger ?? createLogger("tickets-daemon", { levelEnvVar: "TICKETS_LOG_LEVEL" });
  const config = opts.config ?? loadConfig();
  const buildRepos = opts.buildRepositories ?? buildRepositories;
  const repos = opts.repos ?? (await buildRepos(config));
  const service = new TicketService(repos);
  const version = opts.version ?? "0.0.0-dev";
  const onShutdownRequested = opts.onShutdownRequested ?? (() => process.kill(process.pid, "SIGTERM"));

  // Built from the same base deps buildApp's TicketsAppDeps describes, minus
  // the registry field itself -- createTicketsVehicleRegistry never reads
  // deps.vehicleRegistry, so this ordering is safe (see server.ts's own
  // comment on why the registry is built outside it, not imported into it).
  const vehicleRegistry = createTicketsVehicleRegistry({
    service,
    ledger,
    focusStore,
    queries,
    stageStore,
    token,
    version,
    logger,
    onShutdownRequested,
  } as TicketsAppDeps);

  const options: StartDaemonOptions = {
    daemonLabel: "Tickets",
    handlePath: paths.handle,
    logger,
    maintenanceTasks: [
      createSyncTask(service, ledger, opts.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS, logger),
      {
        name: "checkpoint",
        intervalMs: opts.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS,
        run: () => checkpoint(db),
      },
      // Only when repos came from real config/env/Enigma resolution -- an
      // injected test fixture (opts.repos) has no config to re-resolve from.
      ...(opts.repos === undefined
        ? [
            createBackendRefreshTask(
              service,
              config,
              buildRepos,
              opts.backendRefreshIntervalMs ?? DEFAULT_BACKEND_REFRESH_INTERVAL_MS,
              logger,
              (refreshedService) => syncDiscoverAvailability(vehicleRegistry, refreshedService),
            ),
          ]
        : []),
    ],
    buildApp: () =>
      buildApp({
        service,
        ledger,
        focusStore,
        queries,
        stageStore,
        token,
        version,
        logger,
        onShutdownRequested,
        vehicleRegistry,
      }),
    onShutdown: () => {
      db.close();
    },
  };

  return { db, ledger, focusStore, queries, stageStore, service, options };
}
