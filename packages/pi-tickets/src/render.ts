/**
 * Human-facing TUI rendering for the `tickets` tool, separate from the LLM-facing
 * JSON in execute()'s content. Before this, every action rendered as a raw
 * JSON dump of the daemon's RPC response -- for comment_add that was actively
 * misleading: a real comment write (confirmed against the live daemon) rendered
 * as `{comment: {id, body: "", ...}}`, indistinguishable from a silent failure.
 *
 * renderResultText is split out from the registerTool call so the per-action
 * branching is unit-testable without a full ExtensionAPI/theme harness.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatTicketsPresentation, parseTicketsPresentation, projectTicketsPresentation } from "./presentation.js";

interface Comment {
  id: string;
  body: string;
  author?: string;
  createdAt?: string;
}

const LEGACY_MAX_ROWS = 20;
const LEGACY_MAX_JSON_CHARACTERS = 8_192;

/**
 * render.ts's own short action names (post legacyActionFor) that map 1:1 onto a
 * presentation.ts operation whose projector already exists -- reused here instead
 * of re-deriving the same rich issue.get detail / issue.list rows / issue.approve
 * mutation line a second time. Every one of these previously fell all the way
 * through to boundedLegacyJson's raw dump for lack of its own switch branch.
 */
const PRESENTATION_OPERATION_FOR: Record<string, string> = {
  get: "issue.get",
  list: "issue.list",
  search: "issue.search",
  children: "issue.children",
  approve: "issue.approve",
  merge: "issue.merge",
  request_changes: "issue.request_changes",
};

/** Formats via presentation.ts's own bounded/redacted projection; undefined only if that projection somehow fails to round-trip its own strict parser. */
function renderViaPresentation(operation: string, output: unknown, theme: Theme): string | undefined {
  const presentation = parseTicketsPresentation(projectTicketsPresentation(operation, output));
  if (!presentation) return undefined;
  return theme.fg(presentation.kind === "error" ? "error" : "toolOutput", formatTicketsPresentation(presentation));
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function boundedLegacyJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2) ?? "Tickets operation completed";
  } catch {
    return "Tickets operation completed (legacy details were malformed)";
  }
  if (serialized.length <= LEGACY_MAX_JSON_CHARACTERS) return serialized;
  return `${serialized.slice(0, LEGACY_MAX_JSON_CHARACTERS - 1)}…\n[legacy details truncated]`;
}

/**
 * Renders a Vehicle operation's raw input for a HITL approval prompt as a plain, indented field
 * tree instead of vehicle-client-pi's own default (see its vehicle-pi.ts's requestLocalApproval,
 * which falls back to `JSON.stringify(input, null, 2)` whenever a caller supplies no
 * `approvalPrompt` override) -- every field's exact literal value is still shown in full, just
 * without the braces/quotes/indentation that read as "still JSON" to a human skimming it. This
 * intentionally does NOT reuse presentation.ts's bounded/redacted formatting: that redaction
 * exists to keep secrets and oversized text out of *result* content an LLM/replay will see again,
 * whereas a security approval prompt must show the human the real, complete, untruncated input
 * they're about to authorize -- hiding or truncating a field here would defeat the point of asking.
 *
 * A flat `key: value` line per top-level field (the first cut of this) was still unreadable for
 * the operations that matter most to actually review before approving: issue.create/issue.update
 * carry a nested `input` object whose own `description`/`body` is real multi-line ticket/PR prose
 * (e.g. Jira's own "h2. heading" + "* bullet" wiki markup, or a plain multi-paragraph GitHub issue
 * body) -- squashed onto one JSON.stringify'd line, exactly the field a human most needs to
 * actually read before authorizing a write. This recurses: a multi-line string gets its own
 * indented block under its field name, a nested object gets its own indented `key: value` lines,
 * and an array of plain values renders as a comma-joined line rather than `["a","b"]`.
 */
const APPROVAL_INDENT_UNIT = "  ";

function isApprovalRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${indent}${line}`))
    .join("\n");
}

function formatApprovalValue(value: unknown, indent: string): string {
  if (value === null || value === undefined) return `${indent}(none)`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}(none)`;
    if (value.every((item) => !isApprovalRecord(item) && !Array.isArray(item))) return `${indent}${value.join(", ")}`;
    return value.map((item) => `${indent}- ${formatApprovalValue(item, `${indent}${APPROVAL_INDENT_UNIT}`).trimStart()}`).join("\n");
  }
  if (isApprovalRecord(value)) return formatApprovalFields(value, indent);
  return `${indent}${value}`;
}

function isFlatArray(value: readonly unknown[]): boolean {
  return value.every((item) => !isApprovalRecord(item) && !Array.isArray(item));
}

function formatApprovalFields(record: Record<string, unknown>, indent: string): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return `${indent}(no input)`;
  return entries
    .map(([key, value]) => {
      if (typeof value === "string" && value.includes("\n")) {
        return `${indent}${key}:\n${indentLines(value, `${indent}${APPROVAL_INDENT_UNIT}`)}`;
      }
      // A flat array (every element a primitive, e.g. labels: ["bug", "P1"]) stays a single
      // comma-joined line next to its own key -- only a record, or an array of records, is
      // structurally nested enough to need its own indented block on the next line.
      if (Array.isArray(value) && (value.length === 0 || isFlatArray(value))) {
        return `${indent}${key}: ${value.length === 0 ? "(none)" : value.join(", ")}`;
      }
      if (isApprovalRecord(value) || Array.isArray(value)) {
        return `${indent}${key}:\n${formatApprovalValue(value, `${indent}${APPROVAL_INDENT_UNIT}`)}`;
      }
      return `${indent}${key}: ${value}`;
    })
    .join("\n");
}

export function formatApprovalInput(input: unknown): string {
  if (!isApprovalRecord(input)) return input === null || input === undefined ? "(no input)" : formatApprovalValue(input, "");
  return formatApprovalFields(input, "");
}

/**
 * A short, human verb phrase per operation for the approval prompt's title, falling back to a
 * Title Cased split of the dot-form operation name for anything not explicitly listed (mirrors
 * vehicle-client-pi's own displayLabel, without importing its unexported helper). Paired with the
 * input's own `ref` (present on every issue.* operation except issue.create/issue.list/issue.search)
 * for a concrete "Approve github:#1?" instead of the generic "Approve tickets approve?" default.
 */
const APPROVAL_VERB_FOR: Record<string, string> = {
  "issue.approve": "Approve",
  "issue.merge": "Merge",
  "issue.request_changes": "Request changes on",
  "issue.create": "Create",
  "issue.update": "Update",
  "issue.comment_add": "Comment on",
};

function approvalVerb(operationName: string): string {
  return (
    APPROVAL_VERB_FOR[operationName] ??
    operationName
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function titleForApproval(operationName: string, input: unknown): string {
  const record = isApprovalRecord(input) ? input : undefined;
  const ref = typeof record?.ref === "string" ? record.ref : undefined;
  const verb = approvalVerb(operationName);
  if (ref) return `${verb} ${ref}?`;
  // issue.create has no ref yet (the backend mints one) -- name the new ticket's own title
  // instead of falling all the way back to a bare, contextless "Create?".
  const nestedInput = isApprovalRecord(record?.input) ? record.input : undefined;
  const newTitle = typeof nestedInput?.title === "string" ? nestedInput.title : undefined;
  if (newTitle) return `${verb} "${truncate(newTitle, 72)}"?`;
  return `${verb}?`;
}

export function renderResultText(action: string, result: unknown, isError: boolean, theme: Theme): string {
  if (isError) {
    const text = typeof result === "string" ? result : (JSON.stringify(result) ?? "Tickets operation failed");
    return theme.fg("error", text);
  }

  switch (action) {
    case "comment_add": {
      const comment = (result as { comment?: Comment } | undefined)?.comment;
      if (!comment) break;
      const who = comment.author ? theme.fg("muted", ` by ${comment.author}`) : "";
      const preview = comment.body
        ? `\n${theme.fg("dim", truncate(comment.body, 200))}`
        : theme.fg("warning", "\n(empty body — comment may not have posted correctly)");
      return `${theme.fg("success", "💬 Comment added")}${who}${preview}`;
    }
    case "comments": {
      const comments =
        (result as { comments?: Comment[] } | undefined)?.comments ?? (Array.isArray(result) ? (result as Comment[]) : undefined);
      if (!comments) break;
      if (comments.length === 0) return theme.fg("muted", "No comments");
      const visible = comments.slice(0, LEGACY_MAX_ROWS);
      const lines = visible.map((c) => `${theme.fg("accent", c.author ?? "unknown")}: ${truncate(c.body, 120)}`);
      const omitted = comments.length - visible.length;
      return `${theme.fg("muted", `${comments.length} comment(s)`)}\n${lines.join("\n")}${omitted > 0 ? `\n[${omitted} comment(s) omitted]` : ""}`;
    }
    case "create": {
      const issue = (result as { ref?: string; title?: string } | undefined) ?? {};
      if (!issue.ref) break;
      return theme.fg("success", `✅ Created ${issue.ref}${issue.title ? `: ${issue.title}` : ""}`);
    }
    case "update": {
      const issue = (result as { ref?: string } | undefined) ?? {};
      if (!issue.ref) break;
      return theme.fg("success", `✅ Updated ${issue.ref}`);
    }
    case "focus_set": {
      const focus = (result as { focus?: { ref?: string } } | undefined)?.focus;
      if (!focus?.ref) break;
      return theme.fg("accent", `🎯 Focused ${focus.ref}`);
    }
    case "focus_clear":
      return theme.fg("muted", "Focus cleared");
    case "get":
    case "list":
    case "search":
    case "children":
    case "approve":
    case "merge":
    case "request_changes": {
      const rendered = renderViaPresentation(PRESENTATION_OPERATION_FOR[action]!, result, theme);
      if (rendered !== undefined) return rendered;
      break;
    }
  }

  return theme.fg("dim", boundedLegacyJson(result));
}
