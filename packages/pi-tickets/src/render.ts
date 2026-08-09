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

interface Comment {
  id: string;
  body: string;
  author?: string;
  createdAt?: string;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
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
      const lines = comments.map((c) => `${theme.fg("accent", c.author ?? "unknown")}: ${truncate(c.body, 120)}`);
      return `${theme.fg("muted", `${comments.length} comment(s)`)}\n${lines.join("\n")}`;
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
  }

  return theme.fg("dim", JSON.stringify(result, null, 2));
}
