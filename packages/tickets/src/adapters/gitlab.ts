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
import { Gitlab } from "@gitbeaker/rest";
import { GitbeakerRequestError, type RequesterType, type ResourceOptions } from "@gitbeaker/requester-utils";
import { isIP } from "node:net";
import type { Comment, CreateInput, Issue, ListFilter, Status, UpdateInput } from "../domain/issue.js";
import { parsePriority } from "../domain/issue.js";
import { ApiError, AuthRequiredError, InvalidUrlError, IssueNotFoundError } from "./errors.js";

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
      ...(opts.token
        ? opts.tokenType === "oauth"
          ? { oauthToken: opts.token }
          : { token: opts.token }
        : {}),
      ...(opts.requesterFn ? { requesterFn: opts.requesterFn } : {}),
    });
  }

  private requireAuth(): void {
    if (this.readOnly) throw new AuthRequiredError("gitlab", "GITLAB_TOKEN");
  }

  async list(filter: ListFilter): Promise<Issue[]> {
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const raw = await this.call<GlIssue[]>(() =>
      this.client.Issues.all({
        projectId: this.projectId,
        perPage: limit,
        state: filter.status ? mapStatusToGitLab(filter.status) : undefined,
        assigneeUsername: filter.assignee ? [filter.assignee] : undefined,
        labels: filter.labels?.length ? filter.labels.join(",") : undefined,
      }),
    );
    return raw.map(toDomain);
  }

  async get(key: string): Promise<Issue> {
    const iid = parseIid(key);
    const raw = await this.call<GlIssue>(() => this.client.Issues.show(iid, { projectId: this.projectId }));
    return toDomain(raw);
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
    const raw = await this.call<GlIssue[]>(() =>
      this.client.Issues.all({ projectId: this.projectId, search: query, perPage: limit }),
    );
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
        const status = err.cause?.response?.status ?? 500;
        const url = err.cause?.request?.url ?? "";
        if (status === 404) throw new IssueNotFoundError("gitlab", url);
        throw new ApiError("gitlab", err.cause?.request?.method ?? "?", url, status, redact(err.message));
      }
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

function mapStatusToGitLab(status: Status): "opened" | "closed" {
  return status === "done" || status === "canceled" ? "closed" : "opened";
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
    throw new InvalidUrlError(
      `gitlab: http:// only allowed for localhost (got ${parsed.hostname}); use https:// for remote instances`,
    );
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
