/**
 * Focus — the ticket currently being worked on, independent of any one CLI
 * invocation or tool call. Unlike the Ledger (a cache of every issue the
 * daemon has ever seen), Focus is a pointer: one ref, its resolved title
 * and full web URL, and whether work on it is active or paused. Persisted
 * so it survives daemon restarts.
 *
 * One Focus per *scope*, not a single global singleton -- mirrors Papyrus's
 * own Task Focus (stores/task-focus-store.ts / stores/sqlite-task-focus-store.ts)
 * one domain over: a scope defaults to "global" for a caller that doesn't
 * supply one (the bare CLI, legacy behavior, exactly today's pre-scoping
 * shape), but is normally the requesting Pi session's own id, so two
 * concurrent agents/terminals each get their own Focus instead of
 * clobbering a shared one.
 */
import type { Database } from "bun:sqlite";
import type { Migration } from "@danypops/vehicle-server/storage";

export const FOCUS_MIGRATIONS: Migration[] = [
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE ticket_focus (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          ref TEXT NOT NULL,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          status TEXT NOT NULL,
          pause_reason TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Re-keys ticket_focus from a hardcoded id=1 singleton to one row per scope. Focus is a
    // pointer, not historical data -- dropping and recreating (rather than an in-place
    // ALTER TABLE + backfill) is a deliberate, acceptable loss of whatever was focused before
    // this migration runs, the same way Papyrus's own equivalent migration didn't attempt to
    // carry a pre-scoping global focus forward into some arbitrary scope.
    version: 5,
    up: (db) => {
      db.exec("DROP TABLE IF EXISTS ticket_focus;");
      db.exec(`
        CREATE TABLE ticket_focus (
          scope TEXT PRIMARY KEY,
          ref TEXT NOT NULL,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          status TEXT NOT NULL,
          pause_reason TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];

export type FocusStatus = "active" | "paused";

export interface TicketFocusState {
  ref: string;
  title: string;
  url: string;
  status: FocusStatus;
  updatedAt: string;
  pauseReason?: string;
}

/** Invalid focus state transitions (nothing focused, double-pause, double-unpause) or a resolved issue with no URL to focus on. Maps to HTTP 400, not 500. */
export class FocusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FocusError";
  }
}

export const FOCUS_DEFAULT_SCOPE = "global";
export const FOCUS_SCOPE_MAX_LENGTH = 128;
/** Bounds distinct concurrent focus scopes (sessions); the least-recently-updated scope is evicted beyond this, mirroring Papyrus's TASK_FOCUS_MAX_SCOPES. */
export const FOCUS_MAX_SCOPES = 200;
/** A scope untouched this long is eligible for time-based reaping (see FocusStore.reapStale), independent of FOCUS_MAX_SCOPES's own eviction. 30 days, matching Papyrus's TASK_FOCUS_STALE_AFTER_MS convention. */
export const FOCUS_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** An absent/empty scope defaults to "global" -- the bare CLI / legacy single-focus behavior; a real scope (normally a Pi session id) passes through unchanged. */
export function normalizeFocusScope(scope: string | undefined): string {
  const value = scope && scope.length > 0 ? scope : FOCUS_DEFAULT_SCOPE;
  if (value.length > FOCUS_SCOPE_MAX_LENGTH) {
    throw new FocusError(`focus scope must be at most ${FOCUS_SCOPE_MAX_LENGTH} characters`);
  }
  return value;
}

interface FocusRow {
  scope: string;
  ref: string;
  title: string;
  url: string;
  status: FocusStatus;
  pause_reason: string | null;
  updated_at: string;
}

function rowToState(row: FocusRow): TicketFocusState {
  return {
    ref: row.ref,
    title: row.title,
    url: row.url,
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.pause_reason ? { pauseReason: row.pause_reason } : {}),
  };
}

export class FocusStore {
  constructor(private readonly db: Database) {}

  get(scope?: string): TicketFocusState | undefined {
    const row = this.db
      .query("SELECT scope, ref, title, url, status, pause_reason, updated_at FROM ticket_focus WHERE scope = $scope")
      .get({ $scope: normalizeFocusScope(scope) }) as FocusRow | null;
    return row ? rowToState(row) : undefined;
  }

  /** Always lands "active" and drops any prior pause reason: switching focus onto a different ticket is not the same as resuming a pause on the old one. */
  set(ref: string, title: string, url: string, scope?: string): TicketFocusState {
    const key = normalizeFocusScope(scope);
    const updatedAt = new Date().toISOString();
    this.evictOldestBeyondCap(key);
    this.db
      .query(
        `INSERT INTO ticket_focus (scope, ref, title, url, status, pause_reason, updated_at)
         VALUES ($scope, $ref, $title, $url, 'active', NULL, $updatedAt)
         ON CONFLICT(scope) DO UPDATE SET
           ref = excluded.ref, title = excluded.title, url = excluded.url,
           status = 'active', pause_reason = NULL, updated_at = excluded.updated_at`,
      )
      .run({ $scope: key, $ref: ref, $title: title, $url: url, $updatedAt: updatedAt });
    return { ref, title, url, status: "active", updatedAt };
  }

  pause(reason?: string, scope?: string): TicketFocusState {
    const current = this.get(scope);
    if (!current) throw new FocusError("no ticket is currently focused");
    if (current.status === "paused") throw new FocusError(`focus on "${current.ref}" is already paused`);
    return this.transition("paused", reason, scope);
  }

  unpause(scope?: string): TicketFocusState {
    const current = this.get(scope);
    if (!current) throw new FocusError("no ticket is currently focused");
    if (current.status === "active") throw new FocusError(`focus on "${current.ref}" is already active`);
    return this.transition("active", undefined, scope);
  }

  /** Returns whether a focus existed in this scope to clear (idempotent either way). */
  clear(scope?: string): boolean {
    const existed = this.get(scope) !== undefined;
    this.db.query("DELETE FROM ticket_focus WHERE scope = $scope").run({ $scope: normalizeFocusScope(scope) });
    return existed;
  }

  /** Deletes every scope's row whose updatedAt is strictly before olderThanIso (see FOCUS_STALE_AFTER_MS). Returns how many rows were removed. */
  reapStale(olderThanIso: string): number {
    return this.db.query("DELETE FROM ticket_focus WHERE updated_at < $cutoff").run({ $cutoff: olderThanIso }).changes;
  }

  private transition(status: FocusStatus, reason: string | undefined, scope: string | undefined): TicketFocusState {
    const key = normalizeFocusScope(scope);
    const updatedAt = new Date().toISOString();
    this.db
      .query("UPDATE ticket_focus SET status = $status, pause_reason = $reason, updated_at = $updatedAt WHERE scope = $scope")
      .run({ $scope: key, $status: status, $reason: reason ?? null, $updatedAt: updatedAt });
    // Non-null: transition() is only ever called right after get() confirmed a row exists for this scope.
    return this.get(key)!;
  }

  /** Evicts the least-recently-updated scope once a brand-new scope would push the total beyond FOCUS_MAX_SCOPES. A no-op for a scope that already has a row (set() on an existing scope never counts as growth). */
  private evictOldestBeyondCap(key: string): void {
    const exists = this.db.query("SELECT 1 FROM ticket_focus WHERE scope = $scope").get({ $scope: key });
    if (exists) return;
    const count = (this.db.query("SELECT COUNT(*) AS count FROM ticket_focus").get() as { count: number }).count;
    if (count < FOCUS_MAX_SCOPES) return;
    this.db.exec("DELETE FROM ticket_focus WHERE scope = (SELECT scope FROM ticket_focus ORDER BY updated_at ASC LIMIT 1)");
  }
}
