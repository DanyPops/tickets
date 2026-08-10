/**
 * Watch sync — the tickets daemon's own analog of @danypops/pipes' run/monitor.ts's syncRunPool,
 * for individual issues and saved queries instead of CI jobs. Two independent maintenance tasks
 * (createIssueWatchSyncTask / createQueryWatchSyncTask, wired in process/bootstrap.ts), same
 * shape as pipes': read the current subscription list fresh from SQLite every tick, group by key
 * (so N subscribers on the same ref/query share one live fetch), skip anything not yet due per its
 * own scheduleMs, fetch once per due group, diff against the last-cached snapshot, and only
 * persist a WatchEvent (via WatchStore.recordEvent) on a real, human-describable change.
 *
 * Deliberately never unsubscribes anything on its own (see watches.ts's own doc comment) -- a
 * failed fetch for one key is logged and skipped, retried next tick, exactly like pipes' own
 * per-group isolation.
 */
import type { MaintenanceTask } from "@danypops/vehicle-server/daemon";
import type { Logger } from "@danypops/vehicle-server/logging";
import type { TicketService } from "../issue/service.js";
import type { SavedQueryStore } from "../sqlite/saved-queries.js";
import type { IssueWatchSubscription, QueryWatchSubscription, WatchStore } from "../sqlite/watches.js";

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const DEFAULT_QUERY_WATCH_LIMIT = 50;

/** True if this subscription's own cadence has elapsed since it was last checked -- always true for a subscription with no scheduleMs, matching pipes' own isDue. */
function isDue(subscription: { scheduleMs?: number; lastCheckedAt?: Date }, nowMs: number): boolean {
  if (subscription.scheduleMs === undefined) return true;
  if (subscription.lastCheckedAt === undefined) return true;
  return nowMs - subscription.lastCheckedAt.getTime() >= subscription.scheduleMs;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = groups.get(k);
    if (existing) existing.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/**
 * Best-effort comment count: undefined (never diffed on) for a backend that doesn't support
 * comments at all (NotSupportedError) or a transient failure fetching them -- a missing comment
 * count must never itself look like "0 comments" and falsely report "N new comments" once support
 * (or connectivity) returns.
 */
async function tryCommentCount(service: TicketService, ref: string): Promise<number | undefined> {
  try {
    return (await service.comments(ref)).length;
  } catch {
    return undefined;
  }
}

/** Human-readable diffs between two issue snapshots, most specific first. Empty means "no real, describable change" even if fetched_at moved. */
function diffIssueSnapshot(
  previous: { status: string; updatedAt?: string; commentCount?: number } | undefined,
  current: { status: string; updatedAt?: string; commentCount?: number },
): string[] {
  if (!previous) return [];
  const changes: string[] = [];
  if (current.status !== previous.status) changes.push(`status: ${previous.status} -> ${current.status}`);
  if (current.commentCount !== undefined && previous.commentCount !== undefined && current.commentCount > previous.commentCount) {
    const added = current.commentCount - previous.commentCount;
    changes.push(`${added} new comment${added === 1 ? "" : "s"}`);
  }
  // A generic fallback for a backend-reported update this diff can't further characterize (a field
  // edit, a label/assignee change, ...) -- only surfaced when nothing more specific already explains
  // it, so a status change never also reports a redundant "updated".
  if (changes.length === 0 && current.updatedAt !== undefined && current.updatedAt !== previous.updatedAt) {
    changes.push("updated");
  }
  return changes;
}

export interface IssueWatchChange {
  ref: string;
  changes: string[];
}

/** One tick: fetches every due watched issue once (deduped across subscribers), diffs, and records a WatchEvent per real change. */
export async function syncIssueWatches(
  service: TicketService,
  watches: WatchStore,
  logger: Logger = NOOP_LOGGER,
  onChange?: (change: IssueWatchChange) => void,
  now: () => number = Date.now,
): Promise<void> {
  const groups = groupBy(watches.issueSubscriptions(), (s: IssueWatchSubscription) => s.ref);
  const nowMs = now();
  const due = [...groups.entries()].filter(([, subs]) => subs.some((s) => isDue(s, nowMs)));

  await Promise.all(
    due.map(async ([ref, subs]) => {
      try {
        const issue = await service.get(ref);
        const commentCount = await tryCommentCount(service, ref);
        const previous = watches.getIssueSnapshot(ref);
        const fetchedAt = new Date(nowMs);
        watches.upsertIssueSnapshot({ ref, status: issue.status, updatedAt: issue.updatedAt, commentCount: commentCount ?? 0, fetchedAt });

        const changes = diffIssueSnapshot(
          previous ? { status: previous.status, updatedAt: previous.updatedAt, commentCount: previous.commentCount } : undefined,
          { status: issue.status, updatedAt: issue.updatedAt, commentCount },
        );
        if (changes.length > 0) {
          const message = `${ref} (${issue.title}): ${changes.join(", ")}`;
          watches.recordEvent("issue", ref, message, fetchedAt);
          onChange?.({ ref, changes });
        }
        for (const subscription of subs) watches.markIssueChecked(ref, subscription.subscriberId, fetchedAt);
      } catch (error) {
        logger.warn("issue watch sync failed for one ref", { ref, error: error instanceof Error ? error.message : String(error) });
      }
    }),
  );
}

export interface QueryWatchChange {
  name: string;
  added: string[];
  removed: string[];
}

/** One tick: re-runs every due watched saved query once, diffs the *set* of matching refs against last time, and records a WatchEvent when items appeared or dropped out. */
export async function syncQueryWatches(
  service: TicketService,
  queries: SavedQueryStore,
  watches: WatchStore,
  logger: Logger = NOOP_LOGGER,
  onChange?: (change: QueryWatchChange) => void,
  now: () => number = Date.now,
): Promise<void> {
  const groups = groupBy(watches.queryWatchSubscriptions(), (s: QueryWatchSubscription) => s.name);
  const nowMs = now();
  const due = [...groups.entries()].filter(([, subs]) => subs.some((s) => isDue(s, nowMs)));

  await Promise.all(
    due.map(async ([name, subs]) => {
      try {
        const saved = queries.get(name);
        if (!saved) {
          logger.warn("watched saved query no longer exists", { name });
          return;
        }
        const issues = await service.runQuery(saved.backend, saved.query, DEFAULT_QUERY_WATCH_LIMIT);
        const refs = issues.map((issue) => issue.ref);
        const previous = watches.getQuerySnapshot(name);
        const fetchedAt = new Date(nowMs);
        watches.upsertQuerySnapshot({ name, refs, fetchedAt });

        if (previous) {
          const previousSet = new Set(previous.refs);
          const currentSet = new Set(refs);
          const added = refs.filter((ref) => !previousSet.has(ref));
          const removed = previous.refs.filter((ref) => !currentSet.has(ref));
          if (added.length > 0 || removed.length > 0) {
            const parts: string[] = [];
            if (added.length > 0) parts.push(`${added.length} new: ${added.join(", ")}`);
            if (removed.length > 0) parts.push(`${removed.length} dropped out: ${removed.join(", ")}`);
            const message = `"${name}": ${parts.join("; ")}`;
            watches.recordEvent("query", name, message, fetchedAt);
            onChange?.({ name, added, removed });
          }
        }
        for (const subscription of subs) watches.markQueryChecked(name, subscription.subscriberId, fetchedAt);
      } catch (error) {
        logger.warn("query watch sync failed for one saved query", { name, error: error instanceof Error ? error.message : String(error) });
      }
    }),
  );
}

/** MaintenanceTask wrapper for syncIssueWatches -- reads watches.issueSubscriptions() fresh every tick, so an empty watch list means this tick does no live fetches at all (see this module's own doc comment). */
export function createIssueWatchSyncTask(
  service: TicketService,
  watches: WatchStore,
  intervalMs: number,
  logger?: Logger,
  onChange?: (change: IssueWatchChange) => void,
): MaintenanceTask {
  return {
    name: "issue-watch-sync",
    intervalMs,
    run: () => syncIssueWatches(service, watches, logger, onChange),
  };
}

/** MaintenanceTask wrapper for syncQueryWatches -- same empty-watch-list-is-a-no-op shape as createIssueWatchSyncTask. */
export function createQueryWatchSyncTask(
  service: TicketService,
  queries: SavedQueryStore,
  watches: WatchStore,
  intervalMs: number,
  logger?: Logger,
  onChange?: (change: QueryWatchChange) => void,
): MaintenanceTask {
  return {
    name: "query-watch-sync",
    intervalMs,
    run: () => syncQueryWatches(service, queries, watches, logger, onChange),
  };
}
