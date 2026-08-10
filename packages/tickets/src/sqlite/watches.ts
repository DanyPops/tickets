/**
 * Watches — the daemon's local subscription + last-known-snapshot store for individual issues
 * and saved queries, mirroring @danypops/pipes' own job_watches/run_snapshots split
 * (packages/pipes/src/sqlite/run-pool.ts) one domain over: `issue_watches`/`query_watches` are
 * the authoritative subscription lists the background sync tasks (process/watch-sync.ts) iterate;
 * `issue_watch_snapshots`/`query_watch_snapshots` hold each watched key's last-observed state,
 * independent of subscriptions, so a sync tick can tell "did this actually change" apart from
 * "this is the first time we've ever looked." `watch_events` is the append-only, cursor-readable
 * change log a client polls (watch.events) instead of re-deriving a diff itself.
 *
 * Deliberately does NOT auto-unsubscribe on any kind of "terminal" state the way run_snapshots
 * does for a finished CI run: an issue can be reopened and a saved query's result set has no
 * notion of "done" at all, so nothing here is a permanent completion signal worth stopping a
 * background poll over. A subscription only ever ends via an explicit issue.unsubscribe/
 * query.unsubscribe call.
 */
import type { Database } from "bun:sqlite";
import type { Migration } from "@danypops/vehicle-server/storage";

export const WATCH_MIGRATIONS: Migration[] = [
  {
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE issue_watches (
          ref TEXT NOT NULL,
          subscriber_id TEXT NOT NULL DEFAULT '',
          schedule_ms INTEGER,
          last_checked_at INTEGER,
          project_root TEXT,
          PRIMARY KEY (ref, subscriber_id)
        );
        CREATE TABLE issue_watch_snapshots (
          ref TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          updated_at TEXT,
          comment_count INTEGER NOT NULL DEFAULT 0,
          fetched_at INTEGER NOT NULL
        );
        CREATE TABLE query_watches (
          name TEXT NOT NULL,
          subscriber_id TEXT NOT NULL DEFAULT '',
          schedule_ms INTEGER,
          last_checked_at INTEGER,
          project_root TEXT,
          PRIMARY KEY (name, subscriber_id)
        );
        CREATE TABLE query_watch_snapshots (
          name TEXT PRIMARY KEY,
          refs_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
        );
        CREATE TABLE watch_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          key TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX watch_events_kind_key_idx ON watch_events(kind, key);
      `);
    },
  },
];

export interface IssueWatchSubscription {
  ref: string;
  subscriberId: string;
  scheduleMs?: number;
  lastCheckedAt?: Date;
  projectRoot?: string;
}

export interface QueryWatchSubscription {
  name: string;
  subscriberId: string;
  scheduleMs?: number;
  lastCheckedAt?: Date;
  projectRoot?: string;
}

export interface IssueWatchSnapshot {
  ref: string;
  status: string;
  updatedAt?: string;
  commentCount: number;
  fetchedAt: Date;
}

export interface QueryWatchSnapshot {
  name: string;
  refs: string[];
  fetchedAt: Date;
}

export type WatchEventKind = "issue" | "query";

export interface WatchEvent {
  id: number;
  kind: WatchEventKind;
  /** The watched issue's ref, or the watched query's name. */
  key: string;
  message: string;
  createdAt: Date;
}

interface IssueWatchRow {
  ref: string;
  subscriber_id: string;
  schedule_ms: number | null;
  last_checked_at: number | null;
  project_root: string | null;
}

interface QueryWatchRow {
  name: string;
  subscriber_id: string;
  schedule_ms: number | null;
  last_checked_at: number | null;
  project_root: string | null;
}

function toIssueSubscription(row: IssueWatchRow): IssueWatchSubscription {
  return {
    ref: row.ref,
    subscriberId: row.subscriber_id,
    scheduleMs: row.schedule_ms ?? undefined,
    lastCheckedAt: row.last_checked_at !== null ? new Date(row.last_checked_at) : undefined,
    projectRoot: row.project_root ?? undefined,
  };
}

function toQuerySubscription(row: QueryWatchRow): QueryWatchSubscription {
  return {
    name: row.name,
    subscriberId: row.subscriber_id,
    scheduleMs: row.schedule_ms ?? undefined,
    lastCheckedAt: row.last_checked_at !== null ? new Date(row.last_checked_at) : undefined,
    projectRoot: row.project_root ?? undefined,
  };
}

export class WatchStore {
  constructor(private readonly db: Database) {}

  // ---- issue watches ----

  subscribeIssue(ref: string, options?: { subscriberId?: string; scheduleMs?: number; projectRoot?: string }): void {
    const subscriberId = options?.subscriberId ?? "";
    this.db
      .query(
        `INSERT INTO issue_watches (ref, subscriber_id, schedule_ms, project_root)
         VALUES ($ref, $subscriberId, $scheduleMs, $projectRoot)
         ON CONFLICT(ref, subscriber_id) DO UPDATE SET schedule_ms = excluded.schedule_ms, project_root = excluded.project_root`,
      )
      .run({
        $ref: ref,
        $subscriberId: subscriberId,
        $scheduleMs: options?.scheduleMs ?? null,
        $projectRoot: options?.projectRoot ?? null,
      });
  }

  unsubscribeIssue(ref: string, subscriberId = ""): void {
    this.db
      .query("DELETE FROM issue_watches WHERE ref = $ref AND subscriber_id = $subscriberId")
      .run({ $ref: ref, $subscriberId: subscriberId });
  }

  isIssueSubscribed(ref: string, subscriberId = ""): boolean {
    return (
      this.db.query("SELECT 1 FROM issue_watches WHERE ref = $ref AND subscriber_id = $subscriberId").get({
        $ref: ref,
        $subscriberId: subscriberId,
      }) !== null
    );
  }

  /** Every individual issue subscription -- what the sync task iterates. */
  issueSubscriptions(): IssueWatchSubscription[] {
    const rows = this.db.query("SELECT * FROM issue_watches").all() as IssueWatchRow[];
    return rows.map(toIssueSubscription);
  }

  /** Subscriptions scoped to one subscriber -- what issue.subscribed returns. */
  issueSubscriptionsFor(subscriberId: string): IssueWatchSubscription[] {
    const rows = this.db.query("SELECT * FROM issue_watches WHERE subscriber_id = $subscriberId").all({
      $subscriberId: subscriberId,
    }) as IssueWatchRow[];
    return rows.map(toIssueSubscription);
  }

  markIssueChecked(ref: string, subscriberId: string, at: Date): void {
    this.db
      .query("UPDATE issue_watches SET last_checked_at = $at WHERE ref = $ref AND subscriber_id = $subscriberId")
      .run({ $at: at.getTime(), $ref: ref, $subscriberId: subscriberId });
  }

  getIssueSnapshot(ref: string): IssueWatchSnapshot | undefined {
    const row = this.db.query("SELECT * FROM issue_watch_snapshots WHERE ref = $ref").get({ $ref: ref }) as {
      ref: string;
      status: string;
      updated_at: string | null;
      comment_count: number;
      fetched_at: number;
    } | null;
    if (!row) return undefined;
    return {
      ref: row.ref,
      status: row.status,
      updatedAt: row.updated_at ?? undefined,
      commentCount: row.comment_count,
      fetchedAt: new Date(row.fetched_at),
    };
  }

  upsertIssueSnapshot(snapshot: IssueWatchSnapshot): void {
    this.db
      .query(
        `INSERT INTO issue_watch_snapshots (ref, status, updated_at, comment_count, fetched_at)
         VALUES ($ref, $status, $updatedAt, $commentCount, $fetchedAt)
         ON CONFLICT(ref) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, comment_count = excluded.comment_count, fetched_at = excluded.fetched_at`,
      )
      .run({
        $ref: snapshot.ref,
        $status: snapshot.status,
        $updatedAt: snapshot.updatedAt ?? null,
        $commentCount: snapshot.commentCount,
        $fetchedAt: snapshot.fetchedAt.getTime(),
      });
  }

  // ---- query watches ----

  subscribeQuery(name: string, options?: { subscriberId?: string; scheduleMs?: number; projectRoot?: string }): void {
    const subscriberId = options?.subscriberId ?? "";
    this.db
      .query(
        `INSERT INTO query_watches (name, subscriber_id, schedule_ms, project_root)
         VALUES ($name, $subscriberId, $scheduleMs, $projectRoot)
         ON CONFLICT(name, subscriber_id) DO UPDATE SET schedule_ms = excluded.schedule_ms, project_root = excluded.project_root`,
      )
      .run({
        $name: name,
        $subscriberId: subscriberId,
        $scheduleMs: options?.scheduleMs ?? null,
        $projectRoot: options?.projectRoot ?? null,
      });
  }

  unsubscribeQuery(name: string, subscriberId = ""): void {
    this.db
      .query("DELETE FROM query_watches WHERE name = $name AND subscriber_id = $subscriberId")
      .run({ $name: name, $subscriberId: subscriberId });
  }

  isQuerySubscribed(name: string, subscriberId = ""): boolean {
    return (
      this.db.query("SELECT 1 FROM query_watches WHERE name = $name AND subscriber_id = $subscriberId").get({
        $name: name,
        $subscriberId: subscriberId,
      }) !== null
    );
  }

  queryWatchSubscriptions(): QueryWatchSubscription[] {
    const rows = this.db.query("SELECT * FROM query_watches").all() as QueryWatchRow[];
    return rows.map(toQuerySubscription);
  }

  queryWatchSubscriptionsFor(subscriberId: string): QueryWatchSubscription[] {
    const rows = this.db.query("SELECT * FROM query_watches WHERE subscriber_id = $subscriberId").all({
      $subscriberId: subscriberId,
    }) as QueryWatchRow[];
    return rows.map(toQuerySubscription);
  }

  markQueryChecked(name: string, subscriberId: string, at: Date): void {
    this.db
      .query("UPDATE query_watches SET last_checked_at = $at WHERE name = $name AND subscriber_id = $subscriberId")
      .run({ $at: at.getTime(), $name: name, $subscriberId: subscriberId });
  }

  getQuerySnapshot(name: string): QueryWatchSnapshot | undefined {
    const row = this.db.query("SELECT * FROM query_watch_snapshots WHERE name = $name").get({ $name: name }) as {
      name: string;
      refs_json: string;
      fetched_at: number;
    } | null;
    if (!row) return undefined;
    return { name: row.name, refs: JSON.parse(row.refs_json) as string[], fetchedAt: new Date(row.fetched_at) };
  }

  upsertQuerySnapshot(snapshot: QueryWatchSnapshot): void {
    this.db
      .query(
        `INSERT INTO query_watch_snapshots (name, refs_json, fetched_at)
         VALUES ($name, $refsJson, $fetchedAt)
         ON CONFLICT(name) DO UPDATE SET refs_json = excluded.refs_json, fetched_at = excluded.fetched_at`,
      )
      .run({ $name: snapshot.name, $refsJson: JSON.stringify(snapshot.refs), $fetchedAt: snapshot.fetchedAt.getTime() });
  }

  // ---- change events ----

  /** Appends one change event -- called only by the sync tasks, once per real diff. */
  recordEvent(kind: WatchEventKind, key: string, message: string, at: Date = new Date()): void {
    this.db
      .query("INSERT INTO watch_events (kind, key, message, created_at) VALUES ($kind, $key, $message, $createdAt)")
      .run({ $kind: kind, $key: key, $message: message, $createdAt: at.getTime() });
  }

  /**
   * Events since `sinceId` (exclusive), newest-last, bounded by `limit`, scoped to keys the given
   * subscriber is *currently* subscribed to (an EXISTS join against issue_watches/query_watches --
   * same scoping shape run-pool.ts's watchedRunsWithProjectLabels already uses for subscriberId).
   * An event for a key this subscriber never subscribed to, or already unsubscribed from, never
   * appears here -- avoids a global firehose leaking one session's watches into another's.
   */
  eventsSince(subscriberId: string, sinceId: number, limit = 100): WatchEvent[] {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db
      .query(
        `SELECT * FROM watch_events
         WHERE id > $sinceId
           AND (
             (kind = 'issue' AND EXISTS (SELECT 1 FROM issue_watches WHERE issue_watches.ref = watch_events.key AND issue_watches.subscriber_id = $subscriberId))
             OR
             (kind = 'query' AND EXISTS (SELECT 1 FROM query_watches WHERE query_watches.name = watch_events.key AND query_watches.subscriber_id = $subscriberId))
           )
         ORDER BY id ASC
         LIMIT $limit`,
      )
      .all({ $sinceId: sinceId, $subscriberId: subscriberId, $limit: bounded }) as Array<{
      id: number;
      kind: string;
      key: string;
      message: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as WatchEventKind,
      key: row.key,
      message: row.message,
      createdAt: new Date(row.created_at),
    }));
  }

  /** The highest event id recorded so far, or 0 if none -- lets a fresh subscriber start its cursor at "now" instead of replaying every historical event. */
  latestEventId(): number {
    const row = this.db.query("SELECT MAX(id) as max_id FROM watch_events").get() as { max_id: number | null } | null;
    return row?.max_id ?? 0;
  }
}
