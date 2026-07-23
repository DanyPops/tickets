/**
 * GitHub adapter — driven implementation of IssueRepository/CommentCapable against
 * the GitHub REST API v3 (docs: https://docs.github.com/en/rest/issues/issues).
 * Token is optional: public repos allow unauthenticated reads at a lower rate limit.
 */
import type { Comment, CreateInput, Issue, ListFilter, Status, UpdateInput } from "../domain/issue.js";
import { parsePriority } from "../domain/issue.js";
import { AuthRequiredError } from "./errors.js";
import { type FetchLike, HttpClient } from "./http.js";

export interface GitHubOptions {
  owner: string;
  repo?: string;
  token?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface GhUser {
  login: string;
}
interface GhLabel {
  id: number;
  name: string;
}
interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: GhUser | null;
  assignee: GhUser | null;
  labels: GhLabel[];
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}
interface GhComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: GhUser | null;
}

export class GitHubRepository {
  readonly name: string;
  private readonly http: HttpClient;
  private readonly owner: string;
  private repo?: string;
  private readonly readOnly: boolean;

  constructor(name: string, opts: GitHubOptions) {
    if (!opts.owner) throw new Error("github: owner is required");
    this.name = name;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.readOnly = !opts.token;
    this.http = new HttpClient({
      baseUrl: opts.baseUrl ?? "https://api.github.com",
      backend: "github",
      fetchImpl: opts.fetchImpl,
      headers: {
        Accept: "application/vnd.github.v3+json",
        ...(opts.token ? { Authorization: `token ${opts.token}` } : {}),
      },
    });
  }

  private repoPath(): string {
    if (!this.repo) throw new Error("github: repo not set — pass repo, or scope via config");
    return `/repos/${this.owner}/${this.repo}`;
  }

  private requireAuth(): void {
    if (this.readOnly) throw new AuthRequiredError("github", "GITHUB_TOKEN");
  }

  async list(filter: ListFilter): Promise<Issue[]> {
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const params = new URLSearchParams({ per_page: String(limit), state: "all" });
    if (filter.status) params.set("state", mapStatusToGitHub(filter.status));
    if (filter.assignee) params.set("assignee", filter.assignee);
    if (filter.labels?.length) params.set("labels", filter.labels.join(","));

    const raw = (await this.http.get<GhIssue[]>(`${this.repoPath()}/issues?${params}`)) ?? [];
    return raw.filter((i) => !i.pull_request).map(toDomain);
  }

  async get(key: string): Promise<Issue> {
    const number = parseIssueNumber(key);
    const raw = await this.http.get<GhIssue>(`${this.repoPath()}/issues/${number}`);
    if (!raw) throw new Error(`github: empty response for #${number}`);
    if (raw.pull_request) throw new Error(`github: #${number} is a pull request, not an issue`);
    return toDomain(raw);
  }

  async create(input: CreateInput): Promise<Issue> {
    this.requireAuth();
    const body: Record<string, unknown> = { title: input.title, body: input.description ?? "" };
    if (input.labels?.length) body.labels = input.labels;
    if (input.assignee) body.assignees = [input.assignee];
    const raw = await this.http.post<GhIssue>(`${this.repoPath()}/issues`, body);
    if (!raw) throw new Error("github: create returned no body");
    return toDomain(raw);
  }

  async update(key: string, input: UpdateInput): Promise<Issue> {
    this.requireAuth();
    const number = parseIssueNumber(key);
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.description !== undefined) body.body = input.description;
    if (input.status !== undefined) body.state = mapStatusToGitHub(input.status);
    if (input.labels !== undefined) body.labels = input.labels;
    if (input.assignee !== undefined) body.assignees = input.assignee ? [input.assignee] : [];
    const raw = await this.http.patch<GhIssue>(`${this.repoPath()}/issues/${number}`, body);
    if (!raw) throw new Error("github: update returned no body");
    return toDomain(raw);
  }

  async search(query: string, limit = 50): Promise<Issue[]> {
    const scope = this.repo ? `repo:${this.owner}/${this.repo}` : `org:${this.owner}`;
    const q = encodeURIComponent(`${scope} ${query}`);
    const result = await this.http.get<{ items: GhIssue[] }>(`/search/issues?q=${q}&per_page=${limit}`);
    return (result?.items ?? []).filter((i) => !i.pull_request).map(toDomain);
  }

  // GitHub has no native sub-issue relationship exposed via REST v3.
  async listChildren(_key: string): Promise<Issue[]> {
    return [];
  }

  async listComments(key: string): Promise<Comment[]> {
    const number = parseIssueNumber(key);
    const raw = (await this.http.get<GhComment[]>(`${this.repoPath()}/issues/${number}/comments`)) ?? [];
    return raw.map(commentToDomain);
  }

  async addComment(key: string, body: string): Promise<Comment> {
    this.requireAuth();
    const number = parseIssueNumber(key);
    const raw = await this.http.post<GhComment>(`${this.repoPath()}/issues/${number}/comments`, { body });
    if (!raw) throw new Error("github: add comment returned no body");
    return commentToDomain(raw);
  }
}

function parseIssueNumber(key: string): string {
  const stripped = key.replace(/^#/, "");
  const idx = stripped.lastIndexOf("#");
  return idx >= 0 ? stripped.slice(idx + 1) : stripped;
}

function mapStatusToGitHub(status: Status): "open" | "closed" {
  return status === "done" || status === "canceled" ? "closed" : "open";
}

function mapStatusFromGitHub(state: string): Status {
  return state.toLowerCase() === "closed" ? "done" : "todo";
}

function priorityFromLabels(labels: GhLabel[]): ReturnType<typeof parsePriority> {
  for (const l of labels) {
    const lower = l.name.toLowerCase();
    if (lower.includes("urgent") || lower.includes("critical")) return "urgent";
    if (lower.includes("high")) return "high";
    if (lower.includes("medium")) return "medium";
    if (lower.includes("low")) return "low";
  }
  return "none";
}

function toDomain(gh: GhIssue): Issue {
  return {
    ref: `github:#${gh.number}`,
    id: String(gh.number),
    key: `#${gh.number}`,
    title: gh.title,
    description: gh.body ?? undefined,
    status: mapStatusFromGitHub(gh.state),
    rawStatus: gh.state,
    priority: priorityFromLabels(gh.labels ?? []),
    labels: gh.labels?.length ? gh.labels.map((l) => l.name) : undefined,
    assignee: gh.assignee?.login,
    url: gh.html_url,
    createdAt: gh.created_at,
    updatedAt: gh.updated_at,
  };
}

function commentToDomain(c: GhComment): Comment {
  return {
    id: String(c.id),
    body: c.body,
    author: c.user?.login,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}
