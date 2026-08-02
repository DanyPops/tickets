/**
 * GitLab delegated auth via the OAuth 2.0 Device Authorization Grant, GA
 * since GitLab 17.9 (self-managed) and available on GitLab.com.
 * Docs: https://docs.gitlab.com/api/oauth2/ ("Device Authorization Grant").
 * Requires a "non-confidential" GitLab OAuth application (no client secret
 * for this flow, same shape as GitHub's device flow / RFC 8628).
 */
import type { FetchLike } from "../http-client.js";
import { type DeviceFlowConfig, type DeviceFlowToken, type PollOptions, pollForToken, requestDeviceAuthorization } from "./device-flow.js";
import type { DevicePrompt } from "./github-oauth.js";

export const GITLAB_DEFAULT_SCOPE = "read_api";

export function gitlabDeviceEndpoints(baseUrl = "https://gitlab.com"): {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
} {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return {
    deviceAuthorizationUrl: `${trimmed}/oauth/authorize_device`,
    tokenUrl: `${trimmed}/oauth/token`,
  };
}

export interface GitLabDeviceLoginOptions {
  clientId: string;
  baseUrl?: string;
  scope?: string;
  fetchImpl?: FetchLike;
  onPrompt: (prompt: DevicePrompt) => void | Promise<void>;
  poll?: PollOptions;
}

export async function loginWithGitLabDeviceFlow(opts: GitLabDeviceLoginOptions): Promise<DeviceFlowToken> {
  const endpoints = gitlabDeviceEndpoints(opts.baseUrl);
  const config: DeviceFlowConfig = {
    provider: "gitlab",
    deviceAuthorizationUrl: endpoints.deviceAuthorizationUrl,
    tokenUrl: endpoints.tokenUrl,
    clientId: opts.clientId,
    scope: opts.scope ?? GITLAB_DEFAULT_SCOPE,
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
