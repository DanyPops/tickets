/**
 * Jira adapter — driven implementation of IssueRepository/CommentCapable against
 * the Jira Cloud REST API v2, via jira.js's Version2Client (github.com/MrRefactoring/jira.js)
 * rather than a hand-rolled HTTP client: a mature, actively-maintained,
 * TypeScript-native client generated directly from Atlassian's own OpenAPI spec.
 * Status changes go through Jira's workflow transitions, not a direct field PUT —
 * Jira statuses are workflow-owned, so we resolve the transition whose name matches
 * the mapped target status and post to it.
 *
 * NOTE: assignee is deliberately NOT handled in create()/update() here — out of
 * scope for this migration per explicit user direction, even though the mature
 * client's `UserDetails.accountId` typing would make the fix straightforward
 * (see RESEARCH.md for the full analysis of the bug this leaves unfixed).
 */
import { Version2Client } from "jira.js";
import type { HttpException } from "jira.js";
import type { AxiosAdapter } from "axios";
import type { Comment, CreateInput, Issue, ListFilter, Status, UpdateInput } from "../domain/issue.js";
import { parsePriority } from "../domain/issue.js";
import { ApiError, IssueNotFoundError } from "./errors.js";

/**
 * Basic-auth mode (email + API token) hits the tenant's own *.atlassian.net
 * domain directly. OAuth 2.0 (3LO) mode (accessToken + cloudId, see
 * auth/jira-oauth.ts) instead goes through api.atlassian.com/ex/jira/{cloudId}
 * with a Bearer token — Atlassian does not accept 3LO tokens against the
 * tenant domain directly; jira.js resolves that gateway routing itself when
 * given `authentication.oauth2`. Exactly one of the two auth modes must be given.
 */
export type JiraOptions = JiraBasicAuthOptions | JiraOAuthOptions;

const DEFAULT_TIMEOUT_MS = 30_000;

export interface JiraBasicAuthOptions {
  baseUrl: string;
  email: string;
  token: string;
  project?: string;
  timeoutMs?: number;
  /** Injected in tests instead of a real network call — see axios's AxiosRequestConfig.adapter. */
  axiosAdapter?: AxiosAdapter;
}

export interface JiraOAuthOptions {
  accessToken: string;
  cloudId: string;
  project?: string;
  timeoutMs?: number;
  axiosAdapter?: AxiosAdapter;
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
interface JiraComment {
  id?: string;
  comment?: string;
  created?: string;
  updated?: string;
  author?: { displayName?: string };
}
interface JiraFieldDetails {
  id?: string;
  name?: string;
  custom?: boolean;
  schema?: { type: string; items?: string };
}

export class JiraRepository {
  readonly name: string;
  private readonly client: Version2Client;
  private readonly project?: string;
  /** display name (lowercased) -> { fieldId, schema type/items }, populated lazily from client.issueFields.getFields(). */
  private customFieldCache?: Map<string, { id: string; type: string; items?: string }>;

  constructor(name: string, opts: JiraOptions) {
    this.name = name;
    this.project = opts.project;

    if (isOAuthOptions(opts)) {
      if (!opts.accessToken || !opts.cloudId) throw new Error("jira: accessToken and cloudId are required for OAuth mode");
      this.client = new Version2Client({
        authentication: { oauth2: { accessToken: opts.accessToken, cloudId: opts.cloudId } },
        // axios's own native, tested timeout handling -- a stalled call fails predictably
        // instead of hanging (see RESEARCH.md for the octokit throttling-plugin hang this
        // migration found and fixed; jira.js/axios has no equivalent auto-retry-and-wait
        // behavior by default, but had no explicit timeout either until now).
        baseRequestConfig: { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(opts.axiosAdapter ? { adapter: opts.axiosAdapter } : {}) },
      });
      return;
    }

    if (!opts.baseUrl) throw new Error("jira: baseUrl is required");
    if (!opts.email || !opts.token) throw new Error("jira: email and token are required");
    this.client = new Version2Client({
      host: opts.baseUrl,
      authentication: { basic: { email: opts.email, apiToken: opts.token } },
      baseRequestConfig: { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(opts.axiosAdapter ? { adapter: opts.axiosAdapter } : {}) },
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
    const raw = await this.call<JiraIssue>(() => this.client.issues.getIssue({ issueIdOrKey: key }), key);
    return toDomain(raw);
  }

  /** Runs a jira.js call and maps its HttpException onto this project's shared error taxonomy. */
  private async call<T>(fn: () => Promise<unknown>, key?: string): Promise<T> {
    try {
      return (await fn()) as T;
    } catch (err) {
      const status = (err as Partial<HttpException>)?.status;
      if (typeof status === "number") {
        if (status === 404) throw new IssueNotFoundError("jira", key ?? "?");
        const message = err instanceof Error ? err.message : String(err);
        throw new ApiError("jira", "?", key ?? "?", status, redact(message));
      }
      throw err;
    }
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
    if (input.customFields) await this.applyCustomFields(fields, input.customFields);
    const result = await this.call<{ key: string }>(() => this.client.issues.createIssue({ fields } as never));
    return this.get(result.key);
  }

  async update(key: string, input: UpdateInput): Promise<Issue> {
    const fields: Record<string, unknown> = {};
    if (input.title !== undefined) fields.summary = input.title;
    if (input.description !== undefined) fields.description = input.description;
    if (input.priority !== undefined) fields.priority = { name: mapPriorityToJira(input.priority) };
    if (input.labels !== undefined) fields.labels = input.labels;
    if (input.customFields) await this.applyCustomFields(fields, input.customFields);
    // assignee intentionally not handled here — see file header.
    if (Object.keys(fields).length > 0) {
      await this.call(() => this.client.issues.editIssue({ issueIdOrKey: key, fields }), key);
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
    const result = await this.call<{ comments?: JiraComment[] }>(
      () => this.client.issueComments.getComments({ issueIdOrKey: key }),
      key,
    );
    return (result?.comments ?? []).map(commentToDomain);
  }

  async addComment(key: string, body: string): Promise<Comment> {
    const raw = await this.call<JiraComment>(
      () => this.client.issueComments.addComment({ issueIdOrKey: key, comment: body }),
      key,
    );
    return commentToDomain(raw);
  }

  private async searchJql(jql: string, limit: number): Promise<Issue[]> {
    const result = await this.call<{ issues?: JiraIssue[] }>(() =>
      this.client.issueSearch.searchForIssuesUsingJqlPost({ jql, maxResults: limit }),
    );
    return (result?.issues ?? []).map(toDomain);
  }

  private async transitionTo(key: string, status: Status, resolution?: string): Promise<void> {
    const target = mapStatusToJira(status);
    const result = await this.call<{ transitions?: { id: string; name: string }[] }>(
      () => this.client.issues.getTransitions({ issueIdOrKey: key }),
      key,
    );
    const transitions = result?.transitions ?? [];
    const match = transitions.find((t) => t.name.toLowerCase() === target.toLowerCase());
    if (!match) {
      const available = transitions.map((t) => t.name).join(", ");
      throw new Error(`jira: no transition matching "${target}" (available: ${available})`);
    }
    const fields = resolution ? { resolution: { name: resolution } } : undefined;
    await this.call(() => this.client.issues.doTransition({ issueIdOrKey: key, transition: { id: match.id }, fields }), key);
  }

  /**
   * Resolves each custom field's display name to its `customfield_XXXXX` ID via
   * client.issueFields.getFields() (GET /rest/api/2/field) -- not a hand-maintained
   * map -- and coerces the given string value to the shape that field's own Jira
   * schema type expects (a plain "option"/select field wants `{value}`, an array
   * field splits on commas, everything else passes through as a raw string).
   */
  private async applyCustomFields(fields: Record<string, unknown>, customFields: Record<string, string>): Promise<void> {
    for (const [displayName, rawValue] of Object.entries(customFields)) {
      const field = await this.resolveCustomField(displayName);
      fields[field.id] = coerceCustomFieldValue(field, rawValue);
    }
  }

  private async resolveCustomField(displayName: string): Promise<{ id: string; type: string; items?: string }> {
    if (!this.customFieldCache) {
      const all = await this.call<JiraFieldDetails[]>(() => this.client.issueFields.getFields());
      this.customFieldCache = new Map(
        all
          .filter((f) => f.custom && f.id && f.name)
          .map((f) => [f.name!.toLowerCase(), { id: f.id!, type: f.schema?.type ?? "string", items: f.schema?.items }]),
      );
    }
    const field = this.customFieldCache.get(displayName.toLowerCase());
    if (!field) throw new Error(`jira: unknown custom field "${displayName}"`);
    return field;
  }
}

function coerceCustomFieldValue(field: { type: string; items?: string }, rawValue: string): unknown {
  if (field.type === "array") {
    const parts = rawValue.split(",").map((v) => v.trim()).filter(Boolean);
    return field.items === "option" ? parts.map((v) => ({ value: v })) : parts;
  }
  if (field.type === "option") return { value: rawValue };
  if (field.type === "number") return Number(rawValue);
  return rawValue;
}

function redact(text: string): string {
  return text.replace(/"(token|password|secret|api_key|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"').slice(0, 2000);
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
    id: c.id ?? "",
    body: c.comment ?? "",
    author: c.author?.displayName,
    createdAt: c.created,
    updatedAt: c.updated,
  };
}
