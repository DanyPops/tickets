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

export const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
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

/** A link to another issue on the same backend (e.g. Jira's issuelinks: blocks, relates to, caused by). */
export interface IssueLink {
  /** The link type's own label from the backend's perspective of this issue, e.g. "blocks" or "is blocked by". */
  type: string;
  direction: "inward" | "outward";
  targetRef: string;
  targetKey: string;
  targetTitle?: string;
  targetStatus?: string;
}

/** A link to something outside the issue tracker entirely (e.g. Jira's "Web Links"/remote links: a PR, a doc). */
export interface ExternalLink {
  url: string;
  title?: string;
  /** The linked application's own name when the backend reports one, e.g. "GitHub". */
  type?: string;
}

/**
 * Normalized across backends even though availability differs: GitHub only reports this on
 * get() (list/search omit it entirely); GitLab reports merge_status/detailed_merge_status on
 * both list and get, but is still normalized to get()-only here so callers get one predictable
 * contract instead of a per-backend availability difference. See the research Doc "Tickets
 * PR/MR support: grounded GitHub & GitLab API research and domain design" for the source API
 * fields each state is derived from.
 */
export type MergeableState = "mergeable" | "conflicting" | "checking" | "unknown";

/**
 * get()-only on both backends. GitLab never totals additions/deletions in its merge request
 * object (only a `changes_count` string like "5" or "1000+") -- getting real added/removed line
 * counts would need a separate Diffs-API round trip this project's N+1-avoidance discipline
 * says to skip, so additions/deletions stay undefined for GitLab.
 */
export interface PullRequestDiffStat {
  filesChanged: number;
  additions?: number;
  deletions?: number;
}

/** Per-reviewer review state -- always a dedicated call on both backends (GitHub: listReviews(); GitLab: showReviewers()), never embedded in the list/get response itself. */
export interface PullRequestReviewer {
  username: string;
  /** Only populated by get() -- both backends require the same dedicated call regardless of path. */
  state?: "approved" | "changes_requested" | "commented" | "pending" | "unreviewed";
}

/**
 * The extra fields a GitHub pull request / GitLab merge request carries beyond a plain Issue.
 * A PR/MR is an issue superset via both platforms' own APIs, so this lives as an optional field
 * on Issue (see below) rather than a parallel type hierarchy -- every existing Issue consumer
 * keeps working unchanged for a plain issue, where this is simply undefined.
 */
export interface PullRequestDetails {
  /** Undefined at list()/search() time for a backend whose issue-superset listing endpoint doesn't carry branch refs (GitHub) -- populated by get() there. Always present for a backend with a dedicated MR endpoint (GitLab). */
  baseBranch?: string;
  headBranch?: string;
  baseSha?: string;
  headSha?: string;
  draft?: boolean;
  merged?: boolean;
  mergedAt?: string;
  /** list()/search()-cheap on both backends -- populated with zero extra calls. */
  requestedReviewers?: string[];
  /** get()-only -- see MergeableState's own doc comment for why this is normalized across backends. */
  mergeableState?: MergeableState;
  /** get()-only on both backends. */
  diffStat?: PullRequestDiffStat;
  /** get()-only on both backends (a dedicated call every time, on either backend). */
  reviewers?: PullRequestReviewer[];
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
  /** Versions this issue is fixed in/targeted for release in (Jira: fixVersions). */
  fixVersions?: string[];
  /** Links to other issues on the same backend (Jira: issuelinks). */
  issueLinks?: IssueLink[];
  /** Links to things outside the tracker entirely -- PRs, docs (Jira: "Web Links"/remote links). Only populated by get(), not list()/search(), to avoid one extra API call per result. */
  externalLinks?: ExternalLink[];
  /** Custom fields keyed by their backend display name (e.g. Jira's "Target Version"), resolved via that backend's field-discovery manifest. Empty until discovery has run at least once for the backend. */
  customFields?: Record<string, string>;
  /** Present only for a GitHub pull request / GitLab merge request -- undefined for a plain issue. */
  pullRequest?: PullRequestDetails;
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
  /**
   * "Mine" filtering -- deliberately a small set of named, orthogonal boolean flags rather than
   * either a hardcoded single `mine` concept or a generic cross-backend query language (see the
   * research Doc "Tickets 'mine' filtering: grounded API research" for why both alternatives were
   * rejected). Every backend maps each flag to its own native "current user" mechanism (Jira's JQL
   * currentUser(), GitHub's Search API @me qualifiers, GitLab's scope=*_me) -- never a resolved
   * literal username. Setting more than one of these ORs them together ("assignee OR reporter"),
   * AND'd with every other ListFilter field exactly like today's plain fields. A backend that has
   * no native equivalent for a given flag throws rather than silently ignoring it (e.g.
   * reviewRequestedOfMe on Jira, qaContactIsMe on GitHub/GitLab) -- a silently-dropped role would
   * make an incomplete result look complete.
   */
  /** Jira: `reporter = currentUser()`. GitHub: `author:@me` (Search API). GitLab: `scope=created_by_me` (Issues API). */
  reportedByMe?: boolean;
  /** Jira: `assignee = currentUser()`. GitHub: `assignee:@me` (Search API). GitLab: `scope=assigned_to_me` (Issues API). */
  assignedToMe?: boolean;
  /**
   * GitHub: `user-review-requested:@me` (Search API, PRs only). GitLab: `scope=reviews_for_me` --
   * a merge-request-only concept list()'s Issues-only scope can't express, so GitLab throws. Jira
   * has no reviewer concept on plain issues, so Jira throws too.
   */
  reviewRequestedOfMe?: boolean;
  /** Jira only, via the discovered "QA Contact" custom field (auto-discovers if never run). GitHub/GitLab throw -- no equivalent concept. */
  qaContactIsMe?: boolean;
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
