/**
 * Outbound ports — contracts driven adapters (GitHub, GitLab, Jira, ...) implement.
 * The application layer depends only on these interfaces, never on a concrete adapter.
 */
import type { Comment, CreateInput, Issue, ListFilter, UpdateInput } from "../domain/issue.js";
import type { Template } from "../domain/template.js";

export interface IssueRepository {
  /** Backend identifier used in refs, e.g. "github", "gitlab", "jira". */
  readonly name: string;

  list(filter: ListFilter): Promise<Issue[]>;
  get(key: string): Promise<Issue>;
  create(input: CreateInput): Promise<Issue>;
  update(key: string, input: UpdateInput): Promise<Issue>;
  search(query: string, limit?: number): Promise<Issue[]>;
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
