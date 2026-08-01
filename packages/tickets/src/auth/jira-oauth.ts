/**
 * Jira/Atlassian delegated auth via OAuth 2.0 (3LO), Authorization Code grant.
 * Docs: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
 *
 * Unlike GitHub/GitLab, Atlassian's 3LO apps are confidential clients (no
 * PKCE, no device flow — confirmed absent from their docs) and require a
 * client secret. That means this flow needs a local redirect: we bind an
 * ephemeral loopback HTTP server, send the user to Atlassian's consent
 * screen, and receive the authorization code on the callback.
 *
 * OAuth 2.0 (3LO) access tokens are NOT used the way Basic-auth API tokens
 * are: requests go to https://api.atlassian.com/ex/jira/{cloudId}/... with
 * `Authorization: Bearer <token>`, not directly to the tenant's *.atlassian.net
 * domain. The cloudId is discovered via the accessible-resources endpoint
 * after the token exchange — see JiraOAuthToken below.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchLike } from "../adapters/http.js";

export const ATLASSIAN_AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
export const ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
export const ATLASSIAN_ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
export const JIRA_DEFAULT_SCOPE = "read:jira-work write:jira-work read:jira-user offline_access";

export interface JiraSite {
  id: string;
  name: string;
  url: string;
  scopes: string[];
}

export interface JiraOAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  cloudId: string;
  siteUrl: string;
}

export class JiraOAuthError extends Error {
  constructor(message: string) {
    super(`jira oauth: ${message}`);
    this.name = "JiraOAuthError";
  }
}

export interface CallbackResult {
  code: string;
  redirectUri: string;
}

export interface CallbackServer {
  redirectUriFor(host?: string): string;
  waitForCode(timeoutMs: number): Promise<CallbackResult>;
  close(): Promise<void>;
}

/**
 * Binds an ephemeral loopback HTTP server that answers exactly one
 * `/callback` request, validating `state` before resolving. Exported
 * separately from loginWithJiraAuthorizationCode so tests can drive it with
 * a real HTTP request instead of a real browser.
 */
export function startCallbackServer(expectedState: string, port = 0): CallbackServer {
  let resolveCode: ((result: CallbackResult) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("not found");
      return;
    }
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" }).end("<html><body>Authorization denied. You can close this tab.</body></html>");
      rejectCode?.(new JiraOAuthError(`authorization denied: ${error}`));
      return;
    }
    if (state !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html" }).end("<html><body>State mismatch. Aborting.</body></html>");
      rejectCode?.(new JiraOAuthError("state mismatch on OAuth callback"));
      return;
    }
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" }).end("<html><body>Missing authorization code.</body></html>");
      rejectCode?.(new JiraOAuthError("callback missing authorization code"));
      return;
    }
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end("<html><body>Authorized. You can close this tab and return to the terminal.</body></html>");
    resolveCode?.({ code, redirectUri: redirectUriFor() });
  });

  function redirectUriFor(host = "127.0.0.1"): string {
    const address = server.address() as AddressInfo;
    return `http://${host}:${address.port}/callback`;
  }

  server.listen(port);

  return {
    redirectUriFor,
    waitForCode(timeoutMs: number): Promise<CallbackResult> {
      return new Promise((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
        setTimeout(() => reject(new JiraOAuthError("timed out waiting for the OAuth callback")), timeoutMs);
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export function buildAuthorizeUrl(opts: { clientId: string; redirectUri: string; scope: string; state: string }): string {
  const url = new URL(ATLASSIAN_AUTHORIZE_URL);
  url.searchParams.set("audience", "api.atlassian.com");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function exchangeCode(
  fetchImpl: FetchLike,
  opts: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<TokenResponse> {
  const res = await fetchImpl(ATLASSIAN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  });
  const body = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new JiraOAuthError(body.error_description ?? body.error ?? `token exchange failed with HTTP ${res.status}`);
  }
  return body;
}

export async function fetchAccessibleResources(fetchImpl: FetchLike, accessToken: string): Promise<JiraSite[]> {
  const res = await fetchImpl(ATLASSIAN_ACCESSIBLE_RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new JiraOAuthError(`accessible-resources failed with HTTP ${res.status}`);
  return (await res.json()) as JiraSite[];
}

export interface JiraOAuthLoginOptions {
  clientId: string;
  clientSecret: string;
  scope?: string;
  port?: number;
  fetchImpl?: FetchLike;
  onPrompt: (authorizeUrl: string) => void | Promise<void>;
  timeoutMs?: number;
  /** Pick a site when the token is granted access to more than one; defaults to the first. */
  chooseSite?: (sites: JiraSite[]) => JiraSite;
}

const DEFAULT_CALLBACK_TIMEOUT_MS = 120_000;

export async function loginWithJiraAuthorizationCode(opts: JiraOAuthLoginOptions): Promise<JiraOAuthToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const state = randomBytes(16).toString("hex");
  const server = startCallbackServer(state, opts.port ?? 0);

  try {
    const redirectUri = server.redirectUriFor();
    const authorizeUrl = buildAuthorizeUrl({
      clientId: opts.clientId,
      redirectUri,
      scope: opts.scope ?? JIRA_DEFAULT_SCOPE,
      state,
    });
    const waiting = server.waitForCode(opts.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS);
    await opts.onPrompt(authorizeUrl);
    const { code } = await waiting;

    const token = await exchangeCode(fetchImpl, {
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      code,
      redirectUri,
    });
    const sites = await fetchAccessibleResources(fetchImpl, token.access_token);
    if (sites.length === 0) throw new JiraOAuthError("no accessible Atlassian sites granted to this token");
    const site = (opts.chooseSite ?? ((all: JiraSite[]) => all[0]))(sites) as JiraSite;

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined,
      cloudId: site.id,
      siteUrl: site.url,
    };
  } finally {
    await server.close();
  }
}

export async function refreshJiraToken(
  fetchImpl: FetchLike,
  opts: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
  const res = await fetchImpl(ATLASSIAN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
    }),
  });
  const body = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new JiraOAuthError(body.error_description ?? body.error ?? `refresh failed with HTTP ${res.status}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : undefined,
  };
}
