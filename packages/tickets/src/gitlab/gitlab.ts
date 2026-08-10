/**
 * GitLab adapter — driven implementation of IssueRepository/CommentCapable against
 * the GitLab REST API v4, via @gitbeaker/rest (github.com/jdalrymple/gitbeaker)
 * rather than a hand-rolled HTTP client: a mature, actively-maintained,
 * TypeScript-native GitLab SDK supporting both gitlab.com and self-managed
 * instances. Its typed `assignee_ids: number[]` (not a username) matches GitLab's
 * real write contract exactly — a class of bug this adapter used to have (see
 * RESEARCH.md): assignee was silently dropped in update() because a hand-rolled
 * body never resolved a username to the numeric ID GitLab's API actually requires.
 * Self-hosted base URLs are still validated to reject SSRF-prone targets before
 * any request is made.
 */

import { isIP } from "node:net";
import { GitbeakerRequestError, type RequesterType, type ResourceOptions } from "@gitbeaker/requester-utils";
import { Gitlab } from "@gitbeaker/rest";
import { ApiError, AuthRequiredError, BackendConnectionError, InvalidUrlError, IssueNotFoundError } from "../issue/errors.js";
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

export interface GitLabOptions {
  projectId: string;
  token?: string;
  /**
   * "private" (default): PRIVATE-TOKEN header, for personal/project access tokens.
   * "oauth": Authorization: Bearer header, for OAuth 2.0 access tokens (see
   * auth/gitlab-oauth.ts) — GitLab documents these as distinct auth schemes.
   */
  tokenType?: "private" | "oauth";
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected in tests instead of a real network call — see @gitbeaker/requester-utils' requesterFn. */
  requesterFn?: (resourceOptions: ResourceOptions) => RequesterType;
}

interface GlUser {
  id: number;
  username: string;
  name: string;
}
interface GlIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  author: GlUser | null;
  assignee: GlUser | null;
  labels: string[];
  created_at: string;
  updated_at: string;
}
interface GlNote {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  author: GlUser | null;
}

/**
 * GitLab's MergeRequests resource is a dedicated endpoint entirely separate from Issues --
 * issues and merge requests have their own independent `iid` sequences within a project (a
 * project can have both a `#5` issue and a `!5` merge request, unrelated to each other), unlike
 * GitHub where a PR *is* an Issue with a `pull_request` stub. list()/search() below stay
 * Issues-only, unchanged: mixing two independently-numbered collections into one list() call
 * would be surprising, not the GitHub-shaped "free extra items" case this adapter otherwise
 * mirrors. Merge requests surface instead via GitLab's own `!<iid>` reference convention
 * (mirrored by the UI itself) as a key prefix get()/approvePullRequest()/mergePullRequest()
 * all recognize -- see parseMrIid().
 */
interface GlMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  author: GlUser | null;
  assignee: GlUser | null;
  labels: string[];
  created_at: string;
  updated_at: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  draft: boolean;
  merged_at: string | null;
  merge_status: string;
  /** list()-cheap per the research Doc -- the usernames only; per-reviewer *state* always needs the dedicated showReviewers() call below. */
  reviewers: GlUser[] | null;
}
/** get()-only shape (ExpandedMergeRequestSchema) -- ordinary list()/show() responses don't carry changes_count/diff_refs. */
interface GlMergeRequestExpanded extends GlMergeRequest {
  /** A string, not a number -- GitLab caps and reports e.g. "1000+" past its own diff-size limit rather than an exact count. */
  changes_count: string;
  diff_refs: { base_sha: string; head_sha: string };
}
interface GlMergeRequestReviewerEntry {
  user: GlUser;
  state: string;
}

const DEFAULT_URL = "https://gitlab.com";
const DEFAULT_TIMEOUT_MS = 30_000;

export class GitLabRepository {
  readonly name: string;
  private readonly client: InstanceType<typeof Gitlab>;
  private readonly projectId: string;
  private readonly readOnly: boolean;

  constructor(name: string, opts: GitLabOptions) {
    if (!opts.projectId) throw new Error("gitlab: projectId is required");
    const baseUrl = opts.baseUrl?.trim() || DEFAULT_URL;
    validateUrl(baseUrl);
    this.name = name;
    this.projectId = opts.projectId;
    this.readOnly = !opts.token;
    this.client = new Gitlab({
      host: baseUrl,
      // gitbeaker generates a fresh AbortSignal.timeout() per request internally when this
      // is set (confirmed by reading its source), so a stalled call fails predictably
      // instead of hanging -- same class of gap the octokit adapter needed a manual fix for.
      queryTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(opts.token ? (opts.tokenType === "oauth" ? { oauthToken: opts.token } : { token: opts.token }) : {}),
      ...(opts.requesterFn ? { requesterFn: opts.requesterFn } : {}),
    });
  }

  private requireAuth(): void {
    if (this.readOnly) throw new AuthRequiredError("gitlab", "GITLAB_TOKEN");
  }

  configurationReadiness(): BackendConfigurationReadiness {
    return {
      backendType: "gitlab",
      connectivity: "not_checked",
      read: this.readOnly
        ? {
            state: "partial",
            missingConfiguration: ["GITLAB_TOKEN"],
            recovery: "Configure GITLAB_TOKEN for private-project reads; unauthenticated reads remain limited to public projects.",
          }
        : { state: "ready", missingConfiguration: [] },
      write: this.readOnly
        ? {
            state: "blocked",
            missingConfiguration: ["GITLAB_TOKEN"],
            recovery: "Configure GITLAB_TOKEN (or delegated OAuth) before using live write operations.",
          }
        : { state: "ready", missingConfiguration: [] },
    };
  }

  async list(filter: ListFilter): Promise<Issue[]> {
    if (filter.qaContactIsMe) throw new Error('gitlab: "qaContactIsMe" is a Jira-only concept, not supported on the gitlab backend');
    if (filter.reviewRequestedOfMe) {
      throw new Error(
        'gitlab: "reviewRequestedOfMe" is a merge-request-only concept (scope=reviews_for_me) that list()\'s Issues-only scope can\'t express -- see get()\'s "!<iid>" convention for merge requests',
      );
    }
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const scopes = meScopes(filter);
    if (scopes.length <= 1) {
      const raw = await this.call<GlIssue[]>(() =>
        this.client.Issues.all({
          projectId: this.projectId,
          perPage: limit,
          state: filter.status ? mapStatusToGitLab(filter.status) : undefined,
          assigneeUsername: filter.assignee ? [filter.assignee] : undefined,
          labels: filter.labels?.length ? filter.labels.join(",") : undefined,
          ...(scopes[0] ? { scope: scopes[0] } : {}),
        }),
      );
      return raw.map(toDomain);
    }
    // Both reportedByMe and assignedToMe: GitLab's own `scope` param takes exactly one value per
    // call (no server-side OR across scopes), so the OR-of-roles group ListFilter's own doc comment
    // describes is executed here as two calls, deduped client-side by ref -- the one place in this
    // adapter an OR of "me" flags genuinely costs more than one request (Jira/GitHub both express
    // it in a single native query).
    const results = await Promise.all(
      scopes.map((scope) =>
        this.call<GlIssue[]>(() =>
          this.client.Issues.all({
            projectId: this.projectId,
            perPage: limit,
            state: filter.status ? mapStatusToGitLab(filter.status) : undefined,
            labels: filter.labels?.length ? filter.labels.join(",") : undefined,
            scope,
          }),
        ),
      ),
    );
    const seen = new Set<string>();
    const merged: Issue[] = [];
    for (const raw of results.flat()) {
      const issue = toDomain(raw);
      if (seen.has(issue.ref)) continue;
      seen.add(issue.ref);
      merged.push(issue);
    }
    return merged.slice(0, limit);
  }

  async get(key: string): Promise<Issue> {
    if (isMergeRequestKey(key)) return this.getMergeRequest(parseMrIid(key));
    const iid = parseIid(key);
    const raw = await this.call<GlIssue>(() => this.client.Issues.show(iid, { projectId: this.projectId }));
    return toDomain(raw);
  }

  private async getMergeRequest(iid: number): Promise<Issue> {
    const [raw, reviewers] = await Promise.all([
      this.call<GlMergeRequestExpanded>(() => this.client.MergeRequests.show(this.projectId, iid)),
      this.call<GlMergeRequestReviewerEntry[]>(() => this.client.MergeRequests.showReviewers(this.projectId, iid)),
    ]);
    return mrToDomain(raw, reviewers);
  }

  async create(input: CreateInput): Promise<Issue> {
    this.requireAuth();
    const assigneeIds = input.assignee ? [await this.resolveUserId(input.assignee)] : undefined;
    const raw = await this.call<GlIssue>(() =>
      this.client.Issues.create(this.projectId, input.title, {
        description: input.description ?? "",
        labels: input.labels?.length ? input.labels.join(",") : undefined,
        assigneeIds,
      }),
    );
    return toDomain(raw);
  }

  async update(key: string, input: UpdateInput): Promise<Issue> {
    this.requireAuth();
    const iid = parseIid(key);
    const options: Record<string, unknown> = {};
    if (input.title !== undefined) options.title = input.title;
    if (input.description !== undefined) options.description = input.description;
    if (input.status !== undefined) options.stateEvent = mapStatusEventToGitLab(input.status);
    if (input.labels !== undefined) options.labels = input.labels.join(",");
    if (input.assignee !== undefined) {
      options.assigneeIds = input.assignee ? [await this.resolveUserId(input.assignee)] : [];
    }
    const raw = await this.call<GlIssue>(() => this.client.Issues.edit(this.projectId, iid, options));
    return toDomain(raw);
  }

  // project is accepted for IssueRepository interface parity but ignored --
  // GitLab's scope (projectId) is fixed at construction, not overridable per call.
  async search(query: string, limit = 50, _project?: string): Promise<Issue[]> {
    const raw = await this.call<GlIssue[]>(() => this.client.Issues.all({ projectId: this.projectId, search: query, perPage: limit }));
    return raw.map(toDomain);
  }

  // GitLab has no native sub-issue relationship exposed via the basic Issues API tier.
  async listChildren(_key: string): Promise<Issue[]> {
    return [];
  }

  async listComments(key: string): Promise<Comment[]> {
    const iid = parseIid(key);
    const raw = await this.call<GlNote[]>(() => this.client.IssueNotes.all(this.projectId, iid));
    return raw.map(noteToDomain);
  }

  async addComment(key: string, body: string): Promise<Comment> {
    this.requireAuth();
    const iid = parseIid(key);
    const raw = await this.call<GlNote>(() => this.client.IssueNotes.create(this.projectId, iid, body));
    return noteToDomain(raw);
  }

  /**
   * GitLab's approve endpoint (unlike GitHub's createReview) returns only an approval-state
   * summary, not the full MR -- so this re-fetches the same way get() does, `body` is accepted
   * for interface parity with GitHub but ignored: GitLab's approve endpoint has no comment-body
   * parameter at all (confirmed against @gitbeaker/core's ApproveMergeRequestOptions -- just
   * sha/approvalPassword).
   */
  async approvePullRequest(key: string): Promise<Issue> {
    this.requireAuth();
    const iid = parseMrIid(key);
    await this.call(() => this.client.MergeRequestApprovals.approve(this.projectId, iid));
    return this.getMergeRequest(iid);
  }

  /**
   * GitLab's merge endpoint returns the full expanded MR directly (per the research Doc) --
   * no extra show() call needed for the MR object itself, unlike approve() above. Reviewer
   * state is still a separate call every time on both backends (see PullRequestReviewer's own
   * doc comment), so that part isn't free. GitLab's accept endpoint only has a boolean `squash`
   * option, not a 3-way merge/squash/rebase choice like GitHub's -- "rebase" has no GitLab merge
   * equivalent (GitLab's own rebase is a distinct pre-merge branch operation), so it falls back
   * to a plain merge rather than rejecting the call.
   */
  async mergePullRequest(key: string, method?: "merge" | "squash" | "rebase"): Promise<Issue> {
    this.requireAuth();
    const iid = parseMrIid(key);
    const [raw, reviewers] = await Promise.all([
      this.call<GlMergeRequestExpanded>(() => this.client.MergeRequests.merge(this.projectId, iid, { squash: method === "squash" })),
      this.call<GlMergeRequestReviewerEntry[]>(() => this.client.MergeRequests.showReviewers(this.projectId, iid)),
    ]);
    return mrToDomain(raw, reviewers);
  }

  /**
   * GitLab's assignee write contract takes a numeric user ID, not a username
   * (`assignee_ids: number[]`, confirmed against @gitbeaker/rest's generated
   * types) — the exact gap the old hand-rolled adapter had (never resolved
   * this, never even attempted to set assignee at all). GitLab's own username
   * filter is an exact match, but we still confirm the returned user's
   * username matches exactly before trusting its id.
   */
  private async resolveUserId(username: string): Promise<number> {
    const users = await this.call<GlUser[]>(() => this.client.Users.all({ username }));
    const match = users.find((u) => u.username === username);
    if (!match) throw new Error(`gitlab: no user found with username "${username}"`);
    return match.id;
  }

  /** Runs a gitbeaker call and maps GitbeakerRequestError onto this project's shared error taxonomy. */
  private async call<T>(fn: () => Promise<unknown>): Promise<T> {
    try {
      return (await fn()) as T;
    } catch (err) {
      if (err instanceof GitbeakerRequestError) {
        const status = err.cause?.response?.status;
        const url = err.cause?.request?.url ?? "";
        if (status !== undefined) {
          if (status === 404) throw new IssueNotFoundError("gitlab", url);
          throw new ApiError("gitlab", err.cause?.request?.method ?? "?", url, status, redact(err.message));
        }
      }
      const transportKind = classifyBackendTransportFailure(err);
      if (transportKind) throw new BackendConnectionError("gitlab", transportKind, err);
      throw err;
    }
  }
}

function redact(text: string): string {
  return text.replace(/"(token|password|secret|api_key|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"').slice(0, 2000);
}

function parseIid(key: string): number {
  return Number(key.replace(/^#/, ""));
}

/** GitLab's own merge-request reference convention, mirrored by its UI: "!5", vs. an issue's "#5". */
function isMergeRequestKey(key: string): boolean {
  return key.trim().startsWith("!");
}

function parseMrIid(key: string): number {
  return Number(key.replace(/^!/, "").replace(/^#/, ""));
}

/** Primarily merge_status, not detailed_merge_status -- see MergeableState's own doc comment for the cross-backend normalization this feeds. */
function mapMergeableState(mergeStatus: string): MergeableState {
  switch (mergeStatus) {
    case "can_be_merged":
      return "mergeable";
    case "cannot_be_merged":
    case "cannot_be_merged_recheck":
      return "conflicting";
    case "checking":
      return "checking";
    default:
      return "unknown"; // "unchecked"
  }
}

/** GitLab's own showReviewers() state enum, mapped onto this project's cross-backend PullRequestReviewer.state. "reviewed" (a completed, non-approve/non-reject review) is the closest fit to "commented"; "review_started" (in progress) maps to "pending". */
function mapReviewerState(state: string): PullRequestReviewer["state"] {
  switch (state) {
    case "approved":
      return "approved";
    case "requested_changes":
      return "changes_requested";
    case "reviewed":
      return "commented";
    case "review_started":
      return "pending";
    default:
      return "unreviewed";
  }
}

/** "5" -> 5; GitLab reports "1000+" past its own diff-size limit -- parsed as a floor, not an exact count (see GlMergeRequestExpanded's own doc comment). */
function parseChangesCount(changesCount: string): number {
  return Number.parseInt(changesCount, 10) || 0;
}

function mapStatusToGitLab(status: Status): "opened" | "closed" {
  return status === "done" || status === "canceled" ? "closed" : "opened";
}

/** ListFilter.{reportedByMe,assignedToMe} -> GitLab Issues API `scope` values -- see ListFilter's own doc comment. */
function meScopes(filter: ListFilter): ("created_by_me" | "assigned_to_me")[] {
  const scopes: ("created_by_me" | "assigned_to_me")[] = [];
  if (filter.reportedByMe) scopes.push("created_by_me");
  if (filter.assignedToMe) scopes.push("assigned_to_me");
  return scopes;
}

function mapStatusEventToGitLab(status: Status): "close" | "reopen" {
  return status === "done" || status === "canceled" ? "close" : "reopen";
}

function mapStatusFromGitLab(state: string): Status {
  return state.toLowerCase() === "closed" ? "done" : "todo";
}

function priorityFromLabels(labels: string[]): ReturnType<typeof parsePriority> {
  for (const l of labels) {
    const lower = l.toLowerCase();
    if (lower.includes("urgent") || lower.includes("critical")) return "urgent";
    if (lower.includes("high")) return "high";
    if (lower.includes("medium")) return "medium";
    if (lower.includes("low")) return "low";
  }
  return "none";
}

function toDomain(gl: GlIssue): Issue {
  return {
    ref: `gitlab:#${gl.iid}`,
    id: String(gl.iid),
    key: `#${gl.iid}`,
    title: gl.title,
    description: gl.description ?? undefined,
    status: mapStatusFromGitLab(gl.state),
    rawStatus: gl.state,
    priority: priorityFromLabels(gl.labels ?? []),
    labels: gl.labels?.length ? gl.labels : undefined,
    assignee: gl.assignee?.username,
    reporter: gl.author?.username,
    url: gl.web_url,
    createdAt: gl.created_at,
    updatedAt: gl.updated_at,
  };
}

function mrPullRequestDetails(mr: GlMergeRequest | GlMergeRequestExpanded, reviewers: GlMergeRequestReviewerEntry[]): PullRequestDetails {
  const expanded = "changes_count" in mr ? mr : undefined;
  return {
    baseBranch: mr.target_branch,
    headBranch: mr.source_branch,
    headSha: mr.sha,
    baseSha: expanded?.diff_refs.base_sha,
    draft: mr.draft,
    merged: mr.state === "merged",
    mergedAt: mr.merged_at ?? undefined,
    requestedReviewers: mr.reviewers?.length ? mr.reviewers.map((r) => r.username) : undefined,
    mergeableState: mapMergeableState(mr.merge_status),
    diffStat: expanded ? { filesChanged: parseChangesCount(expanded.changes_count) } : undefined,
    reviewers: reviewers.length ? reviewers.map((r) => ({ username: r.user.username, state: mapReviewerState(r.state) })) : undefined,
  };
}

function mrToDomain(mr: GlMergeRequestExpanded, reviewers: GlMergeRequestReviewerEntry[]): Issue {
  return {
    ref: `gitlab:!${mr.iid}`,
    id: String(mr.iid),
    key: `!${mr.iid}`,
    title: mr.title,
    description: mr.description ?? undefined,
    status: mapStatusFromGitLab(mr.state === "merged" ? "closed" : mr.state),
    rawStatus: mr.state,
    priority: priorityFromLabels(mr.labels ?? []),
    labels: mr.labels?.length ? mr.labels : undefined,
    assignee: mr.assignee?.username,
    reporter: mr.author?.username,
    url: mr.web_url,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    pullRequest: mrPullRequestDetails(mr, reviewers),
  };
}

function noteToDomain(n: GlNote): Comment {
  return {
    id: String(n.id),
    body: n.body,
    author: n.author?.username,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
  };
}

/**
 * SSRF guard for self-hosted GitLab base URLs: require https (or http only for
 * localhost), and reject requests aimed at loopback/link-local/private IP ranges.
 */
export function validateUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidUrlError(`gitlab: invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new InvalidUrlError(`gitlab: scheme must be http(s) (got ${parsed.protocol})`);
  }
  if (parsed.protocol === "http:" && parsed.hostname !== "localhost") {
    throw new InvalidUrlError(`gitlab: http:// only allowed for localhost (got ${parsed.hostname}); use https:// for remote instances`);
  }
  if (isIP(parsed.hostname) && isPrivateIp(parsed.hostname)) {
    throw new InvalidUrlError("gitlab: private IP addresses are not allowed (blocks SSRF)");
  }
}

function isPrivateIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (/^169\.254\./.test(ip) || ip.startsWith("fe80:")) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}
