import { describe, expect, it } from "bun:test";
import { formatTicketsPresentation, parseTicketsPresentation, projectTicketsPresentation } from "../src/presentation.ts";

/**
 * A real, live incident this guards against: adding `url` to TicketsPresentationRow/
 * TicketsBoardRow without also adding it to parseTicketsPresentation's own round-trip
 * allowlist (validRow/validBoardRow) would silently reject EVERY row once a real url was
 * present -- projectTicketsPresentation (persisted at invocation time) and
 * parseTicketsPresentation (read back before rendering, in vehicle-client.ts's
 * renderTicketsResult) must agree on the exact same row shape, or the whole presentation
 * collapses to undefined and the tool falls back to a bare "operation completed" line.
 */
describe("presentation url round-trip (QoL: surface a clickable issue URL, never drop it)", () => {
  it("issue.search: a plain issue's url survives projectTicketsPresentation -> parseTicketsPresentation and is no longer listed as omitted", () => {
    const output = {
      issues: [
        {
          ref: "jira:CNF-25982",
          title: "GNSS timing reference failure prevents PTP SLAVE state after reboot",
          status: "todo",
          priority: "none",
          assignee: "Shreemanth Patil",
          url: "https://issues.redhat.com/browse/CNF-25982",
        },
      ],
    };

    const projected = projectTicketsPresentation("issue.search", output);
    const parsed = parseTicketsPresentation(projected);
    expect(parsed).toBeDefined();
    expect(parsed?.kind).toBe("list");
    if (parsed?.kind !== "list") throw new Error("expected a list presentation");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.url).toBe("https://issues.redhat.com/browse/CNF-25982");
    // "url" no longer appears in the omitted-fields annotation -- it's surfaced, not dropped.
    expect(parsed.omissions.join(" ")).not.toContain("url");
  });

  it("issue.search: an issue with no url at all still round-trips (url is optional, never required)", () => {
    const output = { issues: [{ ref: "github:#1", title: "No url here", status: "open" }] };
    const parsed = parseTicketsPresentation(projectTicketsPresentation("issue.search", output));
    expect(parsed?.kind).toBe("list");
    if (parsed?.kind !== "list") throw new Error("expected a list presentation");
    expect(parsed.rows[0]?.url).toBeUndefined();
  });

  it("issue.search (PR batch): a pull request's url survives the board round-trip the same way", () => {
    const output = {
      issues: [
        {
          ref: "github:#42",
          title: "Add feature X",
          status: "open",
          url: "https://github.com/example/repo/pull/42",
          pullRequest: { draft: false },
        },
      ],
    };
    const parsed = parseTicketsPresentation(projectTicketsPresentation("issue.search", output));
    expect(parsed?.kind).toBe("board");
    if (parsed?.kind !== "board") throw new Error("expected a board presentation");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.url).toBe("https://github.com/example/repo/pull/42");
  });

  it("query.run: a saved-query board's rows also carry url through the round-trip", () => {
    const output = {
      issues: [{ ref: "gitlab:#7", title: "Board card", status: "in_progress", url: "https://gitlab.example.com/-/issues/7" }],
    };
    const parsed = parseTicketsPresentation(projectTicketsPresentation("query.run", output));
    expect(parsed?.kind).toBe("board");
    if (parsed?.kind !== "board") throw new Error("expected a board presentation");
    expect(parsed.rows[0]?.url).toBe("https://gitlab.example.com/-/issues/7");
  });

  it("formatTicketsPresentation (non-table kinds) never throws on a url-bearing detail projection", () => {
    // issue.get's own detail projection deliberately omits url from its curated field set
    // (issueFields never includes it) -- confirms that omission is unaffected by this change.
    const output = { issue: { ref: "jira:X-1", title: "T", status: "todo", priority: "none", url: "https://example.com/X-1" } };
    const projected = projectTicketsPresentation("issue.get", output);
    const parsed = parseTicketsPresentation(projected);
    expect(parsed).toBeDefined();
    expect(() => formatTicketsPresentation(parsed!)).not.toThrow();
  });
});
