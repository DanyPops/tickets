/**
 * Domain package — the canonical, backend-agnostic representation of a work item.
 * Zero external dependencies, zero I/O. Mirrors the shape independently reachable
 * from GitHub Issues, GitLab Issues, and Jira issues (see RESEARCH.md for the
 * source API docs each adapter was built against).
 */

export const PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Accepts case-insensitive strings and falls back to "none" for anything unrecognized. */
export function parsePriority(value: unknown): Priority {
  if (typeof value !== "string") return "none";
  const lower = value.toLowerCase().trim();
  return (PRIORITIES as readonly string[]).includes(lower) ? (lower as Priority) : "none";
}

export const STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export type Status = (typeof STATUSES)[number];

export function parseStatus(value: unknown, fallback: Status = "todo"): Status {
  if (typeof value !== "string") return fallback;
  const lower = value.toLowerCase().trim();
  return (STATUSES as readonly string[]).includes(lower) ? (lower as Status) : fallback;
}

export interface IssueParent {
  key: string;
  title: string;
  status?: string;
}

export interface Comment {
  id: string;
  body: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** The unified representation of a work item, regardless of which platform it lives on. */
export interface Issue {
  /** "backend:key", e.g. "jira:PROJ-42" or "github:#7". */
  ref: string;
  id: string;
  key: string;
  title: string;
  description?: string;
  status: Status;
  /** The backend's own status string, preserved for round-tripping/debugging. */
  rawStatus?: string;
  priority: Priority;
  labels?: string[];
  assignee?: string;
  reporter?: string;
  project?: string;
  issueType?: string;
  resolution?: string;
  parent?: IssueParent;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
}

export interface CreateInput {
  title: string;
  description?: string;
  status?: Status;
  priority?: Priority;
  labels?: string[];
  assignee?: string;
  project?: string;
  issueType?: string;
  parentKey?: string;
  /** Backend-specific custom fields keyed by display name (e.g. Jira's "QE Priority"), resolved to the backend's own field ID by the adapter. Not every backend supports this (only Jira does today). */
  customFields?: Record<string, string>;
}

export interface UpdateInput {
  title?: string;
  description?: string;
  status?: Status;
  priority?: Priority;
  labels?: string[];
  assignee?: string;
  resolution?: string;
  /** Backend-specific custom fields keyed by display name (e.g. Jira's "QE Priority"), resolved to the backend's own field ID by the adapter. Not every backend supports this (only Jira does today). */
  customFields?: Record<string, string>;
}

export interface ListFilter {
  project?: string;
  status?: Status;
  labels?: string[];
  assignee?: string;
  query?: string;
  limit?: number;
}

/** "backend:key" ref parsing, split on the first colon only (keys may contain colons). */
export function parseRef(ref: string): { backend: string; key: string } {
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx === ref.length - 1) {
    throw new Error(`invalid ref ${JSON.stringify(ref)}: expected "backend:key"`);
  }
  return { backend: ref.slice(0, idx), key: ref.slice(idx + 1) };
}

export function makeRef(backend: string, key: string): string {
  return `${backend}:${key}`;
}
