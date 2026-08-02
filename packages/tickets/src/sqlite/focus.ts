/**
 * Focus — the single ticket currently being worked on, independent of any
 * one CLI invocation or tool call. Unlike the Ledger (a cache of every issue
 * the daemon has ever seen), Focus is a pointer: one ref, its resolved title
 * and full web URL, and whether work on it is active or paused. Persisted
 * so it survives daemon restarts. A singleton by design — there is never
 * more than one ticket in focus at a time, so setting focus always replaces
 * whatever was there, the same way switching your attention to a different
 * ticket in real life replaces what you were just looking at.
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

interface FocusRow {
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

  get(): TicketFocusState | undefined {
    const row = this.db
      .query("SELECT ref, title, url, status, pause_reason, updated_at FROM ticket_focus WHERE id = 1")
      .get() as FocusRow | null;
    return row ? rowToState(row) : undefined;
  }

  /** Always lands "active" and drops any prior pause reason: switching focus onto a different ticket is not the same as resuming a pause on the old one. */
  set(ref: string, title: string, url: string): TicketFocusState {
    const updatedAt = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO ticket_focus (id, ref, title, url, status, pause_reason, updated_at)
         VALUES (1, $ref, $title, $url, 'active', NULL, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           ref = excluded.ref, title = excluded.title, url = excluded.url,
           status = 'active', pause_reason = NULL, updated_at = excluded.updated_at`,
      )
      .run({ $ref: ref, $title: title, $url: url, $updatedAt: updatedAt });
    return { ref, title, url, status: "active", updatedAt };
  }

  pause(reason?: string): TicketFocusState {
    const current = this.get();
    if (!current) throw new FocusError("no ticket is currently focused");
    if (current.status === "paused") throw new FocusError(`focus on "${current.ref}" is already paused`);
    return this.transition("paused", reason);
  }

  unpause(): TicketFocusState {
    const current = this.get();
    if (!current) throw new FocusError("no ticket is currently focused");
    if (current.status === "active") throw new FocusError(`focus on "${current.ref}" is already active`);
    return this.transition("active", undefined);
  }

  /** Returns whether a focus existed to clear (idempotent either way). */
  clear(): boolean {
    const existed = this.get() !== undefined;
    this.db.exec("DELETE FROM ticket_focus WHERE id = 1");
    return existed;
  }

  private transition(status: FocusStatus, reason: string | undefined): TicketFocusState {
    const updatedAt = new Date().toISOString();
    this.db
      .query("UPDATE ticket_focus SET status = $status, pause_reason = $reason, updated_at = $updatedAt WHERE id = 1")
      .run({ $status: status, $reason: reason ?? null, $updatedAt: updatedAt });
    // Non-null: transition() is only ever called right after get() confirmed a row exists.
    return this.get()!;
  }
}
