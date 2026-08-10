import { describe, expect, it } from "bun:test";
import {
  createTicketsErrorPresentation,
  formatTicketsPresentation,
  parseTicketsPresentation,
  projectTicketsPresentation,
  TICKETS_PRESENTATION_MAX_BYTES,
  TICKETS_PRESENTATION_MAX_ITEMS,
  TICKETS_PRESENTATION_SCHEMA,
} from "../src/presentation.js";

function roundTrip(operation: string, output: unknown) {
  const projected = projectTicketsPresentation(operation, output);
  const parsed = parseTicketsPresentation(JSON.parse(JSON.stringify(projected)));
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(projected));
  expect(parsed?.schemaVersion).toBe(TICKETS_PRESENTATION_SCHEMA);
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(TICKETS_PRESENTATION_MAX_BYTES);
  return parsed!;
}

describe("tickets.tool-details/v1", () => {
  it("projects and strictly parses every operation-specific presentation form", () => {
    const issue = { ref: "jira:PROJ-1", title: "Bound the persisted view", status: "in_progress", priority: "high", labels: ["ui"] };
    const comment = { id: "c1", body: "full body", author: "Daniel", createdAt: "2026-01-01T00:00:00Z" };
    const focus = { ref: issue.ref, title: issue.title, status: "active", updatedAt: "2026-01-01T00:00:00Z" };
    const query = { name: "ready", backend: "jira", query: "project = PROJ", description: "Ready work" };
    const staged = {
      id: "stage-1",
      payload: { kind: "comment", ref: issue.ref, body: "not persisted" },
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-01T00:30:00Z",
    };

    const outcomes = [
      roundTrip("issue.list", { issues: [issue] }),
      roundTrip("issue.get", { issue }),
      roundTrip("issue.comments", { comments: [comment] }),
      roundTrip("issue.comment_add", { comment }),
      roundTrip("backends.list", {
        backends: [
          {
            name: "github",
            readiness: {
              backendType: "github",
              connectivity: "not_checked",
              read: { state: "ready", missingConfiguration: [] },
              write: { state: "blocked", missingConfiguration: ["GITHUB_TOKEN"] },
            },
          },
        ],
      }),
      roundTrip("ledger.stats", { backends: [{ backend: "jira", count: 12 }] }),
      roundTrip("focus.get", { focus }),
      roundTrip("discover.fields", { mappings: { Priority: "customfield_1" } }),
      roundTrip("discover.template", { template: { project: "PROJ", issueType: "Bug", sections: ["Steps:", "Expected:"], body: "full" } }),
      roundTrip("discover.board_filter", { jql: "project = PROJ" }),
      roundTrip("query.list", { queries: [query] }),
      roundTrip("query.save", { query }),
      roundTrip("stage.list", { items: [staged] }),
      roundTrip("stage.show", { item: staged }),
      roundTrip("stage.drop", { dropped: true }),
      parseTicketsPresentation(createTicketsErrorPresentation("issue.get", "not-found", "Issue was not found"))!,
    ];

    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "list",
      "detail",
      "list",
      "mutation",
      "list",
      "list",
      "detail",
      "list",
      "detail",
      "detail",
      "list",
      "mutation",
      "list",
      "detail",
      "mutation",
      "error",
    ]);
    for (const outcome of outcomes) expect(formatTicketsPresentation(outcome).length).toBeGreaterThan(0);
  });

  it("bounds rows and text while recording completeness and omissions", () => {
    const issues = Array.from({ length: TICKETS_PRESENTATION_MAX_ITEMS + 7 }, (_, index) => ({
      ref: `jira:PROJ-${index}`,
      title: `Issue ${index} ${"x".repeat(2_000)}`,
      status: "todo",
      priority: "medium",
      labels: Array.from({ length: 30 }, (_unused, label) => `label-${label}`),
      description: "description omitted",
    }));
    const details = roundTrip("issue.list", { issues });
    expect(details.kind).toBe("list");
    if (details.kind !== "list") throw new Error("expected list");
    expect(details.rows).toHaveLength(TICKETS_PRESENTATION_MAX_ITEMS);
    expect(details.completeness).toEqual({ total: issues.length, returned: TICKETS_PRESENTATION_MAX_ITEMS, omitted: 7 });
    expect(details.omissions.join(" ")).toContain("descriptions");
  });

  it("never carries raw descriptions, comments, staged payload text, query bodies, capability values, or credential-shaped strings", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const outputs = [
      projectTicketsPresentation("issue.get", {
        issue: {
          ref: "github:#1",
          title: `Investigate token=${secret}`,
          status: "todo",
          priority: "none",
          description: "RAW_DESCRIPTION_ONLY",
          customFields: { Authorization: secret },
        },
      }),
      projectTicketsPresentation("issue.comments", { comments: [{ author: "A", body: `RAW_COMMENT_ONLY ${secret}` }] }),
      projectTicketsPresentation("stage.show", {
        item: { id: "s1", payload: { kind: "comment", ref: "github:#1", body: `RAW_STAGE_ONLY ${secret}` } },
      }),
      projectTicketsPresentation("query.save", {
        query: { name: "q", backend: "jira", query: `RAW_QUERY_ONLY ${secret}` },
      }),
      projectTicketsPresentation("backends.list", {
        backends: [{ name: "github", readiness: { capability: secret, read: {}, write: {} } }],
      }),
    ];
    const serialized = JSON.stringify(outputs);
    for (const sentinel of [secret, "RAW_DESCRIPTION_ONLY", "RAW_COMMENT_ONLY", "RAW_STAGE_ONLY", "RAW_QUERY_ONLY"])
      expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain("[REDACTED]");
  });

  it("query.run always renders as a board -- the same 'Backlog/Sprint' meaning the live interactive panel already gives a saved query", () => {
    const issue = {
      ref: "jira:PROJ-1",
      title: "Wire SSO",
      status: "in_progress",
      parent: { key: "PROJ-100", title: "Epic: Auth" },
      labels: ["auth"],
      customFields: { "Story Points": "5" },
      assignee: "Dana",
    };
    const details = roundTrip("query.run", { issues: [issue] });
    expect(details.kind).toBe("board");
    if (details.kind !== "board") throw new Error("expected board");
    expect(details.variant).toBe("issue");
    expect(details.rows).toEqual([
      {
        ref: "jira:PROJ-1",
        title: "Wire SSO",
        status: "in_progress",
        parent: { key: "PROJ-100", label: "Epic: Auth" },
        labels: ["auth"],
        storyPoints: "5",
        assignee: "Dana",
      },
    ]);
    expect(formatTicketsPresentation(details)).toContain("epic:Epic: Auth");
  });

  it("issue.list/search render as a PR board when every row is a PR/MR -- a real structural distinction (Issue.pullRequest), not a guessed intent", () => {
    const pr = {
      ref: "github:#41",
      title: "feat: SSO",
      status: "in_review",
      assignee: "Dana",
      pullRequest: {
        draft: false,
        mergeableState: "mergeable",
        reviewers: [{ username: "rivka", state: "approved" }],
        requestedReviewers: ["omer"],
      },
    };
    for (const operation of ["issue.list", "issue.search"]) {
      const details = roundTrip(operation, { issues: [pr] });
      expect(details.kind).toBe("board");
      if (details.kind !== "board") throw new Error("expected board");
      expect(details.variant).toBe("pr");
      expect(details.rows[0]?.pullRequest).toEqual({
        draft: false,
        mergeableState: "mergeable",
        reviewers: [{ username: "rivka", state: "approved" }],
        requestedReviewers: ["omer"],
      });
    }
  });

  it("issue.list stays a flat table for a mixed or all-plain batch -- only a homogeneous PR/MR batch becomes a board", () => {
    const plain = { ref: "jira:PROJ-2", title: "Plain issue", status: "todo" };
    const pr = { ref: "github:#41", title: "feat: SSO", status: "in_review", pullRequest: { draft: true } };
    expect(roundTrip("issue.list", { issues: [plain] }).kind).toBe("list");
    expect(roundTrip("issue.list", { issues: [plain, pr] }).kind).toBe("list");
  });

  it("issue.children and ledger.search never become a board, even for an all-PR batch -- only query.run/issue.list/issue.search opt in", () => {
    const pr = { ref: "github:#41", title: "feat: SSO", status: "in_review", pullRequest: { draft: true } };
    expect(roundTrip("issue.children", { issues: [pr] }).kind).toBe("list");
    expect(roundTrip("ledger.search", { issues: [pr] }).kind).toBe("list");
  });

  it("rejects malformed, cyclic, unknown-version, extra-key, and oversized replay details", () => {
    expect(parseTicketsPresentation(null)).toBeUndefined();
    expect(parseTicketsPresentation({ schemaVersion: "tickets.tool-details/v2", kind: "issue" })).toBeUndefined();

    const valid = projectTicketsPresentation("focus.clear", { cleared: true }) as Record<string, unknown>;
    expect(parseTicketsPresentation({ ...valid, unexpected: true })).toBeUndefined();
    expect(parseTicketsPresentation({ ...valid, message: "x".repeat(TICKETS_PRESENTATION_MAX_BYTES) })).toBeUndefined();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(parseTicketsPresentation(cyclic)).toBeUndefined();
  });
});
