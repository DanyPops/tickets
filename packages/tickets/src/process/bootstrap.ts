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
import { FOCUS_MIGRATIONS, FOCUS_STALE_AFTER_MS, FocusStore } from "../sqlite/focus.js";
import { LEDGER_MIGRATIONS, Ledger } from "../sqlite/ledger.js";
import { SAVED_QUERY_MIGRATIONS, SavedQueryStore } from "../sqlite/saved-queries.js";
import { SESSION_IDENTITY_MIGRATIONS, SqliteSessionIdentityStore } from "../sqlite/session-identity.js";
import { WATCH_MIGRATIONS, WatchStore } from "../sqlite/watches.js";
import { StageStore } from "../stage/store.js";
import { createSyncTask } from "./poller.js";
import { createIssueWatchSyncTask, createQueryWatchSyncTask } from "./watch-sync.js";

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
  /** How often every subscribed issue is re-fetched and diffed. Defaults to DEFAULT_ISSUE_WATCH_INTERVAL_MS. */
  issueWatchIntervalMs?: number;
  /** How often every subscribed saved query is re-run and diffed. Defaults to DEFAULT_QUERY_WATCH_INTERVAL_MS. */
  queryWatchIntervalMs?: number;
  /** How often stale (untouched for FOCUS_STALE_AFTER_MS) Focus scopes are reaped. Defaults to DEFAULT_FOCUS_REAP_INTERVAL_MS. */
  focusReapIntervalMs?: number;
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
  watches: WatchStore;
  sessionIdentity: SqliteSessionIdentityStore;
  service: TicketService;
  options: StartDaemonOptions;
}

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_BACKEND_REFRESH_INTERVAL_MS = 30_000;
/** Deliberately coarser than pipes' own 30s RUN_POOL_SYNC_INTERVAL_MS -- a CI run's status changes
 * on the order of seconds/minutes; an issue's comments/status change on the order of minutes/hours,
 * so polling that fast would only waste API quota against GitHub/GitLab/Jira's own rate limits. */
const DEFAULT_ISSUE_WATCH_INTERVAL_MS = 60_000;
const DEFAULT_QUERY_WATCH_INTERVAL_MS = 60_000;
/** Focus scopes are session-lifetime pointers, not hot state -- reaping once an hour is plenty prompt against FOCUS_STALE_AFTER_MS's own 30-day window. */
const DEFAULT_FOCUS_REAP_INTERVAL_MS = 60 * 60_000;

export async function bootstrap(opts: BootstrapOptions = {}): Promise<BootstrappedDaemon> {
  const paths = resolveDaemonPaths(TICKETS_DAEMON_NAMES, opts.pathEnv);
  const token = ensureAuthToken(paths.token, "Tickets");
  const db = openSqliteWithPragmas(paths.database, {
    migrations: [...LEDGER_MIGRATIONS, ...FOCUS_MIGRATIONS, ...SAVED_QUERY_MIGRATIONS, ...WATCH_MIGRATIONS, ...SESSION_IDENTITY_MIGRATIONS],
  });
  const ledger = new Ledger(db);
  const focusStore = new FocusStore(db);
  const queries = new SavedQueryStore(db);
  const stageStore = new StageStore();
  const watches = new WatchStore(db);
  const sessionIdentity = new SqliteSessionIdentityStore(db);
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
    watches,
    sessionIdentity,
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
      createIssueWatchSyncTask(service, watches, opts.issueWatchIntervalMs ?? DEFAULT_ISSUE_WATCH_INTERVAL_MS, logger),
      createQueryWatchSyncTask(service, queries, watches, opts.queryWatchIntervalMs ?? DEFAULT_QUERY_WATCH_INTERVAL_MS, logger),
      {
        name: "checkpoint",
        intervalMs: opts.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS,
        run: () => checkpoint(db),
      },
      {
        name: "focus-reap-stale",
        intervalMs: opts.focusReapIntervalMs ?? DEFAULT_FOCUS_REAP_INTERVAL_MS,
        run: () => {
          const removed = focusStore.reapStale(new Date(Date.now() - FOCUS_STALE_AFTER_MS).toISOString());
          if (removed > 0) logger.debug("reaped stale focus scopes", { removed });
        },
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
        watches,
        sessionIdentity,
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

  return { db, ledger, focusStore, queries, stageStore, watches, sessionIdentity, service, options };
}
