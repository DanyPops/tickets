/**
 * Application service — the hexagon's core orchestration layer. Implements the
 * driver-facing operations (used by the CLI and the pi-tickets extension) and
 * routes every call to the named backend's repository. Depends only on ports,
 * never on a concrete adapter.
 */
import type { Comment, CreateInput, Issue, ListFilter, UpdateInput } from "../domain/issue.js";
import { parseRef } from "../domain/issue.js";
import type { Template } from "../domain/template.js";
import {
  hasComments,
  hasFieldDiscovery,
  hasStatusDiscovery,
  hasTemplateDiscovery,
  type IssueRepository,
} from "../ports/repository.js";

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
}
