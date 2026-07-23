import { describe, expect, it } from "bun:test";
import { DeviceFlowError, pollForToken, requestDeviceAuthorization } from "../../src/auth/device-flow.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("requestDeviceAuthorization", () => {
  it("posts client_id/scope and parses the device authorization response", async () => {
    let seenBody = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenBody = String(init?.body);
      return jsonResponse({
        device_code: "dc123",
        user_code: "ABCD-1234",
        verification_uri: "https://example.com/device",
        expires_in: 900,
        interval: 5,
      });
    }) as typeof fetch;

    const auth = await requestDeviceAuthorization({
      provider: "github",
      deviceAuthorizationUrl: "https://github.com/login/device/code",
      tokenUrl: "https://github.com/login/oauth/access_token",
      clientId: "client-1",
      scope: "repo",
      fetchImpl,
    });

    expect(seenBody).toContain("client_id=client-1");
    expect(seenBody).toContain("scope=repo");
    expect(auth.userCode).toBe("ABCD-1234");
    expect(auth.intervalSeconds).toBe(5);
  });
});

describe("pollForToken", () => {
  const authorization = {
    deviceCode: "dc123",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    expiresInSeconds: 900,
    intervalSeconds: 5,
  };

  it("retries through authorization_pending and returns the token once granted", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return jsonResponse({ error: "authorization_pending" });
      return jsonResponse({ access_token: "tok_abc", token_type: "bearer", expires_in: 28800 });
    }) as unknown as typeof fetch;

    const token = await pollForToken(
      { provider: "github", deviceAuthorizationUrl: "x", tokenUrl: "https://x/token", clientId: "c", fetchImpl },
      authorization,
      { sleep: async () => {} },
    );

    expect(calls).toBe(3);
    expect(token.accessToken).toBe("tok_abc");
    expect(token.expiresAt).toBeDefined();
  });

  it("throws DeviceFlowError on access_denied without retrying further", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ error: "access_denied" });
    }) as unknown as typeof fetch;

    await expect(
      pollForToken(
        { provider: "gitlab", deviceAuthorizationUrl: "x", tokenUrl: "https://x/token", clientId: "c", fetchImpl },
        authorization,
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(DeviceFlowError);
    expect(calls).toBe(1);
  });

  it("is bounded by maxAttempts even if the server never stops saying pending", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "authorization_pending" })) as unknown as typeof fetch;
    await expect(
      pollForToken(
        { provider: "github", deviceAuthorizationUrl: "x", tokenUrl: "https://x/token", clientId: "c", fetchImpl },
        authorization,
        { sleep: async () => {}, maxAttempts: 3 },
      ),
    ).rejects.toThrow(DeviceFlowError);
  });
});
