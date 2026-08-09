/**
 * Application service — the hexagon's core orchestration layer. Implements the
 * driver-facing operations (used by the CLI and the pi-tickets extension) and
 * routes every call to the named backend's repository. Depends only on ports,
 * never on a concrete adapter.
 */
import type { Comment, CreateInput, Issue, ListFilter, UpdateInput } from "./issue.js";
import { parseRef } from "./issue.js";
import {
  type BackendConfigurationReadiness,
  hasBoardFilterDiscovery,
  hasBoardQuickFilterDiscovery,
  hasComments,
  hasConfigurationReadiness,
  hasFieldDiscovery,
  hasRawQuery,
  hasStatusDiscovery,
  hasSyncScopeExpansion,
  hasTemplateDiscovery,
  type IssueRepository,
} from "./repository.js";
import type { Template } from "./template.js";

export interface BackendCapabilities {
  readonly name: string;
  readonly readiness: BackendConfigurationReadiness;
  readonly supportsRawQuery: boolean;
  readonly supportsFieldDiscovery: boolean;
  readonly supportsStatusDiscovery: boolean;
  readonly supportsTemplateDiscovery: boolean;
  readonly supportsBoardQuickFilterDiscovery: boolean;
  readonly supportsBoardFilterDiscovery: boolean;
}

export class UnknownBackendError extends Error {
  constructor(backend: string, known: string[]) {
    super(`unknown backend "${backend}" (known: ${known.join(", ") || "none configured"})`);
    this.name = "UnknownBackendError";
  }
}

export class NotSupportedError extends Error {
  constructor(backend: string, capability: string) {
    super(`${backend} does not support ${capability}`);
    this.name = "NotSupportedError";
  }
}

export class TicketService {
  constructor(private repos: Record<string, IssueRepository>) {}

  backends(): string[] {
    return Object.keys(this.repos);
  }

  /** Every configured backend's name plus which optional capabilities its own repository actually implements -- lets a driving adapter (the CLI, pi-tickets, the Vehicle tool-availability sync) branch on real capability instead of a hardcoded backend name. */
  backendCapabilities(): BackendCapabilities[] {
    return Object.values(this.repos).map((repo) => ({
      name: repo.name,
      readiness: hasConfigurationReadiness(repo)
        ? repo.configurationReadiness()
        : {
            backendType: repo.name,
            connectivity: "not_checked",
            read: {
              state: "unknown",
              missingConfiguration: [],
              recovery: "This adapter does not expose local configuration readiness.",
            },
            write: {
              state: "unknown",
              missingConfiguration: [],
              recovery: "This adapter does not expose local configuration readiness.",
            },
          },
      supportsRawQuery: hasRawQuery(repo),
      supportsFieldDiscovery: hasFieldDiscovery(repo),
      supportsStatusDiscovery: hasStatusDiscovery(repo),
      supportsTemplateDiscovery: hasTemplateDiscovery(repo),
      supportsBoardQuickFilterDiscovery: hasBoardQuickFilterDiscovery(repo),
      supportsBoardFilterDiscovery: hasBoardFilterDiscovery(repo),
    }));
  }

  /**
   * Swaps the live backend set atomically. A backend newly configured in
   * Enigma (or removed) becomes usable on the next call without
   * reconstructing the service or restarting the daemon -- see
   * config.ts's createBackendRefreshTask, the maintenance task that calls
   * this on a schedule.
   */
  setRepos(repos: Record<string, IssueRepository>): void {
    this.repos = repos;
  }

  private repo(backend: string): IssueRepository {
    const repo = this.repos[backend];
    if (!repo) throw new UnknownBackendError(backend, this.backends());
    return repo;
  }

  // Every method here is declared `async` deliberately, even where the body
  // doesn't otherwise need to await anything: ref parsing and backend lookup
  // can throw synchronously (UnknownBackendError, invalid ref), and callers
  // uniformly treat every TicketService call as a Promise. Without `async`,
  // those synchronous throws would escape before a Promise ever existed,
  // breaking `await`/`.rejects` callers alike.
  async list(backend: string, filter: ListFilter = {}): Promise<Issue[]> {
    return this.repo(backend).list(filter);
  }

  /**
   * Fetches issues for the poller's own background sync pass (see
   * process/poller.ts). Prefers a backend's own expanded sync scope
   * (SyncScopeExpandable -- Jira: multiple configured projects plus
   * everything assigned to the authenticated user, unioned into one query)
   * over its plain default-project list() when one is configured; falls
   * back to list() otherwise, so a backend with no sync scope configured
   * (or with no such capability at all, e.g. GitHub/GitLab) behaves exactly
   * as before.
   */
  async syncFetch(backend: string, limit: number): Promise<Issue[]> {
    const repo = this.repo(backend);
    if (hasSyncScopeExpansion(repo) && hasRawQuery(repo)) {
      const query = repo.buildSyncQuery();
      if (query) return repo.runQuery(query, limit);
    }
    return repo.list({ limit });
  }

  async get(ref: string): Promise<Issue> {
    const { backend, key } = parseRef(ref);
    return this.repo(backend).get(key);
  }

  async create(backend: string, input: CreateInput): Promise<Issue> {
    return this.repo(backend).create(input);
  }

  async update(ref: string, input: UpdateInput): Promise<Issue> {
    const { backend, key } = parseRef(ref);
    return this.repo(backend).update(key, input);
  }

  async search(backend: string, query: string, limit?: number, project?: string): Promise<Issue[]> {
    return this.repo(backend).search(query, limit, project);
  }

  async children(ref: string): Promise<Issue[]> {
    const { backend, key } = parseRef(ref);
    return this.repo(backend).listChildren(key);
  }

  async comments(ref: string): Promise<Comment[]> {
    const { backend, key } = parseRef(ref);
    const repo = this.repo(backend);
    if (!hasComments(repo)) throw new NotSupportedError(backend, "comments");
    return repo.listComments(key);
  }

  async addComment(ref: string, body: string): Promise<Comment> {
    const { backend, key } = parseRef(ref);
    const repo = this.repo(backend);
    if (!hasComments(repo)) throw new NotSupportedError(backend, "comments");
    return repo.addComment(key, body);
  }

  async discoverFields(backend: string): Promise<Record<string, string>> {
    const repo = this.repo(backend);
    if (!hasFieldDiscovery(repo)) throw new NotSupportedError(backend, "field discovery");
    return repo.discoverFields();
  }

  async discoverStatuses(backend: string): Promise<Record<string, string>> {
    const repo = this.repo(backend);
    if (!hasStatusDiscovery(repo)) throw new NotSupportedError(backend, "status discovery");
    return repo.discoverStatuses();
  }

  async discoverTemplate(backend: string, project: string, issueType: string, sampleSize?: number): Promise<Template | undefined> {
    const repo = this.repo(backend);
    if (!hasTemplateDiscovery(repo)) throw new NotSupportedError(backend, "template discovery");
    return repo.discoverTemplate(project, issueType, sampleSize);
  }

  /** Runs a raw query string (Jira JQL) verbatim against one backend -- the execution half of the "saved query" feature. */
  async runQuery(backend: string, query: string, limit?: number): Promise<Issue[]> {
    const repo = this.repo(backend);
    if (!hasRawQuery(repo)) throw new NotSupportedError(backend, "raw queries");
    return repo.runQuery(query, limit);
  }

  /** Resolves a Jira board's quick filter id to its JQL fragment -- the one-time step that turns a board/backlog view into a saved query. */
  async discoverBoardQuickFilterJql(backend: string, boardId: number, quickFilterId: number): Promise<string> {
    const repo = this.repo(backend);
    if (!hasBoardQuickFilterDiscovery(repo)) throw new NotSupportedError(backend, "board quick filter discovery");
    return repo.discoverBoardQuickFilterJql(boardId, quickFilterId);
  }

  /** Resolves a Jira board's own real base scope (its saved filter's JQL) -- never assume a board tracks one named project. */
  async discoverBoardFilterJql(backend: string, boardId: number): Promise<string> {
    const repo = this.repo(backend);
    if (!hasBoardFilterDiscovery(repo)) throw new NotSupportedError(backend, "board filter discovery");
    return repo.discoverBoardFilterJql(boardId);
  }
}
