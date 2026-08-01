import { describe, expect, it } from "bun:test";
import {
  buildAuthorizeUrl,
  fetchAccessibleResources,
  JiraOAuthError,
  loginWithJiraAuthorizationCode,
  startCallbackServer,
} from "../../src/auth/jira-oauth.js";

describe("buildAuthorizeUrl", () => {
  it("includes audience=api.atlassian.com and response_type=code (no PKCE params — Atlassian doesn't support it)", () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:9/callback", scope: "read:jira-work", state: "st" }),
    );
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });
});

describe("startCallbackServer", () => {
  it("binds an ephemeral port and resolves waitForCode on a matching callback request", async () => {
    const server = startCallbackServer("expected-state");
    try {
      const redirectUri = server.redirectUriFor();
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const waiting = server.waitForCode(2000);
      const response = await fetch(`${redirectUri}?code=auth-code-123&state=expected-state`);
      expect(response.status).toBe(200);

      const result = await waiting;
      expect(result.code).toBe("auth-code-123");
      expect(result.redirectUri).toBe(redirectUri);
    } finally {
      await server.close();
    }
  });

  it("rejects on a state mismatch", async () => {
    const server = startCallbackServer("expected-state");
    try {
      const redirectUri = server.redirectUriFor();
      const waiting = server.waitForCode(2000);
      let caught: unknown;
      waiting.catch((error) => {
        caught = error;
      });
      await fetch(`${redirectUri}?code=x&state=wrong-state`);
      await waiting.catch(() => {});
      expect(caught).toBeInstanceOf(JiraOAuthError);
    } finally {
      await server.close();
    }
  });

  it("rejects when the provider reports an authorization error", async () => {
    const server = startCallbackServer("expected-state");
    try {
      const redirectUri = server.redirectUriFor();
      const waiting = server.waitForCode(2000);
      let caught: unknown;
      waiting.catch((error) => {
        caught = error;
      });
      await fetch(`${redirectUri}?error=access_denied&state=expected-state`);
      await waiting.catch(() => {});
      expect(caught).toBeInstanceOf(JiraOAuthError);
    } finally {
      await server.close();
    }
  });
});

describe("fetchAccessibleResources", () => {
  it("sends the access token as a Bearer header and returns the parsed site list", async () => {
    let seenAuth = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenAuth = (init!.headers as Record<string, string>).Authorization ?? "";
      return new Response(
        JSON.stringify([{ id: "cloud-1", name: "Acme", url: "https://acme.atlassian.net", scopes: ["read:jira-work"] }]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const sites = await fetchAccessibleResources(fetchImpl, "tok_xyz");
    expect(seenAuth).toBe("Bearer tok_xyz");
    expect(sites[0]?.id).toBe("cloud-1");
  });
});

describe("loginWithJiraAuthorizationCode (end to end against a fake token endpoint)", () => {
  it("drives the full authorization-code + accessible-resources flow", async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("auth.atlassian.com/oauth/token")) {
        const body = JSON.parse(String(init?.body)) as { code: string; grant_type: string };
        expect(body.grant_type).toBe("authorization_code");
        expect(body.code).toBe("real-code");
        return new Response(JSON.stringify({ access_token: "access_xyz", refresh_token: "refresh_xyz", expires_in: 3600 }), {
          status: 200,
        });
      }
      if (href.includes("accessible-resources")) {
        return new Response(JSON.stringify([{ id: "cloud-42", name: "Acme", url: "https://acme.atlassian.net", scopes: [] }]), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof fetch;

    const loginPromise = loginWithJiraAuthorizationCode({
      clientId: "cid",
      clientSecret: "secret",
      fetchImpl,
      onPrompt: async (authorizeUrl) => {
        const url = new URL(authorizeUrl);
        const redirectUri = url.searchParams.get("redirect_uri") as string;
        const state = url.searchParams.get("state") as string;
        await fetch(`${redirectUri}?code=real-code&state=${state}`);
      },
    });

    const token = await loginPromise;
    expect(token.accessToken).toBe("access_xyz");
    expect(token.cloudId).toBe("cloud-42");
    expect(token.siteUrl).toBe("https://acme.atlassian.net");
  });
});
