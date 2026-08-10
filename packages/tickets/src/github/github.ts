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
import type {
  Comment,
  CreateInput,
  Issue,
  ListFilter,
  MergeableState,
  PullRequestDetails,
  PullRequestReviewer,
  parsePriority,
  Status,
  UpdateInput,
} from "../issue/issue.js";
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
  /** The Issues API's own PR stub -- confirmed against @octokit/openapi-types' "issue" schema: only these fields, never base/head/mergeable/diffStat/requestedReviewers. See github.ts's get()/pullRequestDetailsFromIssue for why those need a dedicated pulls.get() call instead. */
  pull_request?: { merged_at: string | null };
  /** A real top-level field on the Issues API's own "issue" schema (not nested under pull_request) -- free at list()/get() time. */
  draft?: boolean;
}
interface GhComment {
  id: number;
  body?: string;
  created_at: string;
  updated_at: string;
  user: GhUser | null;
}
/** The dedicated Pulls API's full shape (GET /pulls/{pull_number}) -- only reachable via a second call from get(), never from the Issues API list()/get() calls above. */
interface GhPullRequestFull {
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  draft?: boolean;
  merged: boolean;
  merged_at: string | null;
  mergeable: boolean | null;
  mergeable_state: string;
  additions: number;
  deletions: number;
  changed_files: number;
  requested_reviewers?: GhUser[] | null;
}
interface GhReview {
  user: GhUser | null;
  state: string;
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
    if (filter.qaContactIsMe) throw new Error('github: "qaContactIsMe" is a Jira-only concept, not supported on the github backend');
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const meQualifiers = buildMeQualifiers(filter);
    if (meQualifiers.length === 0) {
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
      return (raw as GhIssue[]).map((i) => toDomain(i));
    }
    // Any "me" flag routes through the Search API instead of listForRepo: it's the only GitHub
    // surface with a review-requested filter at all (confirmed against GitHub's own REST docs --
    // listForRepo has no such parameter), and it happens to support author/assignee "me" qualifiers
    // too, so one call covers every combination of the three flags. Response items are Issue-shaped
    // (same pull_request: {merged_at} stub as listForRepo's own entries -- confirmed against
    // @octokit/openapi-types' issue-search-result-item schema), so toDomain() applies unchanged.
    const q = buildMeSearchQuery(this.owner, this.repoName(), filter, meQualifiers);
    const result = (await this.call((signal) =>
      this.client.rest.search.issuesAndPullRequests({ q, per_page: limit, request: { signal } }),
    )) as { items: GhIssue[] };
    return result.items.map((i) => toDomain(i));
  }

  async get(key: string): Promise<Issue> {
    const issue_number = parseIssueNumber(key);
    const raw = (await this.call((signal) =>
      this.client.rest.issues.get({ owner: this.owner, repo: this.repoName(), issue_number, request: { signal } }),
    )) as GhIssue;
    if (!raw.pull_request) return toDomain(raw);
    // A PR's full shape (base/head/mergeable/diffStat/requestedReviewers) is not on the Issues
    // API's own "issue" schema at all -- only reachable via the dedicated Pulls API, and only
    // fetched here (the single-item path), never from list()/search(), per this project's own
    // N+1-avoidance discipline. See the research Doc's correction for why this differs from
    // list()'s zero-extra-call population below.
    const [pull, reviews] = await Promise.all([this.fetchPullRequest(issue_number), this.fetchReviews(issue_number)]);
    return toDomain(raw, pullRequestDetailsFromFull(pull, reviews));
  }

  private async fetchPullRequest(pull_number: number): Promise<GhPullRequestFull> {
    return (await this.call((signal) =>
      this.client.rest.pulls.get({ owner: this.owner, repo: this.repoName(), pull_number, request: { signal } }),
    )) as GhPullRequestFull;
  }

  private async fetchReviews(pull_number: number): Promise<GhReview[]> {
    return (await this.call((signal) =>
      this.client.rest.pulls.listReviews({ owner: this.owner, repo: this.repoName(), pull_number, request: { signal } }),
    )) as GhReview[];
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
    return result.items.map((i) => toDomain(i));
  }

  // GitHub has no native sub-issue relationship exposed via REST v3.
  async listChildren(_key: string): Promise<Issue[]> {
    return [];
  }

  async approvePullRequest(key: string, body?: string): Promise<Issue> {
    this.requireAuth();
    const pull_number = parseIssueNumber(key);
    await this.call((signal) =>
      this.client.rest.pulls.createReview({
        owner: this.owner,
        repo: this.repoName(),
        pull_number,
        event: "APPROVE",
        body,
        request: { signal },
      }),
    );
    return this.get(key);
  }

  async requestPullRequestChanges(key: string, body: string): Promise<Issue> {
    this.requireAuth();
    const pull_number = parseIssueNumber(key);
    await this.call((signal) =>
      this.client.rest.pulls.createReview({
        owner: this.owner,
        repo: this.repoName(),
        pull_number,
        event: "REQUEST_CHANGES",
        body,
        request: { signal },
      }),
    );
    return this.get(key);
  }

  async mergePullRequest(key: string, method?: "merge" | "squash" | "rebase"): Promise<Issue> {
    this.requireAuth();
    const pull_number = parseIssueNumber(key);
    await this.call((signal) =>
      this.client.rest.pulls.merge({ owner: this.owner, repo: this.repoName(), pull_number, merge_method: method, request: { signal } }),
    );
    return this.get(key);
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

/** ListFilter.{reportedByMe,assignedToMe,reviewRequestedOfMe} -> GitHub Search API qualifiers -- see ListFilter's own doc comment. */
function buildMeQualifiers(filter: ListFilter): string[] {
  const qualifiers: string[] = [];
  if (filter.reportedByMe) qualifiers.push("author:@me");
  if (filter.assignedToMe) qualifiers.push("assignee:@me");
  if (filter.reviewRequestedOfMe) qualifiers.push("user-review-requested:@me");
  return qualifiers;
}

/** Composes a full Search API `q` string: repo scope + status/labels (AND, matching list()'s own semantics) + the "me" qualifiers (OR'd together). */
function buildMeSearchQuery(owner: string, repo: string, filter: ListFilter, meQualifiers: readonly string[]): string {
  const parts = [`repo:${owner}/${repo}`];
  if (filter.status) parts.push(`is:${mapStatusToGitHub(filter.status)}`);
  for (const label of filter.labels ?? []) parts.push(`label:"${label.replace(/"/g, '\\"')}"`);
  parts.push(meQualifiers.length === 1 ? meQualifiers[0]! : `(${meQualifiers.join(" OR ")})`);
  return parts.join(" ");
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

/** Normalizes GitHub's loose mergeable_state string (not a closed enum in its own OpenAPI schema) into this project's own MergeableState. */
function mapMergeableState(gh: GhPullRequestFull): MergeableState {
  if (gh.mergeable === null) return "checking";
  if (!gh.mergeable) return "conflicting";
  return gh.mergeable_state.toLowerCase() === "unknown" ? "unknown" : "mergeable";
}

function mapReviewState(state: string): PullRequestReviewer["state"] {
  switch (state.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "PENDING":
      return "pending";
    default:
      return "unreviewed";
  }
}

/** get()-only enrichment -- see the research Doc's correction for why this needs a dedicated pulls.get() call, unreachable from list()/search(). */
function pullRequestDetailsFromFull(pull: GhPullRequestFull, reviews: GhReview[]): PullRequestDetails {
  return {
    baseBranch: pull.base.ref,
    headBranch: pull.head.ref,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    draft: pull.draft,
    merged: pull.merged,
    mergedAt: pull.merged_at ?? undefined,
    requestedReviewers: pull.requested_reviewers?.length ? pull.requested_reviewers.map((r) => r.login) : undefined,
    mergeableState: mapMergeableState(pull),
    diffStat: { filesChanged: pull.changed_files, additions: pull.additions, deletions: pull.deletions },
    reviewers: reviews.length
      ? reviews.filter((r) => r.user).map((r) => ({ username: r.user!.login, state: mapReviewState(r.state) }))
      : undefined,
  };
}

/** list()/search()-cheap population -- only what the Issues API's own "issue" schema actually carries for a PR item (see the research Doc's correction): draft and merged/mergedAt, nothing requiring the dedicated Pulls API. */
function pullRequestDetailsFromIssue(gh: GhIssue): PullRequestDetails | undefined {
  if (!gh.pull_request) return undefined;
  return { draft: gh.draft, merged: gh.pull_request.merged_at !== null, mergedAt: gh.pull_request.merged_at ?? undefined };
}

function toDomain(gh: GhIssue, pullRequest?: PullRequestDetails): Issue {
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
    pullRequest: pullRequest ?? pullRequestDetailsFromIssue(gh),
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
