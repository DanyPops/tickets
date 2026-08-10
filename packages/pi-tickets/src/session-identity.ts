/**
 * Client-side cache for this session's own registered session_secret (see
 * @danypops/tickets' rpc/server.ts / sqlite/session-identity.ts's own doc
 * comments for why this exists at all: the daemon authenticates every
 * client with one shared bearer token, so an explicit sessionId on the raw
 * /api/v1/ops path -- the only path tui.ts and issue-list-view.ts ever use,
 * since neither goes through Vehicle -- would otherwise be forgeable by any
 * other local caller holding that same token). Registered at session_start
 * and released at session_shutdown (see tui.ts). Keyed by sessionId (not a
 * single "current" variable) defensively, mirroring Papyrus's own
 * pi-papyrus/extension/src/session-identity.ts.
 */
const secretsBySessionId = new Map<string, string>();

export function cacheSessionSecret(sessionId: string, secret: string): void {
  secretsBySessionId.set(sessionId, secret);
}

export function forgetSessionSecret(sessionId: string): void {
  secretsBySessionId.delete(sessionId);
}

/** Test-only escape hatch for this module's otherwise-unresettable singleton cache -- without it, one test's cacheSessionSecret() for a given sessionId (e.g. the common "test-session" default) leaks into every later test in the same process that reuses that id. */
export function resetSessionSecretsForTests(): void {
  secretsBySessionId.clear();
}

/** Spread into any focus.*-mutating request body alongside sessionId -- empty object when no secret is cached for this sessionId (unregistered, or registration hasn't completed yet), matching the daemon's opt-in-armor default. */
export function sessionSecretField(sessionId: string | undefined): { sessionSecret?: string } {
  const secret = sessionId ? secretsBySessionId.get(sessionId) : undefined;
  return secret ? { sessionSecret: secret } : {};
}

/** Every field a focus.* call needs to land on (and, once registered, be authorized against) this session's own scope. */
export function focusSessionFields(sessionId: string): { sessionId: string; sessionSecret?: string } {
  return { sessionId, ...sessionSecretField(sessionId) };
}
