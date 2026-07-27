export * from "./domain/issue.js";
export * from "./ports/repository.js";
export * from "./adapters/errors.js";
export { GitHubRepository, type GitHubOptions } from "./adapters/github.js";
export { GitLabRepository, type GitLabOptions } from "./adapters/gitlab.js";
export { JiraRepository, type JiraOptions } from "./adapters/jira.js";
export { TicketService, UnknownBackendError, NotSupportedError } from "./application/service.js";
export {
  type BackendConfig,
  type Config,
  loadConfig,
  buildRepositories,
  defaultConfigPath,
  configDir,
} from "./config/config.js";
export type { TicketOperation, TicketOpInputs, TicketOpOutputs } from "./daemon/ops.js";
export type { FocusStatus, TicketFocusState } from "./daemon/focus.js";
export {
  createTicketsClient,
  ensureDaemonRunning,
  ticketsPaths,
  type EnsureDaemonOptions,
  type TicketsRpcClient,
} from "./client/tickets-client.js";

// Delegated OAuth (device flow for GitHub/GitLab, authorization code for Jira)
// — see RESEARCH.md for why each backend gets a different flow.
export * from "./auth/device-flow.js";
export * from "./auth/token-store.js";
export { openUrl } from "./auth/browser.js";
export * from "./auth/github-oauth.js";
export * from "./auth/gitlab-oauth.js";
export * from "./auth/jira-oauth.js";
