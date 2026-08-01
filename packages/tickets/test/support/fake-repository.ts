import { IssueNotFoundError } from "../../src/adapters/errors.js";
import type { CreateInput, Issue, ListFilter, UpdateInput } from "../../src/domain/issue.js";
import type { CommentCapable, IssueRepository } from "../../src/ports/repository.js";

/** In-memory IssueRepository test double — no network, deterministic, used across test suites. */
export class FakeRepository implements IssueRepository, CommentCapable {
  readonly name: string;
  private readonly issues = new Map<string, Issue>();
  private nextId = 1;

  constructor(name: string, seed: Issue[] = []) {
    this.name = name;
    for (const issue of seed) this.issues.set(issue.key, issue);
  }

  /** Records the args of the most recent list() call so a caller can be asserted to have forwarded them, notably project. */
  lastListCall?: ListFilter;

  async list(filter: ListFilter): Promise<Issue[]> {
    this.lastListCall = filter;
    let issues = [...this.issues.values()];
    if (filter.status) issues = issues.filter((i) => i.status === filter.status);
    if (filter.limit) issues = issues.slice(0, filter.limit);
    return issues;
  }

  async get(key: string): Promise<Issue> {
    const issue = this.issues.get(key);
    if (!issue) throw new IssueNotFoundError(this.name, key);
    return issue;
  }

  async create(input: CreateInput): Promise<Issue> {
    const key = `FAKE-${this.nextId++}`;
    const issue: Issue = {
      ref: `${this.name}:${key}`,
      id: key,
      key,
      title: input.title,
      description: input.description,
      status: input.status ?? "todo",
      priority: input.priority ?? "none",
      labels: input.labels,
      assignee: input.assignee,
    };
    this.issues.set(key, issue);
    return issue;
  }

  async update(key: string, input: UpdateInput): Promise<Issue> {
    const issue = await this.get(key);
    const updated: Issue = {
      ...issue,
      title: input.title ?? issue.title,
      description: input.description ?? issue.description,
      status: input.status ?? issue.status,
      priority: input.priority ?? issue.priority,
      labels: input.labels ?? issue.labels,
      assignee: input.assignee ?? issue.assignee,
    };
    this.issues.set(key, updated);
    return updated;
  }

  /** Records the args of the most recent search() call so a caller (e.g. TicketService) can be asserted to have forwarded them, notably project. */
  lastSearchCall?: { query: string; limit?: number; project?: string };

  async search(query: string, limit?: number, project?: string): Promise<Issue[]> {
    this.lastSearchCall = { query, limit, project };
    return [...this.issues.values()].filter((i) => i.title.includes(query));
  }

  /** Records the args of the most recent runQuery() call so a caller can be asserted to have forwarded them. */
  lastRunQueryCall?: { query: string; limit?: number };

  /** RawQueryable -- treats the "query" as a plain substring filter over title, same shallow semantics as search(), just under the raw-query capability instead. */
  async runQuery(query: string, limit?: number): Promise<Issue[]> {
    this.lastRunQueryCall = { query, limit };
    let issues = [...this.issues.values()].filter((i) => i.title.includes(query));
    if (limit) issues = issues.slice(0, limit);
    return issues;
  }

  async listChildren(): Promise<Issue[]> {
    return [];
  }

  async listComments() {
    return [];
  }

  async addComment(key: string, body: string) {
    await this.get(key);
    return { id: "c1", body };
  }
}
