export { openUrl } from "./auth/browser.js";
// Delegated OAuth (device flow for GitHub/GitLab, authorization code for Jira)
// — see RESEARCH.md for why each backend gets a different flow.
export * from "./auth/device-flow.js";
export * from "./auth/github-oauth.js";
export * from "./auth/gitlab-oauth.js";
export * from "./auth/jira-oauth.js";
export * from "./auth/token-store.js";
export {
  createTicketsClient,
  type EnsureDaemonOptions,
  ensureDaemonRunning,
  resolveVehicleClientTarget,
  type TicketsRpcClient,
  ticketsPaths,
  type VehicleClientTarget,
} from "./cli/tickets-client.js";
export {
  type BackendConfig,
  buildRepositories,
  type Config,
  configDir,
  defaultConfigPath,
  loadConfig,
} from "./config/config.js";
export { type GitHubOptions, GitHubRepository } from "./github/github.js";
export { type GitLabOptions, GitLabRepository } from "./gitlab/gitlab.js";
export * from "./issue/errors.js";
export * from "./issue/issue.js";
export * from "./issue/repository.js";
export { NotSupportedError, TicketService, UnknownBackendError } from "./issue/service.js";
export { type JiraOptions, JiraRepository } from "./jira/jira.js";
export type { TicketOperation, TicketOpInputs, TicketOpOutputs } from "./rpc/ops.js";
export type { FocusStatus, TicketFocusState } from "./sqlite/focus.js";
