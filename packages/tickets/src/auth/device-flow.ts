/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628), shared between GitHub and
 * GitLab — both implement the same shape, confirmed against their own docs:
 *   GitHub: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 *     POST https://github.com/login/device/code
 *     POST https://github.com/login/oauth/access_token (grant_type=urn:ietf:params:oauth:grant-type:device_code)
 *   GitLab: https://docs.gitlab.com/api/oauth2/ ("Device Authorization Grant", GA in GitLab 17.9)
 *     POST {baseUrl}/oauth/authorize_device
 *     POST {baseUrl}/oauth/token (same grant_type)
 * This is the "open a link, enter a code" flow: no client secret, no redirect
 * URI/local callback server needed, ideal for a headless daemon. Jira/Atlassian
 * has no equivalent (see jira-oauth.ts, which uses Authorization Code instead).
 */
import type { FetchLike } from "../adapters/http.js";

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export class DeviceFlowError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: string,
    description?: string,
  ) {
    super(`${provider} device authorization failed: ${code}${description ? ` (${description})` : ""}`);
    this.name = "DeviceFlowError";
  }
}

export interface DeviceFlowConfig {
  /** Used only in error messages, e.g. "github". */
  provider: string;
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
  fetchImpl?: FetchLike;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface DeviceFlowToken {
  accessToken: string;
  tokenType: string;
  scope?: string;
  /** ISO timestamp; undefined when the provider issues a non-expiring token (classic GitHub OAuth Apps). */
  expiresAt?: string;
  refreshToken?: string;
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export async function requestDeviceAuthorization(config: DeviceFlowConfig): Promise<DeviceAuthorization> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const params: Record<string, string> = { client_id: config.clientId };
  if (config.scope) params.scope = config.scope;
  const body = await postForm(fetchImpl, config.deviceAuthorizationUrl, params);
  if (typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new DeviceFlowError(config.provider, "invalid_response", JSON.stringify(body));
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: String(body.verification_uri ?? ""),
    verificationUriComplete:
      typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : undefined,
    expiresInSeconds: Number(body.expires_in ?? 900),
    intervalSeconds: Number(body.interval ?? 5),
  };
}

export interface PollOptions {
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Safety cap independent of the server's expires_in, so a misbehaving server can't loop forever. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 200;

export async function pollForToken(
  config: DeviceFlowConfig,
  authorization: DeviceAuthorization,
  opts: PollOptions = {},
): Promise<DeviceFlowToken> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let intervalMs = authorization.intervalSeconds * 1000;
  const deadline = Date.now() + authorization.expiresInSeconds * 1000;

  for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt++) {
    await sleep(intervalMs);
    const body = await postForm(fetchImpl, config.tokenUrl, {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: authorization.deviceCode,
      client_id: config.clientId,
    });

    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (typeof body.error === "string") {
      throw new DeviceFlowError(config.provider, body.error, body.error_description as string | undefined);
    }
    if (typeof body.access_token !== "string") {
      throw new DeviceFlowError(config.provider, "invalid_response", JSON.stringify(body));
    }
    return {
      accessToken: body.access_token,
      tokenType: String(body.token_type ?? "Bearer"),
      scope: typeof body.scope === "string" ? body.scope : undefined,
      expiresAt:
        typeof body.expires_in === "number" ? new Date(Date.now() + body.expires_in * 1000).toISOString() : undefined,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    };
  }

  throw new DeviceFlowError(config.provider, "expired_token", "device code expired before authorization completed");
}
