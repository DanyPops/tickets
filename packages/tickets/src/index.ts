export * from "./adapters/errors.js";
export { type GitHubOptions, GitHubRepository } from "./adapters/github.js";
export { type GitLabOptions, GitLabRepository } from "./adapters/gitlab.js";
export { type JiraOptions, JiraRepository } from "./adapters/jira.js";
export { NotSupportedError, TicketService, UnknownBackendError } from "./application/service.js";
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
} from "./client/tickets-client.js";
export {
  type BackendConfig,
  buildRepositories,
  type Config,
  configDir,
  defaultConfigPath,
  loadConfig,
} from "./config/config.js";
export type { FocusStatus, TicketFocusState } from "./daemon/focus.js";
export type { TicketOperation, TicketOpInputs, TicketOpOutputs } from "./daemon/ops.js";
export * from "./domain/issue.js";
export * from "./ports/repository.js";
