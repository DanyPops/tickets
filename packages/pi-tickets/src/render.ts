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
 * Renders a Vehicle operation's raw input for a HITL approval prompt as plain `key: value`
 * lines instead of vehicle-client-pi's own default (see its vehicle-pi.ts's requestLocalApproval,
 * which falls back to `JSON.stringify(input, null, 2)` whenever a caller supplies no
 * `approvalPrompt` override) -- every field's exact literal value is still shown in full, just
 * without the braces/quotes/indentation that read as "still JSON" to a human skimming it. This
 * intentionally does NOT reuse presentation.ts's bounded/redacted formatting: that redaction
 * exists to keep secrets and oversized text out of *result* content an LLM/replay will see again,
 * whereas a security approval prompt must show the human the real, complete, untruncated input
 * they're about to authorize -- hiding or truncating a field here would defeat the point of asking.
 */
export function formatApprovalInput(input: unknown): string {
  if (input === null || input === undefined) return "(no input)";
  if (typeof input !== "object" || Array.isArray(input)) return JSON.stringify(input);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "(no input)";
  return entries.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n");
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
