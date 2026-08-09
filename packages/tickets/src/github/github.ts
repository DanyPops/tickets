/**
 * GitHub adapter — driven implementation of IssueRepository/CommentCapable against
 * the GitHub REST API v3, via octokit (github.com/octokit) rather than a hand-rolled
 * HTTP client: it's GitHub's own official SDK, generated from GitHub's OpenAPI spec,
 * and its typed `assignees: string[]` matches the real write contract exactly (see
 * RESEARCH.md). Token is optional: public repos allow unauthenticated reads at a
 * lower rate limit.
 *
 * IMPORTANT: the `octokit` meta-package bundles @octokit/plugin-retry and
 * @octokit/plugin-throttling ON by default, with default onRateLimit/
 * onSecondaryRateLimit handlers that silently SLEEP for GitHub's advertised
 * Retry-After window (which for an exhausted hourly quota can be tens of
 * minutes) before even attempting a retry -- confirmed for real: a live smoke
 * test against an already-rate-limited endpoint hung with zero output rather
 * than failing fast. That's the opposite of this project's own design (the
 * daemon's ledger exists so live calls can fail fast and the caller decides
 * what to do next, not so octokit can unilaterally decide to block for an
 * indeterminate duration). Both plugins are explicitly disabled below, and
 * every call carries a hard timeout matching the old hand-rolled HttpClient's.
 */

import { RequestError } from "@octokit/request-error";
import { Octokit } from "octokit";
import { ApiError, AuthRequiredError, BackendConfigurationError, BackendConnectionError, IssueNotFoundError } from "../issue/errors.js";
import type { Comment, CreateInput, Issue, ListFilter, parsePriority, Status, UpdateInput } from "../issue/issue.js";
import type { BackendConfigurationReadiness } from "../issue/repository.js";
import { classifyBackendTransportFailure } from "../issue/transport-error.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface GitHubOptions {
  owner: string;
  repo?: string;
  token?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected in tests instead of hitting a real network — see @octokit/types' RequestRequestOptions.fetch. */
  fetchImpl?: typeof fetch;
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
  labels: (GhLabel | string)[];
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}
interface GhComment {
  id: number;
  body?: string;
  created_at: string;
  updated_at: string;
  user: GhUser | null;
}

export class GitHubRepository {
  readonly name: string;
  private readonly client: Octokit;
  private readonly owner: string;
  private repo?: string;
  private readonly readOnly: boolean;

  private readonly timeoutMs: number;

  constructor(name: string, opts: GitHubOptions) {
    if (!opts.owner) throw new Error("github: owner is required");
    this.name = name;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.readOnly = !opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = new Octokit({
      auth: opts.token,
      baseUrl: opts.baseUrl ?? "https://api.github.com",
      retry: { enabled: false },
      throttle: { onRateLimit: () => false, onSecondaryRateLimit: () => false },
      ...(opts.fetchImpl ? { request: { fetch: opts.fetchImpl } } : {}),
    });
  }

  private repoName(): string {
    if (!this.repo) {
      throw new BackendConfigurationError(
        "github",
        "repository is not configured; set GITHUB_REPO (or the backend's repo setting) and restart the tickets daemon",
        "Set GITHUB_REPO (or the backend's repo setting), then restart the tickets daemon.",
      );
    }
    return this.repo;
  }

  private requireAuth(): void {
    if (this.readOnly) throw new AuthRequiredError("github", "GITHUB_TOKEN");
  }

  configurationReadiness(): BackendConfigurationReadiness {
    const repositoryMissing = this.repo ? [] : ["GITHUB_REPO"];
    const writeMissing = [...repositoryMissing, ...(this.readOnly ? ["GITHUB_TOKEN"] : [])];
    return {
      backendType: "github",
      connectivity: "not_checked",
      read: this.repo
        ? { state: "ready", missingConfiguration: [] }
        : {
            state: "partial",
            missingConfiguration: repositoryMissing,
            recovery:
              "Set GITHUB_REPO (or the backend's repo setting) for repository list/get/comment operations; organization search remains available.",
          },
      write:
        writeMissing.length === 0
          ? { state: "ready", missingConfiguration: [] }
          : {
              state: "blocked",
              missingConfiguration: writeMissing,
              recovery:
                "Configure the repository scope and GITHUB_TOKEN (or equivalent backend settings) before using live write operations.",
            },
    };
  }

  async list(filter: ListFilter): Promise<Issue[]> {
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const raw = await this.call((signal) =>
      this.client.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repoName(),
        per_page: limit,
        state: filter.status ? mapStatusToGitHub(filter.status) : "all",
        assignee: filter.assignee,
        labels: filter.labels?.length ? filter.labels.join(",") : undefined,
        request: { signal },
      }),
    );
    return (raw as GhIssue[]).filter((i) => !i.pull_request).map(toDomain);
  }

  async get(key: string): Promise<Issue> {
    const issue_number = parseIssueNumber(key);
    const raw = (await this.call((signal) =>
      this.client.rest.issues.get({ owner: this.owner, repo: this.repoName(), issue_number, request: { signal } }),
    )) as GhIssue;
    if (raw.pull_request) throw new Error(`github: #${issue_number} is a pull request, not an issue`);
    return toDomain(raw);
  }

  async create(input: CreateInput): Promise<Issue> {
    this.requireAuth();
    const raw = (await this.call((signal) =>
      this.client.rest.issues.create({
        owner: this.owner,
        repo: this.repoName(),
        title: input.title,
        body: input.description ?? "",
        labels: input.labels?.length ? input.labels : undefined,
        assignees: input.assignee ? [input.assignee] : undefined,
        request: { signal },
      }),
    )) as GhIssue;
    return toDomain(raw);
  }

  async update(key: string, input: UpdateInput): Promise<Issue> {
    this.requireAuth();
    const issue_number = parseIssueNumber(key);
    const raw = (await this.call((signal) =>
      this.client.rest.issues.update({
        owner: this.owner,
        repo: this.repoName(),
        issue_number,
        title: input.title,
        body: input.description,
        state: input.status !== undefined ? mapStatusToGitHub(input.status) : undefined,
        labels: input.labels,
        assignees: input.assignee !== undefined ? (input.assignee ? [input.assignee] : []) : undefined,
        request: { signal },
      }),
    )) as GhIssue;
    return toDomain(raw);
  }

  // project is accepted for IssueRepository interface parity but ignored --
  // GitHub's scope (owner/repo) is fixed at construction, not overridable per call.
  async search(query: string, limit = 50, _project?: string): Promise<Issue[]> {
    const scope = this.repo ? `repo:${this.owner}/${this.repo}` : `org:${this.owner}`;
    const result = (await this.call((signal) =>
      this.client.rest.search.issuesAndPullRequests({ q: `${scope} ${query}`, per_page: limit, request: { signal } }),
    )) as { items: GhIssue[] };
    return result.items.filter((i) => !i.pull_request).map(toDomain);
  }

  // GitHub has no native sub-issue relationship exposed via REST v3.
  async listChildren(_key: string): Promise<Issue[]> {
    return [];
  }

  async listComments(key: string): Promise<Comment[]> {
    const issue_number = parseIssueNumber(key);
    const raw = (await this.call((signal) =>
      this.client.rest.issues.listComments({ owner: this.owner, repo: this.repoName(), issue_number, request: { signal } }),
    )) as GhComment[];
    return raw.map(commentToDomain);
  }

  async addComment(key: string, body: string): Promise<Comment> {
    this.requireAuth();
    const issue_number = parseIssueNumber(key);
    const raw = (await this.call((signal) =>
      this.client.rest.issues.createComment({ owner: this.owner, repo: this.repoName(), issue_number, body, request: { signal } }),
    )) as GhComment;
    return commentToDomain(raw);
  }

  /**
   * Runs an octokit call, unwraps `.data`, and maps RequestError onto this
   * project's shared error taxonomy. Uses a plain AbortController + setTimeout
   * (not AbortSignal.timeout()) specifically so the timer can be cleared the
   * moment the call settles, matching the old hand-rolled HttpClient's
   * finally-block discipline -- AbortSignal.timeout() has no way to cancel
   * early once created, and confirmed for real that letting it linger shows
   * up as measurable delay (each call leaves a live timer sitting in the
   * event loop until it eventually fires). With retry/throttling disabled
   * above, a stalled connection or rate-limit response now fails predictably
   * within `timeoutMs` instead of hanging.
   */
  private async call<T>(fn: (signal: AbortSignal) => Promise<{ data: T }>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fn(controller.signal);
      return res.data;
    } catch (err) {
      if (err instanceof BackendConfigurationError) throw err;
      const transportKind = classifyBackendTransportFailure(err);
      if (transportKind) throw new BackendConnectionError("github", transportKind, err);
      if (err instanceof RequestError && err.response) {
        if (err.status === 404) throw new IssueNotFoundError("github", err.request.url);
        throw new ApiError("github", err.request.method, err.request.url, err.status, redact(err.message));
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function redact(text: string): string {
  return text.replace(/"(token|password|secret|api_key|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"').slice(0, 2000);
}

function parseIssueNumber(key: string): number {
  const stripped = key.replace(/^#/, "");
  const idx = stripped.lastIndexOf("#");
  return Number(idx >= 0 ? stripped.slice(idx + 1) : stripped);
}

function mapStatusToGitHub(status: Status): "open" | "closed" {
  return status === "done" || status === "canceled" ? "closed" : "open";
}

function mapStatusFromGitHub(state: string): Status {
  return state.toLowerCase() === "closed" ? "done" : "todo";
}

function labelName(label: GhLabel | string): string {
  return typeof label === "string" ? label : label.name;
}

function priorityFromLabels(labels: (GhLabel | string)[]): ReturnType<typeof parsePriority> {
  for (const l of labels) {
    const lower = labelName(l).toLowerCase();
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
    labels: gh.labels?.length ? gh.labels.map(labelName) : undefined,
    assignee: gh.assignee?.login,
    url: gh.html_url,
    createdAt: gh.created_at,
    updatedAt: gh.updated_at,
  };
}

function commentToDomain(c: GhComment): Comment {
  return {
    id: String(c.id),
    body: c.body ?? "",
    author: c.user?.login,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}
