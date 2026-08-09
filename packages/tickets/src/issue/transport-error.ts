/**
 * Fail-closed transport classification shared by provider adapters.
 *
 * Only stable error names/codes emitted by the runtimes and HTTP clients we
 * use are accepted. Messages are deliberately ignored: they are unstable,
 * may contain credentials/URLs, and can make an arbitrary programming error
 * look like a network outage.
 */

export type BackendTransportFailureKind = "unreachable" | "timeout";

const TIMEOUT_CODES = new Set([
  "ABORT_ERR",
  "ECONNABORTED",
  "ERR_CANCELED",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const UNREACHABLE_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_NETWORK",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_SOCKET",
]);

const TIMEOUT_NAMES = new Set(["AbortError", "GitbeakerTimeoutError", "TimeoutError"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Returns undefined for every unreviewed/unknown exception. */
export function classifyBackendTransportFailure(error: unknown): BackendTransportFailureKind | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 6; depth++) {
    const candidate = record(current);
    if (!candidate || seen.has(current)) return undefined;
    seen.add(current);

    const name = typeof candidate.name === "string" ? candidate.name : undefined;
    if (name && TIMEOUT_NAMES.has(name)) return "timeout";

    const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : undefined;
    if (code && TIMEOUT_CODES.has(code)) return "timeout";
    if (code && UNREACHABLE_CODES.has(code)) return "unreachable";

    current = candidate.cause;
  }

  return undefined;
}
