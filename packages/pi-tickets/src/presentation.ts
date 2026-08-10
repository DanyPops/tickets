import type { JsonValue } from "@danypops/vehicle-core";

export const TICKETS_PRESENTATION_SCHEMA = "tickets.tool-details/v1" as const;
export const TICKETS_PRESENTATION_MAX_BYTES = 24 * 1024;
export const TICKETS_PRESENTATION_MAX_ITEMS = 20;
export const TICKETS_PRESENTATION_MAX_FIELD_BYTES = 160;
export const TICKETS_PRESENTATION_MAX_TEXT_BYTES = 512;
export const TICKETS_PRESENTATION_MAX_OMISSIONS = 12;

export interface TicketsPresentationCompleteness {
  readonly total: number;
  readonly returned: number;
  readonly omitted: number;
}

export interface TicketsPresentationRow {
  readonly id: string;
  readonly label: string;
  readonly status?: string;
  readonly metadata: readonly string[];
}

export interface TicketsPresentationField {
  readonly label: string;
  readonly value: string;
}

/** Per-reviewer state, bounded/redacted the same as every other presentation string. */
export interface TicketsBoardReviewer {
  readonly username: string;
  readonly state?: string;
}

/**
 * A Kanban card's curated fields -- deliberately a superset shaped like `Issue` itself
 * (plain fields plus an optional `pullRequest` sub-object), never the raw `Issue`: every
 * field here is individually bounded/redacted the same way `TicketsPresentationRow` is.
 * `variant` on the containing presentation decides which of `status`-column vs
 * `pullRequest`-derived column grouping a renderer uses; the row shape itself doesn't
 * change (a GitHub/GitLab issue.list can legitimately return a mix of plain issues and
 * PRs, so a PR-shaped row still carries `status` too).
 */
export interface TicketsBoardRow {
  readonly ref: string;
  readonly title: string;
  readonly status?: string;
  readonly parent?: { readonly key: string; readonly label: string };
  readonly labels?: readonly string[];
  readonly storyPoints?: string;
  readonly assignee?: string;
  readonly pullRequest?: {
    readonly draft?: boolean;
    readonly merged?: boolean;
    readonly mergeableState?: string;
    readonly reviewers?: readonly TicketsBoardReviewer[];
    readonly requestedReviewers?: readonly string[];
  };
}

interface TicketsPresentationBase {
  readonly schemaVersion: typeof TICKETS_PRESENTATION_SCHEMA;
  readonly operation: string;
  readonly kind: string;
  readonly completeness: TicketsPresentationCompleteness;
  readonly omissions: readonly string[];
}

export type TicketsPresentation =
  | (TicketsPresentationBase & {
      readonly kind: "list";
      readonly title: string;
      readonly rows: readonly TicketsPresentationRow[];
    })
  | (TicketsPresentationBase & {
      readonly kind: "board";
      /** "issue" groups by the domain `Status` enum (Backlog/Sprint); "pr" groups by draft/review/merge state -- see the research note on list-table.ts's own header for why a PR needs a genuinely different column axis, not just a richer card. */
      readonly variant: "issue" | "pr";
      readonly title: string;
      readonly rows: readonly TicketsBoardRow[];
    })
  | (TicketsPresentationBase & {
      readonly kind: "detail";
      readonly title: string;
      readonly fields: readonly TicketsPresentationField[];
    })
  | (TicketsPresentationBase & {
      readonly kind: "mutation";
      readonly message: string;
      readonly ref?: string;
    })
  | (TicketsPresentationBase & {
      readonly kind: "summary";
      readonly message: string;
      readonly fields: readonly TicketsPresentationField[];
    })
  | (TicketsPresentationBase & {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    });

const encoder = new TextEncoder();
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g,
  /\bBearer\s+[^\s,;]+/gi,
  /\b(?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
  return value.slice(0, end);
}

function redactSecrets(value: string): string {
  let redacted = value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}

function boundedText(value: unknown, maxBytes = TICKETS_PRESENTATION_MAX_FIELD_BYTES): string {
  const source = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const clean = redactSecrets(source).replace(/\s+/g, " ").trim();
  if (byteLength(clean) <= maxBytes) return clean;
  const suffix = "…";
  return `${truncateUtf8(clean, Math.max(0, maxBytes - byteLength(suffix)))}${suffix}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function completeness(total: number, returned: number): TicketsPresentationCompleteness {
  return { total, returned, omitted: Math.max(0, total - returned) };
}

function boundedStrings(value: unknown, maximum = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, maximum)
    .map((item) => boundedText(item));
}

function base(operation: string, kind: TicketsPresentation["kind"], total: number, returned: number, omittedFields: readonly string[]) {
  return {
    schemaVersion: TICKETS_PRESENTATION_SCHEMA,
    operation: boundedText(operation),
    kind,
    completeness: completeness(total, returned),
    omissions: omittedFields.slice(0, TICKETS_PRESENTATION_MAX_OMISSIONS).map((value) => boundedText(value)),
  } as const;
}

function field(label: string, value: unknown): TicketsPresentationField {
  return { label: boundedText(label), value: boundedText(value, TICKETS_PRESENTATION_MAX_TEXT_BYTES) };
}

function row(id: unknown, label: unknown, status?: unknown, metadata: readonly string[] = []): TicketsPresentationRow {
  return {
    id: boundedText(id),
    label: boundedText(label, TICKETS_PRESENTATION_MAX_TEXT_BYTES),
    ...(status === undefined ? {} : { status: boundedText(status) }),
    metadata: metadata.slice(0, 8).map((value) => boundedText(value)),
  };
}

function arrayEnvelope(output: unknown, key: string): unknown[] {
  const value = record(output)?.[key];
  return Array.isArray(value) ? value : [];
}

function listPresentation(
  operation: string,
  title: string,
  source: readonly unknown[],
  project: (value: unknown, index: number) => TicketsPresentationRow | undefined,
  omissions: readonly string[],
): TicketsPresentation {
  const rows = source
    .slice(0, TICKETS_PRESENTATION_MAX_ITEMS)
    .map(project)
    .filter((value): value is TicketsPresentationRow => !!value);
  return {
    ...base(operation, "list", source.length, rows.length, omissions),
    kind: "list",
    title: boundedText(title),
    rows,
  };
}

function issueRow(value: unknown): TicketsPresentationRow | undefined {
  const issue = record(value);
  if (!issue || typeof issue.ref !== "string" || typeof issue.title !== "string") return undefined;
  const metadata = [
    typeof issue.priority === "string" ? issue.priority : "",
    typeof issue.assignee === "string" ? issue.assignee : "",
    ...boundedStrings(issue.labels),
  ].filter(Boolean);
  return row(issue.ref, issue.title, issue.status ?? "unknown", metadata);
}

function boundedReviewers(value: unknown, maximum = 8): TicketsBoardReviewer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reviewers = value
    .map((entry) => record(entry))
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry.username === "string")
    .slice(0, maximum)
    .map((entry) => ({
      username: boundedText(entry.username),
      ...(typeof entry.state === "string" ? { state: boundedText(entry.state) } : {}),
    }));
  return reviewers.length > 0 ? reviewers : undefined;
}

function boardRow(value: unknown): TicketsBoardRow | undefined {
  const issue = record(value);
  if (!issue || typeof issue.ref !== "string" || typeof issue.title !== "string") return undefined;
  const parent = record(issue.parent);
  const pr = record(issue.pullRequest);
  const storyPoints = record(issue.customFields)?.["Story Points"];
  return {
    ref: boundedText(issue.ref),
    title: boundedText(issue.title, TICKETS_PRESENTATION_MAX_TEXT_BYTES),
    ...(typeof issue.status === "string" ? { status: boundedText(issue.status) } : {}),
    ...(parent && typeof parent.key === "string"
      ? { parent: { key: boundedText(parent.key), label: boundedText(parent.title ?? parent.key) } }
      : {}),
    ...(Array.isArray(issue.labels) ? { labels: boundedStrings(issue.labels) } : {}),
    ...(typeof storyPoints === "string" ? { storyPoints: boundedText(storyPoints) } : {}),
    ...(typeof issue.assignee === "string" ? { assignee: boundedText(issue.assignee) } : {}),
    ...(pr
      ? {
          pullRequest: {
            ...(typeof pr.draft === "boolean" ? { draft: pr.draft } : {}),
            ...(typeof pr.merged === "boolean" ? { merged: pr.merged } : {}),
            ...(typeof pr.mergeableState === "string" ? { mergeableState: boundedText(pr.mergeableState) } : {}),
            ...(boundedReviewers(pr.reviewers) ? { reviewers: boundedReviewers(pr.reviewers) } : {}),
            ...(Array.isArray(pr.requestedReviewers) ? { requestedReviewers: boundedStrings(pr.requestedReviewers, 8) } : {}),
          },
        }
      : {}),
  };
}

/** Same shape as `listPresentation`, for the "board" kind's own row projector/cap. */
function boardPresentation(
  operation: string,
  title: string,
  source: readonly unknown[],
  variant: "issue" | "pr",
  omissions: readonly string[],
): TicketsPresentation {
  const rows = source
    .slice(0, TICKETS_PRESENTATION_MAX_ITEMS)
    .map(boardRow)
    .filter((value): value is TicketsBoardRow => !!value);
  return {
    ...base(operation, "board", source.length, rows.length, omissions),
    kind: "board",
    variant,
    title: boundedText(title),
    rows,
  };
}

/** A homogeneous batch of PRs/MRs is a real, self-describing structural distinction (every row carries `pullRequest`) -- not a guess about caller intent -- so it can pick the PR board without any new caller-supplied flag. */
function isPullRequestBatch(source: readonly unknown[]): boolean {
  return source.length > 0 && source.every((value) => record(value)?.pullRequest !== undefined);
}

function issueFields(value: unknown): TicketsPresentationField[] | undefined {
  const issue = record(value);
  if (!issue || typeof issue.ref !== "string" || typeof issue.title !== "string") return undefined;
  return [
    field("Ref", issue.ref),
    field("Title", issue.title),
    field("Status", issue.status ?? "unknown"),
    field("Priority", issue.priority ?? "none"),
    ...(typeof issue.assignee === "string" ? [field("Assignee", issue.assignee)] : []),
    ...(typeof issue.project === "string" ? [field("Project", issue.project)] : []),
  ];
}

function issueOmissions(value: unknown): string[] {
  const issue = record(value);
  if (!issue) return ["malformed issue output omitted"];
  return ["description", "customFields", "issueLinks", "externalLinks", "url", "reporter", "rawStatus"].filter(
    (key) => issue[key] !== undefined,
  );
}

function summaryFallback(operation: string, reason: string): TicketsPresentation {
  return {
    ...base(operation, "summary", 1, 1, [reason]),
    kind: "summary",
    message: `Completed ${boundedText(operation)}`,
    fields: [],
  };
}

function projectIssueDetail(operation: string, raw: unknown): TicketsPresentation {
  const fields = issueFields(raw);
  if (!fields) return summaryFallback(operation, "malformed issue output omitted");
  const issue = record(raw)!;
  return {
    ...base(operation, "detail", 1, 1, issueOmissions(raw)),
    kind: "detail",
    title: boundedText(issue.ref),
    fields,
  };
}

function projectIssueMutation(operation: string, raw: unknown, verb: string): TicketsPresentation {
  const issue = record(raw);
  if (!issue || typeof issue.ref !== "string") return summaryFallback(operation, "malformed issue output omitted");
  return {
    ...base(operation, "mutation", 1, 1, issueOmissions(raw)),
    kind: "mutation",
    message: `${verb} ${boundedText(issue.ref)}`,
    ref: boundedText(issue.ref),
  };
}

function projectFocus(operation: string, output: unknown): TicketsPresentation {
  const raw = record(output)?.focus;
  if (raw === null) {
    return {
      ...base(operation, "summary", 0, 0, []),
      kind: "summary",
      message: "No focused issue",
      fields: [],
    };
  }
  const focus = record(raw);
  if (!focus || typeof focus.ref !== "string") return summaryFallback(operation, "malformed focus output omitted");
  const fields = [field("Ref", focus.ref), field("Title", focus.title), field("Status", focus.status), field("Updated", focus.updatedAt)];
  const omitted = typeof focus.pauseReason === "string" && focus.pauseReason ? ["focus.pauseReason"] : [];
  return {
    ...base(operation, "detail", 1, 1, omitted),
    kind: "detail",
    title: "Current focus",
    fields,
  };
}

function projectBackends(operation: string, output: unknown): TicketsPresentation {
  const source = arrayEnvelope(output, "backends");
  return listPresentation(
    operation,
    "Backends",
    source,
    (value) => {
      const backend = record(value);
      const readiness = record(backend?.readiness);
      const read = record(readiness?.read);
      const write = record(readiness?.write);
      if (!backend || typeof backend.name !== "string") return undefined;
      const missing = [...boundedStrings(read?.missingConfiguration), ...boundedStrings(write?.missingConfiguration)];
      return row(backend.name, readiness?.backendType ?? backend.name, readiness?.connectivity ?? "not_checked", [
        `read=${boundedText(read?.state ?? "unknown")}`,
        `write=${boundedText(write?.state ?? "unknown")}`,
        ...missing.map((key) => `missing=${key}`),
      ]);
    },
    ["credential values", "connectivity probes"],
  );
}

function projectMappings(operation: string, output: unknown): TicketsPresentation {
  const mappings = record(record(output)?.mappings) ?? {};
  return listPresentation(
    operation,
    operation === "discover.fields" ? "Fields" : "Statuses",
    Object.entries(mappings),
    (value) => {
      if (!Array.isArray(value) || value.length !== 2) return undefined;
      return row(value[0], value[1]);
    },
    [],
  );
}

function projectQueries(operation: string, output: unknown): TicketsPresentation {
  const source = arrayEnvelope(output, "queries");
  return listPresentation(
    operation,
    "Saved queries",
    source,
    (value) => {
      const query = record(value);
      if (!query || typeof query.name !== "string") return undefined;
      return row(query.name, query.description ?? query.name, query.backend, []);
    },
    ["queries[].query"],
  );
}

function projectQuery(operation: string, output: unknown): TicketsPresentation {
  const query = record(record(output)?.query);
  if (!query || typeof query.name !== "string") return summaryFallback(operation, "malformed query output omitted");
  return {
    ...base(operation, "detail", 1, 1, typeof query.query === "string" ? ["query.query"] : []),
    kind: "detail",
    title: boundedText(query.name),
    fields: [field("Name", query.name), field("Backend", query.backend), field("Description", query.description)],
  };
}

function stagedRow(value: unknown): TicketsPresentationRow | undefined {
  const item = record(value);
  const payload = record(item?.payload);
  if (!item || typeof item.id !== "string" || !payload || typeof payload.kind !== "string") return undefined;
  const target = payload.kind === "create" ? payload.backend : payload.ref;
  return row(item.id, target ?? "unknown", payload.kind, [
    ...(typeof item.createdAt === "string" ? [item.createdAt] : []),
    ...(typeof item.expiresAt === "string" ? [`expires=${item.expiresAt}`] : []),
  ]);
}

function projectStagedItem(operation: string, output: unknown): TicketsPresentation {
  const item = stagedRow(record(output)?.item);
  if (!item) return summaryFallback(operation, "malformed staged-item output omitted");
  return {
    ...base(operation, "detail", 1, 1, ["item.payload text and custom fields"]),
    kind: "detail",
    title: boundedText(item.id),
    fields: [
      field("ID", item.id),
      field("Kind", item.status),
      field("Target", item.label),
      ...item.metadata.map((value, index) => field(`Metadata ${index + 1}`, value)),
    ],
  };
}

/** Projects application output into the only Tickets-specific details shape Pi may persist for new rows. */
export function projectTicketsPresentation(operation: string, output: unknown): JsonValue {
  switch (operation) {
    case "query.run": {
      // A saved query is exactly the "Backlog"/"Sprint" concept -- something a human
      // curated enough to bother naming -- and already means "Kanban board" today in the
      // live interactive panel (see board-view.ts's own BoardTabComponent), so the tool-call
      // presentation matches that existing meaning rather than introducing a new opt-in flag.
      const issues = arrayEnvelope(output, "issues");
      return boardPresentation(operation, "Board", issues, "issue", [
        "issue descriptions and backend-specific fields omitted",
      ]) as unknown as JsonValue;
    }
    case "issue.list":
    case "issue.search": {
      const issues = arrayEnvelope(output, "issues");
      return isPullRequestBatch(issues)
        ? (boardPresentation(operation, "Pull Requests", issues, "pr", [
            "PR/MR descriptions and backend-specific fields omitted",
          ]) as unknown as JsonValue)
        : (listPresentation(operation, "Issues", issues, issueRow, [
            "issue descriptions and backend-specific fields omitted",
          ]) as unknown as JsonValue);
    }
    case "issue.children":
    case "ledger.search":
      return listPresentation(operation, "Issues", arrayEnvelope(output, "issues"), issueRow, [
        "issue descriptions and backend-specific fields omitted",
      ]) as unknown as JsonValue;
    case "issue.get":
      return projectIssueDetail(operation, record(output)?.issue) as unknown as JsonValue;
    case "issue.create":
      return projectIssueMutation(operation, record(output)?.issue, "Created") as unknown as JsonValue;
    case "issue.update":
      return projectIssueMutation(operation, record(output)?.issue, "Updated") as unknown as JsonValue;
    case "issue.comments":
      return listPresentation(
        operation,
        "Comments",
        arrayEnvelope(output, "comments"),
        (value, index) => {
          const comment = record(value);
          if (!comment) return undefined;
          return row(comment.id ?? index + 1, comment.author ?? "unknown", comment.createdAt, [
            typeof comment.body === "string" && comment.body ? "body omitted" : "empty body",
          ]);
        },
        ["comments[].body"],
      ) as unknown as JsonValue;
    case "issue.comment_add": {
      const comment = record(record(output)?.comment);
      if (!comment) return summaryFallback(operation, "malformed comment output omitted") as unknown as JsonValue;
      return {
        ...base(operation, "mutation", 1, 1, ["comment.body"]),
        kind: "mutation",
        message: `Comment added by ${boundedText(comment.author ?? "unknown")}`,
      } as unknown as JsonValue;
    }
    case "backends.list":
      return projectBackends(operation, output) as unknown as JsonValue;
    case "ledger.stats":
      return listPresentation(
        operation,
        "Ledger",
        arrayEnvelope(output, "backends"),
        (value) => {
          const count = record(value);
          if (!count || typeof count.backend !== "string" || !Number.isSafeInteger(count.count)) return undefined;
          return row(count.backend, `${count.count} issue(s)`);
        },
        [],
      ) as unknown as JsonValue;
    case "focus.set":
    case "focus.pause":
    case "focus.unpause": {
      const focus = record(record(output)?.focus);
      if (!focus || typeof focus.ref !== "string")
        return summaryFallback(operation, "malformed focus output omitted") as unknown as JsonValue;
      return {
        ...base(operation, "mutation", 1, 1, focus.pauseReason ? ["focus.pauseReason"] : []),
        kind: "mutation",
        message: `${boundedText(operation.replace("focus.", "Focus "))}: ${boundedText(focus.ref)}`,
        ref: boundedText(focus.ref),
      } as unknown as JsonValue;
    }
    case "focus.get":
      return projectFocus(operation, output) as unknown as JsonValue;
    case "focus.clear":
      return {
        ...base(operation, "mutation", 1, 1, []),
        kind: "mutation",
        message: record(output)?.cleared === true ? "Focus cleared" : "No focus was set",
      } as unknown as JsonValue;
    case "discover.fields":
    case "discover.statuses":
      return projectMappings(operation, output) as unknown as JsonValue;
    case "discover.template": {
      const template = record(record(output)?.template);
      if (!template) {
        return {
          ...base(operation, "summary", 0, 0, []),
          kind: "summary",
          message: "No template discovered",
          fields: [],
        } as unknown as JsonValue;
      }
      const sections = boundedStrings(template.sections, TICKETS_PRESENTATION_MAX_ITEMS);
      return {
        ...base(operation, "detail", Array.isArray(template.sections) ? template.sections.length : 0, sections.length, ["template.body"]),
        kind: "detail",
        title: "Template",
        fields: [
          field("Project", template.project),
          field("Issue type", template.issueType),
          ...sections.map((section, index) => field(`Section ${index + 1}`, section)),
        ],
      } as unknown as JsonValue;
    }
    case "discover.board_quickfilter":
    case "discover.board_filter":
      return {
        ...base(operation, "detail", 1, 1, []),
        kind: "detail",
        title: "JQL",
        fields: [field("JQL", record(output)?.jql)],
      } as unknown as JsonValue;
    case "query.list":
      return projectQueries(operation, output) as unknown as JsonValue;
    case "query.save": {
      const projected = projectQuery(operation, output);
      if (projected.kind !== "detail") return projected as unknown as JsonValue;
      return {
        ...base(operation, "mutation", 1, 1, projected.omissions),
        kind: "mutation",
        message: `Saved query ${projected.title}`,
      } as unknown as JsonValue;
    }
    case "query.remove":
      return {
        ...base(operation, "mutation", 1, 1, []),
        kind: "mutation",
        message: record(output)?.removed === true ? "Saved query removed" : "Saved query was already absent",
      } as unknown as JsonValue;
    case "stage.list":
      return listPresentation(operation, "Staged items", arrayEnvelope(output, "items"), stagedRow, [
        "items[].payload text and custom fields",
      ]) as unknown as JsonValue;
    case "stage.show":
      return projectStagedItem(operation, output) as unknown as JsonValue;
    case "stage.add":
    case "stage.patch": {
      const projected = projectStagedItem(operation, output);
      if (projected.kind !== "detail") return projected as unknown as JsonValue;
      return {
        ...base(operation, "mutation", 1, 1, projected.omissions),
        kind: "mutation",
        message: `${operation === "stage.add" ? "Staged" : "Patched"} ${projected.title}`,
        ref: projected.title,
      } as unknown as JsonValue;
    }
    case "stage.drop":
      return {
        ...base(operation, "mutation", 1, 1, []),
        kind: "mutation",
        message: record(output)?.dropped === true ? "Staged item dropped" : "Staged item was already absent",
      } as unknown as JsonValue;
    case "stage.push": {
      const result = record(record(output)?.result);
      if (result?.issue !== undefined) {
        return projectIssueMutation(operation, result.issue, "Pushed") as unknown as JsonValue;
      }
      if (result?.comment !== undefined) {
        const comment = record(result.comment);
        return {
          ...base(operation, "mutation", 1, 1, ["comment.body"]),
          kind: "mutation",
          message: `Pushed comment by ${boundedText(comment?.author ?? "unknown")}`,
        } as unknown as JsonValue;
      }
      return summaryFallback(operation, "malformed stage-push output omitted") as unknown as JsonValue;
    }
    default:
      return summaryFallback(operation, "unsupported operation output omitted") as unknown as JsonValue;
  }
}

export function createTicketsErrorPresentation(operation: string, code: string, message: string): TicketsPresentation {
  return {
    ...base(operation, "error", 1, 1, []),
    kind: "error",
    code: boundedText(code),
    message: boundedText(message, TICKETS_PRESENTATION_MAX_TEXT_BYTES),
  };
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function boundedString(value: unknown, maximum = TICKETS_PRESENTATION_MAX_FIELD_BYTES): value is string {
  return typeof value === "string" && byteLength(value) <= maximum;
}

function validStringArray(value: unknown, maximum = TICKETS_PRESENTATION_MAX_ITEMS): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => boundedString(item));
}

function validCompleteness(value: unknown): value is TicketsPresentationCompleteness {
  const item = record(value);
  return (
    !!item &&
    onlyKeys(item, ["total", "returned", "omitted"]) &&
    Number.isSafeInteger(item.total) &&
    Number.isSafeInteger(item.returned) &&
    Number.isSafeInteger(item.omitted) &&
    Number(item.total) >= 0 &&
    Number(item.returned) >= 0 &&
    Number(item.omitted) >= 0 &&
    Number(item.total) === Number(item.returned) + Number(item.omitted)
  );
}

function validRow(value: unknown): value is TicketsPresentationRow {
  const item = record(value);
  return (
    !!item &&
    Object.keys(item).every((key) => ["id", "label", "status", "metadata"].includes(key)) &&
    boundedString(item.id) &&
    boundedString(item.label, TICKETS_PRESENTATION_MAX_TEXT_BYTES) &&
    (item.status === undefined || boundedString(item.status)) &&
    validStringArray(item.metadata, 8)
  );
}

function validBoardReviewer(value: unknown): value is TicketsBoardReviewer {
  const item = record(value);
  return (
    !!item &&
    Object.keys(item).every((key) => ["username", "state"].includes(key)) &&
    boundedString(item.username) &&
    (item.state === undefined || boundedString(item.state))
  );
}

function validBoardRow(value: unknown): value is TicketsBoardRow {
  const item = record(value);
  if (!item) return false;
  const allowed = ["ref", "title", "status", "parent", "labels", "storyPoints", "assignee", "pullRequest"];
  if (!Object.keys(item).every((key) => allowed.includes(key))) return false;
  if (!boundedString(item.ref) || !boundedString(item.title, TICKETS_PRESENTATION_MAX_TEXT_BYTES)) return false;
  if (item.status !== undefined && !boundedString(item.status)) return false;
  if (item.parent !== undefined) {
    const parent = record(item.parent);
    if (!parent || !onlyKeys(parent, ["key", "label"]) || !boundedString(parent.key) || !boundedString(parent.label)) return false;
  }
  if (item.labels !== undefined && !validStringArray(item.labels, 8)) return false;
  if (item.storyPoints !== undefined && !boundedString(item.storyPoints)) return false;
  if (item.assignee !== undefined && !boundedString(item.assignee)) return false;
  if (item.pullRequest !== undefined) {
    const pr = record(item.pullRequest);
    const prAllowed = ["draft", "merged", "mergeableState", "reviewers", "requestedReviewers"];
    if (!pr || !Object.keys(pr).every((key) => prAllowed.includes(key))) return false;
    if (pr.draft !== undefined && typeof pr.draft !== "boolean") return false;
    if (pr.merged !== undefined && typeof pr.merged !== "boolean") return false;
    if (pr.mergeableState !== undefined && !boundedString(pr.mergeableState)) return false;
    if (pr.reviewers !== undefined && !validArray(pr.reviewers, validBoardReviewer)) return false;
    if (pr.requestedReviewers !== undefined && !validStringArray(pr.requestedReviewers, 8)) return false;
  }
  return true;
}

function validField(value: unknown): value is TicketsPresentationField {
  const item = record(value);
  return (
    !!item &&
    onlyKeys(item, ["label", "value"]) &&
    boundedString(item.label) &&
    boundedString(item.value, TICKETS_PRESENTATION_MAX_TEXT_BYTES)
  );
}

function validArray<T>(value: unknown, predicate: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.length <= TICKETS_PRESENTATION_MAX_ITEMS && value.every(predicate);
}

/** Strict replay parser: unknown versions, extra keys, malformed values, cycles, and oversized details fail closed. */
export function parseTicketsPresentation(value: unknown): TicketsPresentation | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (!serialized || byteLength(serialized) > TICKETS_PRESENTATION_MAX_BYTES) return undefined;
  const item = record(value);
  if (
    !item ||
    item.schemaVersion !== TICKETS_PRESENTATION_SCHEMA ||
    !boundedString(item.operation) ||
    !boundedString(item.kind) ||
    !validCompleteness(item.completeness) ||
    !validStringArray(item.omissions, TICKETS_PRESENTATION_MAX_OMISSIONS)
  )
    return undefined;

  const common = ["schemaVersion", "operation", "kind", "completeness", "omissions"];
  switch (item.kind) {
    case "list":
      return onlyKeys(item, [...common, "title", "rows"]) && boundedString(item.title) && validArray(item.rows, validRow)
        ? (item as unknown as TicketsPresentation)
        : undefined;
    case "board":
      return onlyKeys(item, [...common, "variant", "title", "rows"]) &&
        (item.variant === "issue" || item.variant === "pr") &&
        boundedString(item.title) &&
        validArray(item.rows, validBoardRow)
        ? (item as unknown as TicketsPresentation)
        : undefined;
    case "detail":
      return onlyKeys(item, [...common, "title", "fields"]) &&
        boundedString(item.title, TICKETS_PRESENTATION_MAX_TEXT_BYTES) &&
        validArray(item.fields, validField)
        ? (item as unknown as TicketsPresentation)
        : undefined;
    case "mutation":
      return Object.keys(item).every((key) => [...common, "message", "ref"].includes(key)) &&
        boundedString(item.message, TICKETS_PRESENTATION_MAX_TEXT_BYTES) &&
        (item.ref === undefined || boundedString(item.ref))
        ? (item as unknown as TicketsPresentation)
        : undefined;
    case "summary":
      return onlyKeys(item, [...common, "message", "fields"]) &&
        boundedString(item.message, TICKETS_PRESENTATION_MAX_TEXT_BYTES) &&
        validArray(item.fields, validField)
        ? (item as unknown as TicketsPresentation)
        : undefined;
    case "error":
      return onlyKeys(item, [...common, "code", "message"]) &&
        boundedString(item.code) &&
        boundedString(item.message, TICKETS_PRESENTATION_MAX_TEXT_BYTES)
        ? (item as unknown as TicketsPresentation)
        : undefined;
    default:
      return undefined;
  }
}

function formatBoardRow(item: TicketsBoardRow): string {
  const bits = [
    item.status ? `[${item.status}]` : "",
    item.parent ? `epic:${item.parent.label}` : "",
    item.labels?.length ? item.labels.join(",") : "",
    item.storyPoints ? `${item.storyPoints}pt` : "",
    item.assignee ?? "",
    item.pullRequest?.draft ? "draft" : "",
    item.pullRequest?.merged ? "merged" : "",
    item.pullRequest?.mergeableState ?? "",
    item.pullRequest?.reviewers?.length
      ? `reviews:${item.pullRequest.reviewers.map((r) => `${r.username}${r.state ? `(${r.state})` : ""}`).join(",")}`
      : "",
    item.pullRequest?.requestedReviewers?.length ? `awaiting:${item.pullRequest.requestedReviewers.join(",")}` : "",
  ].filter(Boolean);
  return `${item.ref}: ${item.title}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
}

export function omissionLine(details: TicketsPresentation): string {
  const pieces = [
    details.completeness.omitted > 0 ? `${details.completeness.omitted} row(s) omitted` : "",
    details.omissions.length > 0 ? `omitted: ${details.omissions.join(", ")}` : "",
  ].filter(Boolean);
  return pieces.length > 0 ? `\n[${pieces.join("; ")}]` : "";
}

/** Plain replay-stable text; the TUI renderer applies theme colors afterward. */
export function formatTicketsPresentation(details: TicketsPresentation): string {
  let text: string;
  switch (details.kind) {
    case "list":
      text =
        details.rows.length === 0
          ? `No ${details.title.toLowerCase()}`
          : `${details.title} (${details.completeness.total})\n${details.rows
              .map(
                (item) =>
                  `${item.id}: ${item.label}${item.status ? ` [${item.status}]` : ""}${item.metadata.length ? ` — ${item.metadata.join(", ")}` : ""}`,
              )
              .join("\n")}`;
      break;
    case "board":
      text =
        details.rows.length === 0
          ? `No ${details.title.toLowerCase()}`
          : `${details.title} (${details.completeness.total})\n${details.rows.map((item) => formatBoardRow(item)).join("\n")}`;
      break;
    case "detail":
      text = `${details.title}\n${details.fields.map((entry) => `${entry.label}: ${entry.value}`).join("\n")}`;
      break;
    case "mutation":
      text = details.message;
      break;
    case "summary":
      text = `${details.message}${details.fields.length ? `\n${details.fields.map((entry) => `${entry.label}: ${entry.value}`).join("\n")}` : ""}`;
      break;
    case "error":
      text = `${details.code}: ${details.message}`;
      break;
  }
  return `${text}${omissionLine(details)}`;
}
