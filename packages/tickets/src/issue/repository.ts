/**
 * Outbound ports — contracts driven adapters (GitHub, GitLab, Jira, ...) implement.
 * The application layer depends only on these interfaces, never on a concrete adapter.
 */
import type { Comment, CreateInput, Issue, ListFilter, UpdateInput } from "./issue.js";
import type { Template } from "./template.js";

export type BackendReadinessState = "ready" | "partial" | "blocked" | "unknown";

export interface BackendOperationReadiness {
  readonly state: BackendReadinessState;
  /** Names only; never configuration values. */
  readonly missingConfiguration: readonly string[];
  readonly recovery?: string;
}

/** Local configuration assessment. Connectivity is intentionally never inferred or probed here. */
export interface BackendConfigurationReadiness {
  readonly backendType: string;
  readonly connectivity: "not_checked";
  readonly read: BackendOperationReadiness;
  readonly write: BackendOperationReadiness;
}

export interface ConfigurationInspectable {
  configurationReadiness(): BackendConfigurationReadiness;
}

export function hasConfigurationReadiness(repo: IssueRepository): repo is IssueRepository & ConfigurationInspectable {
  return typeof (repo as Partial<ConfigurationInspectable>).configurationReadiness === "function";
}

export interface IssueRepository {
  /** Backend identifier used in refs, e.g. "github", "gitlab", "jira". */
  readonly name: string;

  list(filter: ListFilter): Promise<Issue[]>;
  get(key: string): Promise<Issue>;
  create(input: CreateInput): Promise<Issue>;
  update(key: string, input: UpdateInput): Promise<Issue>;
  /** project: per-call override of this repository's own default/configured project (Jira only; GitHub/GitLab ignore it -- their scope is fixed to the configured repo/project at construction). */
  search(query: string, limit?: number, project?: string): Promise<Issue[]>;
  listChildren(key: string): Promise<Issue[]>;
}

/** Optional capability — not every backend supports comments the same way (all three here do). */
export interface CommentCapable {
  listComments(key: string): Promise<Comment[]>;
  addComment(key: string, body: string): Promise<Comment>;
}

export function hasComments(repo: IssueRepository): repo is IssueRepository & CommentCapable {
  return typeof (repo as Partial<CommentCapable>).listComments === "function";
}

/**
 * Optional capability — discovers a backend's custom field display names ->
 * IDs (e.g. Jira's "Target Version" -> "customfield_10855") and persists them
 * to a manifest for reuse without a repeat network call. Only Jira supports
 * this today (GitHub/GitLab have no tenant-specific custom field IDs).
 */
export interface FieldDiscoverable {
  discoverFields(): Promise<Record<string, string>>;
}

export function hasFieldDiscovery(repo: IssueRepository): repo is IssueRepository & FieldDiscoverable {
  return typeof (repo as Partial<FieldDiscoverable>).discoverFields === "function";
}

/** Optional capability — discovers a backend's status names -> domain Status and persists them to a manifest. */
export interface StatusDiscoverable {
  discoverStatuses(): Promise<Record<string, string>>;
}

export function hasStatusDiscovery(repo: IssueRepository): repo is IssueRepository & StatusDiscoverable {
  return typeof (repo as Partial<StatusDiscoverable>).discoverStatuses === "function";
}

/** Optional capability — discovers a reusable description template by sampling existing issues. */
export interface TemplateDiscoverable {
  discoverTemplate(project: string, issueType: string, sampleSize?: number): Promise<Template | undefined>;
}

export function hasTemplateDiscovery(repo: IssueRepository): repo is IssueRepository & TemplateDiscoverable {
  return typeof (repo as Partial<TemplateDiscoverable>).discoverTemplate === "function";
}

/**
 * Optional capability — runs a raw query string in the backend's own query language
 * (Jira's JQL). Backs the "Saved query" feature: a saved query is just a name plus a
 * raw string in whatever language the backend understands, executed verbatim. Only
 * Jira supports this today (GitHub/GitLab have no equivalent single query language
 * spanning issues, boards, and backlogs the way Jira's JQL does).
 */
export interface RawQueryable {
  runQuery(query: string, limit?: number): Promise<Issue[]>;
}

export function hasRawQuery(repo: IssueRepository): repo is IssueRepository & RawQueryable {
  return typeof (repo as Partial<RawQueryable>).runQuery === "function";
}

/**
 * Optional capability — resolves a Jira board's quick filter id to its real JQL
 * fragment, the one-time step that turns a board/backlog view URL into a saved
 * query (see RawQueryable above). Jira only; boards/quick filters have no GitHub or
 * GitLab equivalent.
 */
export interface BoardQuickFilterDiscoverable {
  discoverBoardQuickFilterJql(boardId: number, quickFilterId: number): Promise<string>;
}

export function hasBoardQuickFilterDiscovery(repo: IssueRepository): repo is IssueRepository & BoardQuickFilterDiscoverable {
  return typeof (repo as Partial<BoardQuickFilterDiscoverable>).discoverBoardQuickFilterJql === "function";
}

/**
 * Optional capability — resolves a Jira board's own real base scope (its saved
 * filter's JQL) rather than assuming a board tracks one named project. Jira only.
 */
export interface BoardFilterDiscoverable {
  discoverBoardFilterJql(boardId: number): Promise<string>;
}

export function hasBoardFilterDiscovery(repo: IssueRepository): repo is IssueRepository & BoardFilterDiscoverable {
  return typeof (repo as Partial<BoardFilterDiscoverable>).discoverBoardFilterJql === "function";
}

/**
 * Optional capability — lets a backend widen what the poller's own background
 * sync pools into the local ledger beyond list()'s single default-project
 * filter (Jira: additional named projects, plus everything assigned to the
 * authenticated user, unioned into one JQL string). Returns undefined when
 * nothing beyond the default scope is configured, so the poller falls back
 * to plain list() unchanged. Jira only; GitHub/GitLab have no equivalent
 * multi-project-plus-assignee query language to expand into.
 */
export interface SyncScopeExpandable {
  buildSyncQuery(): string | undefined;
}

export function hasSyncScopeExpansion(repo: IssueRepository): repo is IssueRepository & SyncScopeExpandable {
  return typeof (repo as Partial<SyncScopeExpandable>).buildSyncQuery === "function";
}
