/**
 * Local, per-backend persistence for delegated OAuth tokens — separate from
 * daemon-kit's own daemon-auth token (paths.token, which authenticates RPC
 * callers to the daemon). This one holds what the daemon uses to authenticate
 * *to* GitHub/GitLab/Jira on the user's behalf. Same security posture as
 * daemon-kit's ensureAuthToken: 0700 directory, 0600 files, atomic write.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** ISO timestamp; absent means the provider issued a non-expiring token. */
  expiresAt?: string;
  scope?: string;
  /** Backend-specific extras that don't fit the common shape, e.g. Jira's cloudId. */
  extra?: Record<string, string>;
}

export interface TokenStoreEnv {
  env?: Record<string, string | undefined>;
  home?: string;
}

export function tokenStoreDir(opts: TokenStoreEnv = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(stateHome, "tickets", "oauth");
}

function tokenPath(backend: string, opts: TokenStoreEnv = {}): string {
  return join(tokenStoreDir(opts), `${backend}.json`);
}

export function saveToken(backend: string, token: StoredToken, opts: TokenStoreEnv = {}): void {
  const path = tokenPath(backend, opts);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function loadToken(backend: string, opts: TokenStoreEnv = {}): StoredToken | undefined {
  const path = tokenPath(backend, opts);
  if (!existsSync(path)) return undefined;
  chmodSync(path, 0o600);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredToken;
  } catch {
    return undefined;
  }
}

export function deleteToken(backend: string, opts: TokenStoreEnv = {}): void {
  rmSync(tokenPath(backend, opts), { force: true });
}

export function listStoredBackends(opts: TokenStoreEnv = {}): string[] {
  const dir = tokenStoreDir(opts);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
}

/** A token is usable if it has no expiry, or expires more than `skewMs` from now. */
export function isTokenFresh(token: StoredToken, skewMs = 60_000): boolean {
  if (!token.expiresAt) return true;
  return new Date(token.expiresAt).getTime() - Date.now() > skewMs;
}
