import { describe, expect, it } from "bun:test";
import { gitlabDeviceEndpoints, loginWithGitLabDeviceFlow } from "../../src/auth/gitlab-oauth.js";

describe("gitlabDeviceEndpoints", () => {
  it("derives /oauth/authorize_device and /oauth/token from a self-managed base URL", () => {
    const endpoints = gitlabDeviceEndpoints("https://gitlab.example.com/");
    expect(endpoints.deviceAuthorizationUrl).toBe("https://gitlab.example.com/oauth/authorize_device");
    expect(endpoints.tokenUrl).toBe("https://gitlab.example.com/oauth/token");
  });

  it("defaults to gitlab.com", () => {
    const endpoints = gitlabDeviceEndpoints();
    expect(endpoints.deviceAuthorizationUrl).toBe("https://gitlab.com/oauth/authorize_device");
  });
});

describe("loginWithGitLabDeviceFlow", () => {
  it("drives the self-managed device flow end to end", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://gitlab.example.com/oauth/authorize_device") {
        return new Response(
          JSON.stringify({
            device_code: "dc",
            user_code: "0A44L90H",
            verification_uri: "https://gitlab.example.com/oauth/device",
            expires_in: 300,
            interval: 5,
          }),
          { status: 200 },
        );
      }
      if (url === "https://gitlab.example.com/oauth/token") {
        return new Response(JSON.stringify({ access_token: "glpat-oauth-abc", token_type: "Bearer", expires_in: 7200 }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const token = await loginWithGitLabDeviceFlow({
      clientId: "cid",
      baseUrl: "https://gitlab.example.com",
      fetchImpl,
      onPrompt: () => {},
      poll: { sleep: async () => {} },
    });

    expect(token.accessToken).toBe("glpat-oauth-abc");
    expect(token.expiresAt).toBeDefined();
  });
});
