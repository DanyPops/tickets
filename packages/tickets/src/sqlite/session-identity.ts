/**
 * Sqlite-backed SessionIdentityStore adapter for @danypops/vehicle-server's own
 * generic session-identity primitive (secret generation/hashing/constant-time
 * verify) -- this file only wires that primitive to sqlite, the same split
 * Papyrus's own stores/sqlite-session-identity-store.ts makes.
 *
 * Hardens the one place a caller-supplied session id becomes BEHAVIOR-affecting
 * in this daemon: focus.set/pause/unpause/clear, once a caller passes an EXPLICIT
 * sessionId (see rpc/server.ts's own TICKET_OP_HANDLERS) -- this daemon, like
 * Papyrus's, authenticates every client with one shared bearer token, so a bare
 * session id alone is not a credential once it can redirect/pause/clear someone
 * else's live Focus. Opt-in armor: a session id that was never registered
 * (the implicit callContext.callerSessionId default from a real Vehicle tool
 * call, or a bare CLI caller) passes through unarmored, exactly as today.
 */
import type { Database } from "bun:sqlite";
import type { SessionIdentityRecord, SessionIdentityStore } from "@danypops/vehicle-server/session-identity";
import type { Migration } from "@danypops/vehicle-server/storage";

/** An explicit sessionId claim (see rpc/server.ts's resolveFocusScope) against a REGISTERED session id, with a missing or wrong sessionSecret. Maps to HTTP 401, not 400 -- this is an authorization failure, not a validation one. */
export class SessionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionAuthError";
  }
}

export const SESSION_IDENTITY_MIGRATIONS: Migration[] = [
  {
    version: 6,
    up: (db) => {
      db.exec(`
        CREATE TABLE session_identities (
          session_id TEXT PRIMARY KEY,
          secret_hash TEXT NOT NULL,
          registered_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );
      `);
    },
  },
];

interface SessionIdentityRow {
  session_id: string;
  secret_hash: string;
  registered_at: string;
  last_seen_at: string;
}

function rowToRecord(row: SessionIdentityRow): SessionIdentityRecord {
  return { sessionId: row.session_id, secretHash: row.secret_hash, registeredAt: row.registered_at, lastSeenAt: row.last_seen_at };
}

export class SqliteSessionIdentityStore implements SessionIdentityStore {
  constructor(private readonly db: Database) {}

  find(sessionId: string): SessionIdentityRecord | undefined {
    const row = this.db
      .query("SELECT session_id, secret_hash, registered_at, last_seen_at FROM session_identities WHERE session_id = $sessionId")
      .get({ $sessionId: sessionId }) as SessionIdentityRow | null;
    return row ? rowToRecord(row) : undefined;
  }

  upsert(record: SessionIdentityRecord): void {
    this.db
      .query(
        `INSERT INTO session_identities (session_id, secret_hash, registered_at, last_seen_at)
         VALUES ($sessionId, $secretHash, $registeredAt, $lastSeenAt)
         ON CONFLICT(session_id) DO UPDATE SET
           secret_hash = excluded.secret_hash, registered_at = excluded.registered_at, last_seen_at = excluded.last_seen_at`,
      )
      .run({
        $sessionId: record.sessionId,
        $secretHash: record.secretHash,
        $registeredAt: record.registeredAt,
        $lastSeenAt: record.lastSeenAt,
      });
  }

  remove(sessionId: string): void {
    this.db.query("DELETE FROM session_identities WHERE session_id = $sessionId").run({ $sessionId: sessionId });
  }

  touch(sessionId: string, lastSeenAt: string): void {
    this.db
      .query("UPDATE session_identities SET last_seen_at = $lastSeenAt WHERE session_id = $sessionId")
      .run({ $sessionId: sessionId, $lastSeenAt: lastSeenAt });
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS count FROM session_identities").get() as { count: number }).count;
  }
}
