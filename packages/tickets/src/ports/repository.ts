/**
 * Outbound ports — contracts driven adapters (GitHub, GitLab, Jira, ...) implement.
 * The application layer depends only on these interfaces, never on a concrete adapter.
 */
import type { Comment, CreateInput, Issue, ListFilter, UpdateInput } from "../domain/issue.js";

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
