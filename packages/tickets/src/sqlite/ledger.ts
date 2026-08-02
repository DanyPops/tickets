/**
 * Ledger — the daemon's local, independent pool of every issue it has seen.
 * Mirrors emcee's SQLite Ledger concept: a passively-populated local index
 * that keeps working (search, stats, last-known state) even when a backend
 * is slow, rate-limited, or unreachable. Populated by poller.ts on its own
 * schedule; queried directly by ledger.search / ledger.stats ops, independent
 * of any live upstream call.
 */
import type { Database } from "bun:sqlite";
import type { Migration } from "@danypops/vehicle-server/storage";
import type { Issue } from "../domain/issue.js";

export const LEDGER_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE issues (
          ref TEXT PRIMARY KEY,
          backend TEXT NOT NULL,
          key TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          priority TEXT NOT NULL,
          url TEXT,
          updated_at TEXT,
          synced_at TEXT NOT NULL,
          raw_json TEXT NOT NULL
        );
        CREATE INDEX idx_issues_backend ON issues (backend);
        CREATE INDEX idx_issues_title ON issues (title);
      `);
    },
  },
];

interface IssueRow {
  ref: string;
  backend: string;
  key: string;
  title: string;
  status: string;
  priority: string;
  url: string | null;
  updated_at: string | null;
  synced_at: string;
  raw_json: string;
}

function rowToIssue(row: IssueRow): Issue {
  return JSON.parse(row.raw_json) as Issue;
}

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

export class Ledger {
  constructor(private readonly db: Database) {}

  upsert(backend: string, issue: Issue): void {
    this.db
      .query(
        `INSERT INTO issues (ref, backend, key, title, status, priority, url, updated_at, synced_at, raw_json)
         VALUES ($ref, $backend, $key, $title, $status, $priority, $url, $updatedAt, $syncedAt, $rawJson)
         ON CONFLICT(ref) DO UPDATE SET
           title = excluded.title,
           status = excluded.status,
           priority = excluded.priority,
           url = excluded.url,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at,
           raw_json = excluded.raw_json`,
      )
      .run({
        $ref: issue.ref,
        $backend: backend,
        $key: issue.key,
        $title: issue.title,
        $status: issue.status,
        $priority: issue.priority,
        $url: issue.url ?? null,
        $updatedAt: issue.updatedAt ?? null,
        $syncedAt: new Date().toISOString(),
        $rawJson: JSON.stringify(issue),
      });
  }

  upsertMany(backend: string, issues: Issue[]): number {
    const tx = this.db.transaction((rows: Issue[]) => {
      for (const issue of rows) this.upsert(backend, issue);
    });
    tx(issues);
    return issues.length;
  }

  get(ref: string): Issue | undefined {
    const row = this.db.query("SELECT * FROM issues WHERE ref = ?").get(ref) as IssueRow | null;
    return row ? rowToIssue(row) : undefined;
  }

  /** Bounded LIKE search over title, newest-synced first, optionally scoped to one backend. Explicit limit, capped hard. */
  search(query: string, limit = DEFAULT_SEARCH_LIMIT, backend?: string): Issue[] {
    const bounded = Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT);
    if (backend) {
      const rows = this.db
        .query("SELECT * FROM issues WHERE title LIKE ? AND backend = ? ORDER BY synced_at DESC LIMIT ?")
        .all(`%${query}%`, backend, bounded) as IssueRow[];
      return rows.map(rowToIssue);
    }
    const rows = this.db
      .query("SELECT * FROM issues WHERE title LIKE ? ORDER BY synced_at DESC LIMIT ?")
      .all(`%${query}%`, bounded) as IssueRow[];
    return rows.map(rowToIssue);
  }

  listByBackend(backend: string, limit = DEFAULT_SEARCH_LIMIT): Issue[] {
    const bounded = Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT);
    const rows = this.db
      .query("SELECT * FROM issues WHERE backend = ? ORDER BY synced_at DESC LIMIT ?")
      .all(backend, bounded) as IssueRow[];
    return rows.map(rowToIssue);
  }

  stats(): { backend: string; count: number }[] {
    const rows = this.db.query("SELECT backend, COUNT(*) as count FROM issues GROUP BY backend ORDER BY backend").all() as {
      backend: string;
      count: number;
    }[];
    return rows;
  }
}
