/**
 * Poller — pools issues from every configured backend into the local Ledger
 * on its own schedule, independent of whether any client (CLI, pi-tickets)
 * is currently asking for anything. A backend sync failure (rate limit,
 * network, bad creds) is logged and skipped; it never crashes the daemon
 * and never blocks other backends' syncs.
 */

import type { MaintenanceTask } from "@danypops/vehicle-server/daemon";
import type { Logger } from "@danypops/vehicle-server/logging";
import type { TicketService } from "../application/service.js";
import type { Ledger } from "./ledger.js";

const DEFAULT_SYNC_LIMIT = 50;

/** Runs one sync pass across all given backends. Exported standalone for tests. */
export async function syncOnce(
  service: TicketService,
  ledger: Ledger,
  backends: string[],
  logger?: Logger,
): Promise<{ backend: string; synced: number; error?: string }[]> {
  const results: { backend: string; synced: number; error?: string }[] = [];
  for (const backend of backends) {
    try {
      const issues = await service.list(backend, { limit: DEFAULT_SYNC_LIMIT });
      const synced = ledger.upsertMany(backend, issues);
      results.push({ backend, synced });
      logger?.debug("ledger sync ok", { backend, synced });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ backend, synced: 0, error: message });
      logger?.warn("ledger sync failed", { backend, error: message });
    }
  }
  return results;
}

/**
 * Reads the backend list fresh from service.backends() on every tick,
 * rather than a list frozen at task-creation time -- a backend the
 * refresh task (config.ts's createBackendRefreshTask) just added to the
 * service is synced on this task's very next run, no daemon restart or
 * task rebuild needed.
 */
export function createSyncTask(service: TicketService, ledger: Ledger, intervalMs: number, logger?: Logger): MaintenanceTask {
  return {
    name: "ledger-sync",
    intervalMs,
    run: async () => {
      await syncOnce(service, ledger, service.backends(), logger);
    },
  };
}
