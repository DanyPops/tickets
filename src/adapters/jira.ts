/**
 * Jira adapter — driven implementation of IssueRepository/CommentCapable against the
 * Jira Cloud/Server REST API v2 (docs: https://developer.atlassian.com/cloud/jira/platform/rest/v2/).
 * Status changes go through Jira's workflow transitions, not a direct field PUT —
 * Jira statuses are workflow-owned, so we resolve the transition whose name matches
 * the mapped target status and post to it.
 */
import type { Comment, CreateInput, Issue, ListFilter, Status, UpdateInput } from "../domain/issue.js";
import { parsePriority } from "../domain/issue.js";
import { type FetchLike, HttpClient } from "./http.js";

/**
 * Basic-auth mode (email + API token) hits the tenant's own *.atlassian.net
 * domain directly. OAuth 2.0 (3LO) mode (accessToken + cloudId, see
 * auth/jira-oauth.ts) instead goes through api.atlassian.com/ex/jira/{cloudId}
 * with a Bearer token — Atlassian does not accept 3LO tokens against the
 * tenant domain directly. Exactly one of the two auth modes must be given.
 */
export type JiraOptions = JiraBasicAuthOptions | JiraOAuthOptions;

export interface JiraBasicAuthOptions {
  baseUrl: string;
  email: string;
  token: string;
  project?: string;
  fetchImpl?: FetchLike;
}

export interface JiraOAuthOptions {
  accessToken: string;
  cloudId: string;
  project?: string;
  fetchImpl?: FetchLike;
}

function isOAuthOptions(opts: JiraOptions): opts is JiraOAuthOptions {
  return "accessToken" in opts;
}

interface JiraIssueFields {
  summary: string;
  description?: string | null;
  status: { name: string; statusCategory?: { key: string } };
  priority?: { name: string } | null;
  assignee?: { displayName: string } | null;
  reporter?: { displayName: string } | null;
  labels?: string[];
  project?: { key: string };
  issuetype?: { name: string };
  resolution?: { name: string } | null;
  parent?: { key: string; fields?: { summary: string; status?: { name: string } } };
  created?: string;
  updated?: string;
}
interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}
interface JiraTransition {
  id: string;
  name: string;
}
interface JiraComment {
  id: string;
  body: string;
  created: string;
  updated: string;
  author?: { displayName: string };
}

export class JiraRepository {
  readonly name: string;
  private readonly http: HttpClient;
  private readonly project?: string;

  constructor(name: string, opts: JiraOptions) {
    this.name = name;
    this.project = opts.project;

    if (isOAuthOptions(opts)) {
      if (!opts.accessToken || !opts.cloudId) throw new Error("jira: accessToken and cloudId are required for OAuth mode");
      this.http = new HttpClient({
        baseUrl: `https://api.atlassian.com/ex/jira/${opts.cloudId}`,
        backend: "jira",
        fetchImpl: opts.fetchImpl,
        headers: { Authorization: `Bearer ${opts.accessToken}` },
      });
      return;
    }

    if (!opts.baseUrl) throw new Error("jira: baseUrl is required");
    if (!opts.email || !opts.token) throw new Error("jira: email and token are required");
    const basic = Buffer.from(`${opts.email}:${opts.token}`).toString("base64");
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      backend: "jira",
      fetchImpl: opts.fetchImpl,
      headers: { Authorization: `Basic ${basic}` },
    });
  }

  async list(filter: ListFilter): Promise<Issue[]> {
    const project = filter.project ?? this.project;
    const clauses: string[] = [];
    if (project) clauses.push(`project = ${jqlQuote(project)}`);
    if (filter.status) clauses.push(`status = ${jqlQuote(mapStatusToJira(filter.status))}`);
    if (filter.assignee) clauses.push(`assignee = ${jqlQuote(filter.assignee)}`);
    for (const label of filter.labels ?? []) clauses.push(`labels = ${jqlQuote(label)}`);
    const jql = `${clauses.join(" AND ")} ORDER BY created DESC`.trim();
    return this.searchJql(jql, filter.limit ?? 50);
  }

  async get(key: string): Promise<Issue> {
    const raw = await this.http.get<JiraIssue>(`/rest/api/2/issue/${key}`);
    if (!raw) throw new Error(`jira: empty response for ${key}`);
    return toDomain(raw);
  }

  async create(input: CreateInput): Promise<Issue> {
    const project = input.project ?? this.project;
    if (!project) throw new Error("jira: project is required (pass project or set a default)");
    const fields: Record<string, unknown> = {
      project: { key: project },
      summary: input.title,
      issuetype: { name: input.issueType ?? "Task" },
    };
    if (input.description) fields.description = input.description;
    if (input.labels?.length) fields.labels = input.labels;
    if (input.parentKey) fields.parent = { key: input.parentKey };
    if (input.priority && input.priority !== "none") {
      fields.priority = { name: mapPriorityToJira(input.priority) };
    }
    const result = await this.http.post<{ key: string }>("/rest/api/2/issue", { fields });
    if (!result) throw new Error("jira: create returned no body");
    return this.get(result.key);
  }

  async update(key: string, input: UpdateInput): Promise<Issue> {
    const fields: Record<string, unknown> = {};
    if (input.title !== undefined) fields.summary = input.title;
    if (input.description !== undefined) fields.description = input.description;
    if (input.priority !== undefined) fields.priority = { name: mapPriorityToJira(input.priority) };
    if (input.labels !== undefined) fields.labels = input.labels;
    if (Object.keys(fields).length > 0) {
      await this.http.put(`/rest/api/2/issue/${key}`, { fields });
    }
    if (input.status !== undefined) {
      await this.transitionTo(key, input.status, input.resolution);
    }
    return this.get(key);
  }

  async search(query: string, limit = 50): Promise<Issue[]> {
    const scope = this.project ? `project = ${jqlQuote(this.project)} AND ` : "";
    const jql = `${scope}text ~ ${jqlQuote(query)} ORDER BY created DESC`;
    return this.searchJql(jql, limit);
  }

  async listChildren(key: string): Promise<Issue[]> {
    return this.searchJql(`parent = ${key} ORDER BY created ASC`, 50);
  }

  async listComments(key: string): Promise<Comment[]> {
    const result = await this.http.get<{ comments: JiraComment[] }>(`/rest/api/2/issue/${key}/comment`);
    return (result?.comments ?? []).map(commentToDomain);
  }

  async addComment(key: string, body: string): Promise<Comment> {
    const raw = await this.http.post<JiraComment>(`/rest/api/2/issue/${key}/comment`, { body });
    if (!raw) throw new Error("jira: add comment returned no body");
    return commentToDomain(raw);
  }

  private async searchJql(jql: string, limit: number): Promise<Issue[]> {
    const result = await this.http.post<{ issues: JiraIssue[] }>("/rest/api/2/search", {
      jql,
      maxResults: limit,
    });
    return (result?.issues ?? []).map(toDomain);
  }

  private async transitionTo(key: string, status: Status, resolution?: string): Promise<void> {
    const target = mapStatusToJira(status);
    const result = await this.http.get<{ transitions: JiraTransition[] }>(
      `/rest/api/2/issue/${key}/transitions`,
    );
    const transitions = result?.transitions ?? [];
    const match = transitions.find((t) => t.name.toLowerCase() === target.toLowerCase());
    if (!match) {
      const available = transitions.map((t) => t.name).join(", ");
      throw new Error(`jira: no transition matching "${target}" (available: ${available})`);
    }
    const body: Record<string, unknown> = { transition: { id: match.id } };
    if (resolution) body.fields = { resolution: { name: resolution } };
    await this.http.post(`/rest/api/2/issue/${key}/transitions`, body);
  }
}

function jqlQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function mapStatusToJira(status: Status): string {
  switch (status) {
    case "backlog":
      return "Backlog";
    case "todo":
      return "New";
    case "in_progress":
      return "In Progress";
    case "in_review":
      return "In Review";
    case "done":
      return "Done";
    case "canceled":
      return "Closed";
    default:
      return "New";
  }
}

function mapStatusFromJira(categoryKey: string | undefined): Status {
  switch (categoryKey) {
    case "new":
      return "todo";
    case "indeterminate":
      return "in_progress";
    case "done":
      return "done";
    default:
      return "backlog";
  }
}

function mapPriorityToJira(p: ReturnType<typeof parsePriority>): string {
  switch (p) {
    case "urgent":
      return "Critical";
    case "high":
      return "Major";
    case "medium":
      return "Normal";
    case "low":
      return "Minor";
    default:
      return "Normal";
  }
}

function mapPriorityFromJira(name: string | undefined): ReturnType<typeof parsePriority> {
  if (!name) return "none";
  switch (name.toLowerCase()) {
    case "blocker":
    case "critical":
      return "urgent";
    case "major":
      return "high";
    case "normal":
    case "minor":
      return "medium";
    case "trivial":
      return "low";
    default:
      return "none";
  }
}

function toDomain(j: JiraIssue): Issue {
  const issue: Issue = {
    ref: `jira:${j.key}`,
    id: j.id,
    key: j.key,
    title: j.fields.summary,
    description: j.fields.description ?? undefined,
    status: mapStatusFromJira(j.fields.status.statusCategory?.key),
    rawStatus: j.fields.status.name,
    priority: mapPriorityFromJira(j.fields.priority?.name),
    labels: j.fields.labels?.length ? j.fields.labels : undefined,
    assignee: j.fields.assignee?.displayName,
    reporter: j.fields.reporter?.displayName,
    project: j.fields.project?.key,
    issueType: j.fields.issuetype?.name,
    resolution: j.fields.resolution?.name,
    createdAt: j.fields.created,
    updatedAt: j.fields.updated,
  };
  if (j.fields.parent) {
    issue.parent = {
      key: j.fields.parent.key,
      title: j.fields.parent.fields?.summary ?? "",
      status: j.fields.parent.fields?.status?.name,
    };
  }
  if (j.self) {
    const idx = j.self.indexOf("/rest/");
    if (idx > 0) issue.url = `${j.self.slice(0, idx)}/browse/${j.key}`;
  }
  return issue;
}

function commentToDomain(c: JiraComment): Comment {
  return {
    id: c.id,
    body: c.body,
    author: c.author?.displayName,
    createdAt: c.created,
    updatedAt: c.updated,
  };
}
