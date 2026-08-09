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

import type { AxiosAdapter } from "axios";
import type { HttpException, Config as JiraClientConfig } from "jira.js";
import { AgileClient, Version2Client } from "jira.js";
import { ApiError, BackendConfigurationError, BackendConnectionError, IssueNotFoundError } from "../issue/errors.js";
import type { Comment, CreateInput, Issue, IssueLink, ListFilter, parsePriority, Status, UpdateInput } from "../issue/issue.js";
import type { BackendConfigurationReadiness } from "../issue/repository.js";
import type { Template } from "../issue/template.js";
import { buildTemplateBody, extractTemplateSections } from "../issue/template.js";
import { classifyBackendTransportFailure } from "../issue/transport-error.js";
import * as manifest from "./manifest.js";

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
  /** Additional default project keys, beyond the single `project` above -- widens list()/search()'s own default scope (no explicit project given) as well as the background poller's sync, both via defaultProjects(). See buildSyncQuery(). */
  syncProjects?: string[];
  /** When true, the poller's background sync also pools everything assigned to the authenticated user (JQL `assignee = currentUser()`), regardless of project -- covers projects not listed in `project`/`syncProjects`. list()/search() are unaffected -- pass an explicit assignee filter for that. */
  syncMine?: boolean;
  timeoutMs?: number;
  /** Injected in tests instead of a real network call — see axios's AxiosRequestConfig.adapter. */
  axiosAdapter?: AxiosAdapter;
  /**
   * Directory holding this daemon's persisted field/status discovery manifests
   * (see ./manifest.ts), typically configDir() from config.ts. When
   * omitted, discovery still works but nothing is persisted across restarts —
   * every test and any caller that doesn't care about persistence can leave it out.
   */
  configDir?: string;
}

export interface JiraOAuthOptions {
  accessToken: string;
  cloudId: string;
  project?: string;
  syncProjects?: string[];
  syncMine?: boolean;
  timeoutMs?: number;
  axiosAdapter?: AxiosAdapter;
  configDir?: string;
}

function isOAuthOptions(opts: JiraOptions): opts is JiraOAuthOptions {
  return "accessToken" in opts;
}

interface JiraIssueLinkedIssue {
  key: string;
  fields: { summary: string; status: { name: string } };
}
interface JiraIssueLink {
  type: { name: string; inward: string; outward: string };
  inwardIssue?: JiraIssueLinkedIssue;
  outwardIssue?: JiraIssueLinkedIssue;
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
  fixVersions?: { name: string }[];
  issuelinks?: JiraIssueLink[];
  /** customfield_XXXXX passthrough -- Jira's getIssue returns every field by default, this just doesn't narrow their type. */
  [key: string]: unknown;
}
interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}
interface JiraRemoteLink {
  object?: { url?: string; title?: string };
  application?: { name?: string };
}
interface JiraComment {
  id?: string;
  // The real Jira REST v2 wire field is "body" (confirmed against Atlassian's own
  // docs/example payloads). jira.js's bundled Models.Comment type mistypes this as
  // "comment" -- a library type/runtime mismatch, not an ADF-rendering issue.
  body?: string;
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
  /** Same auth/host config Version2Client was built from -- reused lazily by agileClient() so the Agile API client (board/quickfilter resolution) authenticates identically without duplicating the OAuth-vs-basic branching in the constructor below. */
  private readonly clientConfig: JiraClientConfig;
  private readonly project?: string;
  private readonly syncProjects: string[];
  private readonly syncMine: boolean;
  private readonly configDir?: string;
  /** display name (lowercased) -> { fieldId, schema type/items }, populated lazily from client.issueFields.getFields(). */
  private customFieldCache?: Map<string, { id: string; type: string; items?: string }>;
  /** field id -> display name, the inbound counterpart of customFieldCache. Seeded from the persisted manifest at construction (no network), refreshed by discoverFields(). */
  private fieldNameById = new Map<string, string>();
  /** Jira status name -> domain Status, loaded from the persisted manifest at construction; refreshed by discoverStatuses(). Empty until discovery has run at least once (falls back to category-based mapping until then). */
  private statusManifest: manifest.Manifest;

  constructor(name: string, opts: JiraOptions) {
    this.name = name;
    this.project = opts.project;
    this.syncProjects = opts.syncProjects ?? [];
    this.syncMine = opts.syncMine ?? false;
    this.configDir = opts.configDir;

    if (this.configDir) {
      const fieldManifest = manifest.load("fields", this.name, this.configDir);
      for (const [displayName, id] of Object.entries(fieldManifest.mappings)) this.fieldNameById.set(id, displayName);
      this.statusManifest = manifest.load("statuses", this.name, this.configDir);
    } else {
      this.statusManifest = { backend: this.name, mappings: {} };
    }

    if (isOAuthOptions(opts)) {
      if (!opts.accessToken || !opts.cloudId) throw new Error("jira: accessToken and cloudId are required for OAuth mode");
      this.clientConfig = {
        authentication: { oauth2: { accessToken: opts.accessToken, cloudId: opts.cloudId } },
        // axios's own native, tested timeout handling -- a stalled call fails predictably
        // instead of hanging (see RESEARCH.md for the octokit throttling-plugin hang this
        // migration found and fixed; jira.js/axios has no equivalent auto-retry-and-wait
        // behavior by default, but had no explicit timeout either until now).
        baseRequestConfig: { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(opts.axiosAdapter ? { adapter: opts.axiosAdapter } : {}) },
      };
      this.client = new Version2Client(this.clientConfig);
      return;
    }

    if (!opts.baseUrl) throw new Error("jira: baseUrl is required");
    if (!opts.email || !opts.token) throw new Error("jira: email and token are required");
    this.clientConfig = {
      host: opts.baseUrl,
      authentication: { basic: { email: opts.email, apiToken: opts.token } },
      baseRequestConfig: { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(opts.axiosAdapter ? { adapter: opts.axiosAdapter } : {}) },
    };
    this.client = new Version2Client(this.clientConfig);
  }

  configurationReadiness(): BackendConfigurationReadiness {
    return {
      backendType: "jira",
      connectivity: "not_checked",
      read: { state: "ready", missingConfiguration: [] },
      write: this.project
        ? { state: "ready", missingConfiguration: [] }
        : {
            state: "partial",
            missingConfiguration: ["JIRA_PROJECT"],
            recovery: "Set JIRA_PROJECT (or pass input.project) for issue creation; updates and comments remain available.",
          },
    };
  }

  /**
   * An explicit filter.project always wins and narrows to exactly that one
   * project; with none given, defaults to every project this repository
   * cares about (defaultProjects() -- the same set buildSyncQuery() pools in
   * the background), not just the single legacy `project` config field.
   */
  async list(filter: ListFilter): Promise<Issue[]> {
    const projects = filter.project ? [filter.project] : this.defaultProjects();
    const clauses: string[] = [];
    const scope = projectClause(projects);
    if (scope) clauses.push(scope);
    if (filter.status) clauses.push(`status = ${jqlQuote(mapStatusToJira(filter.status))}`);
    if (filter.assignee) clauses.push(`assignee = ${jqlQuote(filter.assignee)}`);
    for (const label of filter.labels ?? []) clauses.push(`labels = ${jqlQuote(label)}`);
    return this.searchJql(buildJql(clauses, "AND"), filter.limit ?? 50);
  }

  async get(key: string): Promise<Issue> {
    const [raw, remoteLinks] = await Promise.all([
      this.call<JiraIssue>(() => this.client.issues.getIssue({ issueIdOrKey: key }), key),
      this.call<JiraRemoteLink[]>(() => this.client.issueRemoteLinks.getRemoteIssueLinks({ issueIdOrKey: key }), key),
    ]);
    const issue = this.toDomain(raw);
    if (remoteLinks.length > 0) {
      issue.externalLinks = remoteLinks.map((link) => ({
        url: link.object?.url ?? "",
        title: link.object?.title,
        type: link.application?.name,
      }));
    }
    return issue;
  }

  /** Runs a jira.js call and maps its HttpException onto this project's shared error taxonomy. */
  private async call<T>(fn: () => Promise<unknown>, key?: string): Promise<T> {
    try {
      return (await fn()) as T;
    } catch (err) {
      const status = (err as Partial<HttpException>)?.status;
      const responseStatus = (err as { response?: { status?: unknown } })?.response?.status;
      if (typeof status === "number" && typeof responseStatus === "number") {
        if (status === 404) throw new IssueNotFoundError("jira", key ?? "?");
        const message = err instanceof Error ? err.message : String(err);
        throw new ApiError("jira", "?", key ?? "?", status, redact(message));
      }
      const transportKind = classifyBackendTransportFailure(err);
      if (transportKind) throw new BackendConnectionError("jira", transportKind, err);
      throw err;
    }
  }

  async create(input: CreateInput): Promise<Issue> {
    const project = input.project ?? this.project;
    if (!project) {
      throw new BackendConfigurationError(
        "jira",
        "project is required to create an issue; pass input.project or configure JIRA_PROJECT",
        "Pass input.project or set JIRA_PROJECT (or the backend's project setting), then retry.",
      );
    }
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

  async search(query: string, limit = 50, project?: string): Promise<Issue[]> {
    const projects = project ? [project] : this.defaultProjects();
    const clauses: string[] = [];
    const scope = projectClause(projects);
    if (scope) clauses.push(scope);
    clauses.push(`text ~ ${jqlQuote(query)}`);
    return this.searchJql(buildJql(clauses, "AND"), limit);
  }

  async listChildren(key: string): Promise<Issue[]> {
    return this.searchJql(`parent = ${key} ORDER BY created ASC`, 50);
  }

  async listComments(key: string): Promise<Comment[]> {
    const result = await this.call<{ comments?: JiraComment[] }>(() => this.client.issueComments.getComments({ issueIdOrKey: key }), key);
    return (result?.comments ?? []).map(commentToDomain);
  }

  async addComment(key: string, body: string): Promise<Comment> {
    const raw = await this.call<JiraComment>(() => this.client.issueComments.addComment({ issueIdOrKey: key, comment: body }), key);
    return commentToDomain(raw);
  }

  /** RawQueryable -- runs a raw JQL string verbatim, for the "Saved query" feature (and anything else that already has real JQL rather than a ListFilter to build one from). */
  async runQuery(query: string, limit = 50): Promise<Issue[]> {
    return this.searchJql(query, limit);
  }

  /**
   * Every project this repository defaults to when a caller doesn't name one
   * explicitly -- the single `project` config plus `syncProjects`, deduped.
   * Shared by list()/search()'s own default-scope resolution and by
   * buildSyncQuery() below, so "which projects do we care about" is answered
   * in exactly one place instead of once per method.
   */
  private defaultProjects(): string[] {
    return [...new Set([this.project, ...this.syncProjects].filter((p): p is string => Boolean(p)))];
  }

  /**
   * SyncScopeExpandable -- widens what the poller's own background sync pools
   * into the local ledger beyond defaultProjects() alone: ORs in
   * "assignee = currentUser()" when syncMine is set, so issues assigned to
   * you in a project nobody listed still get pooled. Returns undefined --
   * letting the poller fall back to plain list() -- when syncMine adds
   * nothing beyond what list() already does with 0-1 default projects.
   */
  buildSyncQuery(): string | undefined {
    const projects = this.defaultProjects();
    if (projects.length <= 1 && !this.syncMine) return undefined;
    const clauses: string[] = [];
    const scope = projectClause(projects);
    if (scope) clauses.push(scope);
    if (this.syncMine) clauses.push("assignee = currentUser()");
    return buildJql(clauses, "OR");
  }

  /**
   * BoardQuickFilterDiscoverable -- resolves a board's quick filter (the same object
   * a board view's `quickFilter=` URL param and a backlog view's `customFilter=`
   * param both reference -- Jira just spells the query param differently per view)
   * to its real JQL clause, via the durable (non-deprecated)
   * `GET /rest/agile/1.0/board/{boardId}/quickfilter/{id}` endpoint. This is a
   * fragment, not a full query -- Jira itself ANDs it with the board's own project
   * scope and a sprint clause when rendering a live board/backlog view. Combine it
   * with `project = X AND sprint in openSprints()` (board/active-sprint view) or
   * `project = X AND (sprint is EMPTY OR sprint in futureSprints())` (backlog view)
   * to save as a plain runnable JQL string via query.save, same as any other saved
   * query -- no separate "board view" execution path needed. jira.js's AgileClient
   * wraps the Agile REST API surface; Version2Client (this.client) only covers the
   * Platform REST API, hence the separate client here.
   */
  async discoverBoardQuickFilterJql(boardId: number, quickFilterId: number): Promise<string> {
    const agile = this.agileClient();
    const result = await this.call<{ jql?: string }>(() => agile.board.getQuickFilter({ boardId, quickFilterId }));
    if (!result?.jql) throw new Error(`jira: quick filter ${quickFilterId} on board ${boardId} has no JQL`);
    return result.jql;
  }

  /**
   * BoardFilterDiscoverable -- resolves a board's own real base scope: its saved
   * filter's JQL, via `GET /rest/agile/1.0/board/{boardId}/configuration` (filter
   * id) then `GET /rest/api/2/filter/{id}` (that filter's JQL). This is the actual
   * project/query scope a board tracks -- assuming a board scopes to a single named
   * project (e.g. matching a URL path segment) is a guess, not a fact; a project can
   * be renamed or a board's filter can span multiple projects, so this is always
   * resolved from Jira, never inferred from a project key string.
   */
  async discoverBoardFilterJql(boardId: number): Promise<string> {
    const config = await this.call<{ filter?: { id?: string } }>(() => this.agileClient().board.getConfiguration({ boardId }));
    const filterId = config?.filter?.id;
    if (!filterId) throw new Error(`jira: board ${boardId} has no configured filter`);
    const filter = await this.call<{ jql?: string }>(() => this.client.filters.getFilter({ id: Number(filterId) }));
    if (!filter?.jql) throw new Error(`jira: filter ${filterId} (board ${boardId}'s own filter) has no JQL`);
    return filter.jql;
  }

  private agileClientInstance?: AgileClient;

  private agileClient(): AgileClient {
    this.agileClientInstance ??= new AgileClient(this.clientConfig);
    return this.agileClientInstance;
  }

  private async searchJql(jql: string, limit: number): Promise<Issue[]> {
    // searchForIssuesUsingJqlPost hits the deprecated /rest/api/2/search, which
    // Atlassian has sunset on Jira Cloud (410 Gone). The enhanced variant posts
    // to the still-live /rest/api/2/search/jql -- but unlike the old endpoint
    // (which defaulted to *navigable fields), this one defaults to id-only, so
    // toDomain() would crash on a missing summary/status/etc. without an explicit
    // fields request. "*all" restores the old behavior (including custom fields).
    const result = await this.call<{ issues?: JiraIssue[] }>(() =>
      this.client.issueSearch.searchForIssuesUsingJqlEnhancedSearchPost({ jql, maxResults: limit, fields: ["*all"] }),
    );
    return (result?.issues ?? []).map((raw) => this.toDomain(raw));
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
    if (!this.customFieldCache) await this.discoverFields();
    const field = this.customFieldCache?.get(displayName.toLowerCase());
    if (!field) throw new Error(`jira: unknown custom field "${displayName}"`);
    return field;
  }

  /**
   * Discovers every custom field's display name -> customfield_XXXXX ID via
   * client.issueFields.getFields() (GET /rest/api/2/field), same live call
   * resolveCustomField already made lazily -- this just also persists the
   * result to a manifest (see ./manifest.ts) so a later inbound
   * lookup (fieldDisplayName) doesn't need a network round trip at all, and
   * survives a daemon restart. Ported from emcee's FieldService.DiscoverFields
   * (~/Workspace/emcee), same manifest file shape.
   */
  async discoverFields(): Promise<Record<string, string>> {
    const all = await this.call<JiraFieldDetails[]>(() => this.client.issueFields.getFields());
    const custom = all.filter((f) => f.custom && f.id && f.name);
    this.customFieldCache = new Map(
      custom.map((f) => [f.name!.toLowerCase(), { id: f.id!, type: f.schema?.type ?? "string", items: f.schema?.items }]),
    );
    this.fieldNameById = new Map(custom.map((f) => [f.id!, f.name!]));
    const mappings = Object.fromEntries(custom.map((f) => [f.name!, f.id!]));
    if (this.configDir) manifest.save("fields", this.name, this.configDir, manifest.discover(this.name, mappings));
    return mappings;
  }

  /** Inbound counterpart of resolveCustomField -- a display name for a raw customfield_XXXXX id, or undefined if never discovered. Never makes a network call; run discoverFields() (or construct with configDir set, so a prior discovery's manifest loads automatically) first. */
  fieldDisplayName(fieldId: string): string | undefined {
    return this.fieldNameById.get(fieldId);
  }

  /**
   * Discovers every Jira status name -> domain Status via
   * client.workflowStatuses.getStatuses() (GET /rest/api/2/status), persists
   * it to a manifest, and immediately applies it in-memory so status mapping
   * reflects the discovery without a daemon restart. Ported from emcee's
   * StatusService.DiscoverStatuses.
   */
  async discoverStatuses(): Promise<Record<string, string>> {
    const all = await this.call<{ name: string; statusCategory?: { key: string } }[]>(() => this.client.workflowStatuses.getStatuses());
    const mappings = Object.fromEntries(all.map((s) => [s.name, categoryToStatus(s.statusCategory?.key)]));
    this.statusManifest = manifest.discover(this.name, mappings);
    if (this.configDir) manifest.save("statuses", this.name, this.configDir, this.statusManifest);
    return mappings;
  }

  /**
   * Samples the most recently created issues for a project/issue-type pair
   * and extracts the description section headers common to all of them --
   * see ../issue/template.ts. Ported from emcee's TemplateService.DiscoverTemplate.
   */
  async discoverTemplate(project: string, issueType: string, sampleSize = 5): Promise<Template | undefined> {
    const jql = `project = ${jqlQuote(project)} AND issuetype = ${jqlQuote(issueType)} ORDER BY created DESC`;
    const issues = await this.searchJql(jql, sampleSize > 0 ? sampleSize : 5);
    const descriptions = issues.map((issue) => issue.description).filter((d): d is string => !!d);
    const sections = extractTemplateSections(descriptions);
    if (!sections) return undefined;
    return { project, issueType, sections, body: buildTemplateBody(sections) };
  }

  private resolveStatus(categoryKey: string | undefined, statusName: string): Status {
    const mapped = manifest.get(this.statusManifest, statusName);
    if (mapped) return mapped as Status;
    return mapStatusFromCategory(categoryKey);
  }

  private toDomain(j: JiraIssue): Issue {
    const issue: Issue = {
      ref: `jira:${j.key}`,
      id: j.id,
      key: j.key,
      title: j.fields.summary,
      description: j.fields.description ?? undefined,
      status: this.resolveStatus(j.fields.status.statusCategory?.key, j.fields.status.name),
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
    if (j.fields.fixVersions?.length) issue.fixVersions = j.fields.fixVersions.map((v) => v.name);
    if (j.fields.issuelinks?.length) issue.issueLinks = j.fields.issuelinks.flatMap(jiraIssueLinkToDomain);
    const customFields = this.extractCustomFields(j.fields);
    if (customFields) issue.customFields = customFields;
    return issue;
  }

  /**
   * Every customfield_XXXXX Jira's getIssue response already carries (no
   * extra call -- "All fields are returned by default", jira.js's own
   * getIssue doc comment), keyed by display name via fieldNameById. A field
   * with no known display name yet (discovery never ran for this backend) is
   * skipped, not guessed at -- matching emcee's own "unmapped field, skip
   * silently" behavior. Run `tickets discover fields -b <backend>` once, or
   * construct with configDir set so a prior discovery's manifest loads
   * automatically (see the constructor), to make more fields resolvable.
   */
  private extractCustomFields(fields: JiraIssueFields): Record<string, string> | undefined {
    if (this.fieldNameById.size === 0) return undefined;
    let result: Record<string, string> | undefined;
    for (const [fieldId, displayName] of this.fieldNameById) {
      const raw = fields[fieldId];
      if (raw === undefined || raw === null) continue;
      const value = formatCustomFieldValue(raw);
      if (value === undefined) continue;
      result ??= {};
      result[displayName] = value;
    }
    return result;
  }
}

function jiraIssueLinkToDomain(link: JiraIssueLink): IssueLink[] {
  const links: IssueLink[] = [];
  if (link.outwardIssue) {
    links.push({
      type: link.type.outward,
      direction: "outward",
      targetRef: `jira:${link.outwardIssue.key}`,
      targetKey: link.outwardIssue.key,
      targetTitle: link.outwardIssue.fields.summary,
      targetStatus: link.outwardIssue.fields.status.name,
    });
  }
  if (link.inwardIssue) {
    links.push({
      type: link.type.inward,
      direction: "inward",
      targetRef: `jira:${link.inwardIssue.key}`,
      targetKey: link.inwardIssue.key,
      targetTitle: link.inwardIssue.fields.summary,
      targetStatus: link.inwardIssue.fields.status.name,
    });
  }
  return links;
}

/** Formats one raw customfield_XXXXX value for display: a {name}-bearing array (e.g. version fields) joins names; a {value} option object unwraps; everything else is stringified as-is. */
function formatCustomFieldValue(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) {
    const names = raw
      .map((item) => (item && typeof item === "object" && "name" in item ? String((item as { name: unknown }).name) : undefined))
      .filter((n): n is string => !!n);
    return names.length > 0 ? names.join(", ") : undefined;
  }
  if (raw && typeof raw === "object") {
    if ("value" in raw) return String((raw as { value: unknown }).value);
    if ("name" in raw) return String((raw as { name: unknown }).name);
  }
  return undefined;
}

function coerceCustomFieldValue(field: { type: string; items?: string }, rawValue: string): unknown {
  if (field.type === "array") {
    const parts = rawValue
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
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

/** Shared by list()/search()/buildSyncQuery() -- `project = X` for one project, `project in (...)` for several, undefined for none. */
function projectClause(projects: readonly string[]): string | undefined {
  if (projects.length === 0) return undefined;
  if (projects.length === 1) return `project = ${jqlQuote(projects[0]!)}`;
  return `project in (${projects.map(jqlQuote).join(", ")})`;
}

/** Shared by list()/search()/buildSyncQuery() -- clauses joined by `joiner`, always ordered by `orderBy`. An empty clause list still yields valid JQL ("ORDER BY ..."), matching every one of this file's own pre-existing unscoped queries. */
function buildJql(clauses: readonly string[], joiner: "AND" | "OR", orderBy = "created DESC"): string {
  return `${clauses.join(` ${joiner} `)} ORDER BY ${orderBy}`.trim();
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

/** Baseline category -> Status mapping, used until a per-status-name manifest entry (discoverStatuses) says otherwise -- same fallback emcee's own mapStatusFromJira uses. */
function mapStatusFromCategory(categoryKey: string | undefined): Status {
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

/** categoryKey -> Status, used by discoverStatuses() to seed the persisted manifest from Jira's own status listing. */
function categoryToStatus(categoryKey: string | undefined): Status {
  return mapStatusFromCategory(categoryKey);
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

function commentToDomain(c: JiraComment): Comment {
  return {
    id: c.id ?? "",
    body: c.body ?? "",
    author: c.author?.displayName,
    createdAt: c.created,
    updatedAt: c.updated,
  };
}
