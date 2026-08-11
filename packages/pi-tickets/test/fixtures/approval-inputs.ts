/**
 * Synthetic Vehicle operation inputs for HITL approval-prompt tests (render.test.ts's
 * formatApprovalInput/titleForApproval coverage, exercised through ./approval-harness.ts).
 *
 * Every title, description, key, label, and username below is fabricated for this test suite --
 * none of it is copied from a real ticket, PR, project, or person. Only the *shape* is realistic:
 * Jira's own "h2. heading" + "* bullet" wiki markup for a multi-paragraph description, a
 * GitHub-style plain-text issue body, and a PR reviewer-state list -- the structural cases
 * formatApprovalInput exists to render well, without needing any real project's real data to
 * prove it.
 */

/** issue.approve/issue.merge/issue.request_changes all share this flat `{ ref, body? }` shape. */
export const SYNTHETIC_APPROVE_INPUT = {
  ref: "github:#101",
  body: "Looks good to me.",
} as const;

/** A nested `filter` object -- the case that used to collapse onto one JSON.stringify'd line. */
export const SYNTHETIC_LIST_FILTER_INPUT = {
  ref: "github:#101",
  filter: { labels: ["bug", "P1"], limit: 5 },
} as const;

/** issue.create against a Jira-shaped backend: multi-line description using Jira's own wiki markup. */
export const SYNTHETIC_JIRA_CREATE_INPUT = {
  backend: "jira",
  input: {
    title: "Add retry/backoff to the widget-sync job",
    description:
      "The widget-sync job currently fails hard on the first transient network error.\n\nh2. Done Criteria\n\n* Retry a transient failure up to 3 times with exponential backoff\n* Log each retry attempt at warn level\n* Verify a forced failure recovers by the second attempt",
    labels: ["backend", "reliability"],
    issueType: "Story",
  },
} as const;

/** issue.create against a GitHub-shaped backend: a plain-text bug report, no wiki markup. */
export const SYNTHETIC_GITHUB_CREATE_INPUT = {
  backend: "github",
  input: {
    title: "Flaky test: widget list pagination",
    description:
      "The pagination test in widget_list_test.go fails intermittently under load.\n\nSteps to reproduce:\n1. Run the suite 20 times in a loop\n2. Observe an occasional off-by-one on the last page",
    labels: ["bug", "flaky-test"],
  },
} as const;

/** issue.approve on a PR: an array of nested reviewer objects, not an array of plain strings. */
export const SYNTHETIC_PR_REVIEWERS_INPUT = {
  ref: "github:#101",
  reviewers: [{ username: "alice", state: "approved" }, { username: "bob" }],
} as const;
