/**
 * GitLab adapter — driven implementation of IssueRepository/CommentCapable against
 * the GitLab REST API v4 (docs: https://docs.gitlab.com/api/issues/).
 * Self-hosted base URLs are validated to reject SSRF-prone targets (private/loopback
 * IPs, non-HTTPS non-localhost) before any request is made.
 */
import { isIP } from "node:net";
import type { Comment, CreateInput, Issue, ListFilter, Status, UpdateInput } from "../domain/issue.js";
import { parsePriority } from "../domain/issue.js";
import { AuthRequiredError, InvalidUrlError } from "./errors.js";
import { type FetchLike, HttpClient } from "./http.js";

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
  fetchImpl?: FetchLike;
}

interface GlUser {
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

export class GitLabRepository {
  readonly name: string;
  private readonly http: HttpClient;
  private readonly projectId: string;
  private readonly readOnly: boolean;

  constructor(name: string, opts: GitLabOptions) {
    if (!opts.projectId) throw new Error("gitlab: projectId is required");
    const baseUrl = opts.baseUrl?.trim() || DEFAULT_URL;
    validateUrl(baseUrl);
    this.name = name;
    this.projectId = encodeURIComponent(opts.projectId);
    this.readOnly = !opts.token;
    this.http = new HttpClient({
      baseUrl,
      backend: "gitlab",
      fetchImpl: opts.fetchImpl,
      headers: opts.token
        ? opts.tokenType === "oauth"
          ? { Authorization: `Bearer ${opts.token}` }
          : { "PRIVATE-TOKEN": opts.token }
        : {},
    });
  }

  private requireAuth(): void {
    if (this.readOnly) throw new AuthRequiredError("gitlab", "GITLAB_TOKEN");
  }

  async list(filter: ListFilter): Promise<Issue[]> {
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const params = new URLSearchParams({ per_page: String(limit) });
    if (filter.status) params.set("state", mapStatusToGitLab(filter.status));
    if (filter.assignee) params.set("assignee_username", filter.assignee);
    if (filter.labels?.length) params.set("labels", filter.labels.join(","));

    const raw = (await this.http.get<GlIssue[]>(`/api/v4/projects/${this.projectId}/issues?${params}`)) ?? [];
    return raw.map(toDomain);
  }

  async get(key: string): Promise<Issue> {
    const iid = parseIid(key);
    const raw = await this.http.get<GlIssue>(`/api/v4/projects/${this.projectId}/issues/${iid}`);
    if (!raw) throw new Error(`gitlab: empty response for #${iid}`);
    return toDomain(raw);
  }

  async create(input: CreateInput): Promise<Issue> {
    this.requireAuth();
    const body: Record<string, unknown> = { title: input.title, description: input.description ?? "" };
    if (input.labels?.length) body.labels = input.labels.join(",");
    const raw = await this.http.post<GlIssue>(`/api/v4/projects/${this.projectId}/issues`, body);
    if (!raw) throw new Error("gitlab: create returned no body");
    return toDomain(raw);
  }

  async update(key: string, input: UpdateInput): Promise<Issue> {
    this.requireAuth();
    const iid = parseIid(key);
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.description !== undefined) body.description = input.description;
    if (input.status !== undefined) body.state_event = mapStatusEventToGitLab(input.status);
    if (input.labels !== undefined) body.labels = input.labels.join(",");
    const raw = await this.http.put<GlIssue>(`/api/v4/projects/${this.projectId}/issues/${iid}`, body);
    if (!raw) throw new Error("gitlab: update returned no body");
    return toDomain(raw);
  }

  async search(query: string, limit = 50): Promise<Issue[]> {
    const params = new URLSearchParams({ search: query, per_page: String(limit) });
    const raw = (await this.http.get<GlIssue[]>(`/api/v4/projects/${this.projectId}/issues?${params}`)) ?? [];
    return raw.map(toDomain);
  }

  // GitLab has no native sub-issue relationship exposed via the basic Issues API tier.
  async listChildren(_key: string): Promise<Issue[]> {
    return [];
  }

  async listComments(key: string): Promise<Comment[]> {
    const iid = parseIid(key);
    const raw = (await this.http.get<GlNote[]>(`/api/v4/projects/${this.projectId}/issues/${iid}/notes`)) ?? [];
    return raw.map(noteToDomain);
  }

  async addComment(key: string, body: string): Promise<Comment> {
    this.requireAuth();
    const iid = parseIid(key);
    const raw = await this.http.post<GlNote>(`/api/v4/projects/${this.projectId}/issues/${iid}/notes`, { body });
    if (!raw) throw new Error("gitlab: add comment returned no body");
    return noteToDomain(raw);
  }
}

function parseIid(key: string): string {
  return key.replace(/^#/, "");
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
