import { describe, expect, it } from "bun:test";
import { GITHUB_DEVICE_AUTHORIZATION_URL, GITHUB_TOKEN_URL, loginWithGitHubDeviceFlow } from "../../src/auth/github-oauth.js";

describe("loginWithGitHubDeviceFlow", () => {
  it("hits the real GitHub device-flow endpoints and reports the prompt before polling", async () => {
    const requestedUrls: string[] = [];
    let prompted: { userCode: string; verificationUri: string } | undefined;
    let polls = 0;

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requestedUrls.push(url);
      if (url === GITHUB_DEVICE_AUTHORIZATION_URL) {
        return new Response(
          JSON.stringify({
            device_code: "dc",
            user_code: "WXYZ-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
          { status: 200 },
        );
      }
      if (url === GITHUB_TOKEN_URL) {
        polls++;
        return new Response(JSON.stringify({ access_token: "gho_abc", token_type: "bearer" }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const token = await loginWithGitHubDeviceFlow({
      clientId: "client-id",
      fetchImpl,
      onPrompt: (prompt) => {
        prompted = prompt;
      },
      poll: { sleep: async () => {} },
    });

    expect(requestedUrls).toContain(GITHUB_DEVICE_AUTHORIZATION_URL);
    expect(requestedUrls).toContain(GITHUB_TOKEN_URL);
    expect(prompted?.userCode).toBe("WXYZ-1234");
    expect(polls).toBe(1);
    expect(token.accessToken).toBe("gho_abc");
  });
});
