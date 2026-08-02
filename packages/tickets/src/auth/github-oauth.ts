/**
 * GitHub delegated auth via the OAuth 2.0 Device Authorization Grant.
 * Docs: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 * Requires a GitHub OAuth App (or GitHub App) with the device flow enabled in
 * its settings; the client ID is public (no secret needed for this flow).
 */
import type { FetchLike } from "../http-client.js";
import { type DeviceFlowConfig, type DeviceFlowToken, type PollOptions, pollForToken, requestDeviceAuthorization } from "./device-flow.js";

export const GITHUB_DEVICE_AUTHORIZATION_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_DEFAULT_SCOPE = "repo read:org";

export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}

export interface GitHubDeviceLoginOptions {
  clientId: string;
  scope?: string;
  fetchImpl?: FetchLike;
  onPrompt: (prompt: DevicePrompt) => void | Promise<void>;
  poll?: PollOptions;
}

export async function loginWithGitHubDeviceFlow(opts: GitHubDeviceLoginOptions): Promise<DeviceFlowToken> {
  const config: DeviceFlowConfig = {
    provider: "github",
    deviceAuthorizationUrl: GITHUB_DEVICE_AUTHORIZATION_URL,
    tokenUrl: GITHUB_TOKEN_URL,
    clientId: opts.clientId,
    scope: opts.scope ?? GITHUB_DEFAULT_SCOPE,
    fetchImpl: opts.fetchImpl,
  };
  const authorization = await requestDeviceAuthorization(config);
  await opts.onPrompt({
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUri,
    verificationUriComplete: authorization.verificationUriComplete,
  });
  return pollForToken(config, authorization, opts.poll);
}
