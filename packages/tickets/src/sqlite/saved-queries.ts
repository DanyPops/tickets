/**
 * Saved queries — a name plus a raw query string (Jira JQL today; the backend
 * decides what "raw query" means via issue/repository.ts's RawQueryable) that
 * can be run again by name instead of re-typing the query every time. This is
 * how a board/backlog view (e.g. a Jira board's quickFilter, or its backlog's
 * customFilter) becomes something the CLI/TUI/tool surface can browse
 * directly: resolve the view's real query once (see JiraRepository's
 * getBoardQuickFilterJql/getBoardViewIssues), then save the result under a
 * name once and just run it by name from then on.
 */
import type { Database } from "bun:sqlite";
import type { Migration } from "@danypops/vehicle-server/storage";

export const SAVED_QUERY_MIGRATIONS: Migration[] = [
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE saved_query (
          name TEXT PRIMARY KEY,
          backend TEXT NOT NULL,
          query TEXT NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];

export class SavedQueryNotFoundError extends Error {
  constructor(name: string) {
    super(`no saved query named "${name}"`);
    this.name = "SavedQueryNotFoundError";
  }
}

export interface SavedQuery {
  name: string;
  backend: string;
  query: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

interface SavedQueryRow {
  name: string;
  backend: string;
  query: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSavedQuery(row: SavedQueryRow): SavedQuery {
  return {
    name: row.name,
    backend: row.backend,
    query: row.query,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SavedQueryStore {
  constructor(private readonly db: Database) {}

  /** Creates or overwrites a saved query by name -- saving under an existing name updates it in place rather than erroring, matching the "save this view under a name" mental model (re-saving after a query changed shouldn't require a delete first). */
  save(name: string, backend: string, query: string, description?: string): SavedQuery {
    const now = new Date().toISOString();
    const existing = this.get(name);
    const createdAt = existing?.createdAt ?? now;
    this.db
      .query(
        `INSERT INTO saved_query (name, backend, query, description, created_at, updated_at)
         VALUES ($name, $backend, $query, $description, $createdAt, $updatedAt)
         ON CONFLICT(name) DO UPDATE SET
           backend = excluded.backend, query = excluded.query, description = excluded.description, updated_at = excluded.updated_at`,
      )
      .run({ $name: name, $backend: backend, $query: query, $description: description ?? null, $createdAt: createdAt, $updatedAt: now });
    return { name, backend, query, description, createdAt, updatedAt: now };
  }

  get(name: string): SavedQuery | undefined {
    const row = this.db.query("SELECT * FROM saved_query WHERE name = $name").get({ $name: name }) as SavedQueryRow | null;
    return row ? rowToSavedQuery(row) : undefined;
  }

  list(): SavedQuery[] {
    const rows = this.db.query("SELECT * FROM saved_query ORDER BY name ASC").all() as SavedQueryRow[];
    return rows.map(rowToSavedQuery);
  }

  /** Idempotent -- removing a name that doesn't exist is a no-op, not an error, matching this codebase's own undepend/uncontain convention for "already absent". */
  remove(name: string): boolean {
    const result = this.db.query("DELETE FROM saved_query WHERE name = $name").run({ $name: name });
    return result.changes > 0;
  }
}
