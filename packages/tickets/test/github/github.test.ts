import { describe, expect, it } from "bun:test";
import { toTicketsVehicleError } from "../../src/agent-tools/error-mapping.js";
import { GitHubRepository } from "../../src/github/github.js";
import { AuthRequiredError, BackendConnectionError } from "../../src/issue/errors.js";

// octokit inspects the response's content-type header to decide whether to JSON-parse the
// body (unlike the old hand-rolled HttpClient, which parsed blindly) -- real GitHub API
// responses always send this, so the mock must too, or `.data` comes back as a raw string.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

const RAW_ISSUE = (number: number, title: string) => ({
  number,
  title,
  body: "desc",
  state: "open",
  html_url: `https://github.com/acme/widgets/issues/${number}`,
  user: { login: "alice" },
  assignee: { login: "bob" },
  labels: [{ id: 1, name: "bug" }],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
});

describe("GitHubRepository", () => {
  it("get() fetches /repos/{owner}/{repo}/issues/{number} and maps fields", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/7");
      return jsonResponse(RAW_ISSUE(7, "Fix the thing"));
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", token: "t", fetchImpl });
    const issue = await repo.get("#7");
    expect(issue.ref).toBe("github:#7");
    expect(issue.title).toBe("Fix the thing");
    expect(issue.assignee).toBe("bob");
    expect(issue.labels).toEqual(["bug"]);
  });

  it("two different explicit issue numbers return two different issues", async () => {
    const fetchImpl = mockFetch((url) => {
      const number = Number(url.split("/").pop());
      return jsonResponse(RAW_ISSUE(number, `Issue #${number}`));
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", token: "t", fetchImpl });
    const a = await repo.get("#1");
    const b = await repo.get("#2");
    expect(a.key).toBe("#1");
    expect(b.key).toBe("#2");
    expect(a.title).not.toBe(b.title);
  });

  it("includes pull requests in list(), populating only what the Issues API's own schema actually carries (draft/merged) -- no extra call", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return jsonResponse([RAW_ISSUE(1, "Real issue"), { ...RAW_ISSUE(2, "A PR"), draft: true, pull_request: { merged_at: null } }]);
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    const issues = await repo.list({});
    expect(issues).toHaveLength(2);
    expect(issues[0]?.pullRequest).toBeUndefined();
    expect(issues[1]?.pullRequest).toEqual({ draft: true, merged: false, mergedAt: undefined });
    expect(calls).toBe(1);
  });

  it("list() with no 'me' flags uses listForRepo, not the Search API", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("/repos/acme/widgets/issues");
      expect(url).not.toContain("/search/");
      return jsonResponse([RAW_ISSUE(1, "Plain issue")]);
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    const issues = await repo.list({});
    expect(issues).toHaveLength(1);
  });

  it("list() with reportedByMe+reviewRequestedOfMe routes through the Search API, OR-ing the two qualifiers together with @me (no whoami call, no literal username)", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("/search/issues?");
      const q = new URL(url).searchParams.get("q") ?? "";
      expect(q).toBe("repo:acme/widgets (author:@me OR user-review-requested:@me)");
      return jsonResponse({ total_count: 1, incomplete_results: false, items: [RAW_ISSUE(3, "Mine")] });
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    const issues = await repo.list({ reportedByMe: true, reviewRequestedOfMe: true });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toBe("Mine");
  });

  it("list() with a single 'me' flag emits a bare qualifier, no OR grouping needed, and still includes status/labels", async () => {
    const fetchImpl = mockFetch((url) => {
      const q = new URL(url).searchParams.get("q") ?? "";
      expect(q).toBe('repo:acme/widgets is:open label:"bug" assignee:@me');
      return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    await repo.list({ assignedToMe: true, status: "todo", labels: ["bug"] });
  });

  it("list() with qaContactIsMe throws -- a Jira-only concept", async () => {
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl: mockFetch(() => jsonResponse([])) });
    await expect(repo.list({ qaContactIsMe: true })).rejects.toThrow(/qaContactIsMe/);
  });

  it("get() on a pull request makes one additional pulls.get() call and one pulls.listReviews() call for the full shape", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith("/issues/9")) return jsonResponse({ ...RAW_ISSUE(9, "A PR"), pull_request: { merged_at: null } });
      if (url.endsWith("/pulls/9/reviews")) return jsonResponse([{ user: { login: "carol" }, state: "APPROVED" }]);
      if (url.endsWith("/pulls/9")) {
        return jsonResponse({
          base: { ref: "main", sha: "base-sha" },
          head: { ref: "feature", sha: "head-sha" },
          draft: false,
          merged: false,
          merged_at: null,
          mergeable: true,
          mergeable_state: "clean",
          additions: 10,
          deletions: 2,
          changed_files: 3,
          requested_reviewers: [{ login: "dave" }],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    const issue = await repo.get("#9");
    expect(issue.pullRequest).toEqual({
      baseBranch: "main",
      headBranch: "feature",
      baseSha: "base-sha",
      headSha: "head-sha",
      draft: false,
      merged: false,
      mergedAt: undefined,
      requestedReviewers: ["dave"],
      mergeableState: "mergeable",
      diffStat: { filesChanged: 3, additions: 10, deletions: 2 },
      reviewers: [{ username: "carol", state: "approved" }],
    });
  });

  it("get() on a plain issue never calls the Pulls API", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith("/issues/7")) return jsonResponse(RAW_ISSUE(7, "Fix the thing"));
      throw new Error(`unexpected url ${url}`);
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    const issue = await repo.get("#7");
    expect(issue.pullRequest).toBeUndefined();
  });

  // get() on a PR always enriches via pulls.get()/pulls.listReviews() (see the dedicated test
  // above) -- every review-action test below re-fetches through the same path, so both must be
  // mocked too, not just the action's own endpoint.
  const PULL_FULL = {
    base: { ref: "main", sha: "base-sha" },
    head: { ref: "feature", sha: "head-sha" },
    draft: false,
    merged: false,
    merged_at: null as string | null,
    mergeable: true,
    mergeable_state: "clean",
    additions: 1,
    deletions: 1,
    changed_files: 1,
  };

  it("approvePullRequest() posts event: APPROVE then re-fetches the issue", async () => {
    let reviewBody: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith("/pulls/9/reviews") && init?.method === "POST") {
        reviewBody = JSON.parse(String(init.body));
        return jsonResponse({});
      }
      if (url.endsWith("/pulls/9/reviews")) return jsonResponse([]);
      if (url.endsWith("/pulls/9")) return jsonResponse(PULL_FULL);
      if (url.endsWith("/issues/9")) return jsonResponse({ ...RAW_ISSUE(9, "A PR"), pull_request: { merged_at: null } });
      throw new Error(`unexpected url ${url}`);
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", token: "t", fetchImpl });
    const issue = await repo.approvePullRequest("#9");
    expect(reviewBody?.event).toBe("APPROVE");
    expect(issue.title).toBe("A PR");
  });

  it("requestPullRequestChanges() posts event: REQUEST_CHANGES with the required body", async () => {
    let reviewBody: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith("/pulls/9/reviews") && init?.method === "POST") {
        reviewBody = JSON.parse(String(init.body));
        return jsonResponse({});
      }
      if (url.endsWith("/pulls/9/reviews")) return jsonResponse([]);
      if (url.endsWith("/pulls/9")) return jsonResponse(PULL_FULL);
      if (url.endsWith("/issues/9")) return jsonResponse({ ...RAW_ISSUE(9, "A PR"), pull_request: { merged_at: null } });
      throw new Error(`unexpected url ${url}`);
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", token: "t", fetchImpl });
    await repo.requestPullRequestChanges("#9", "please fix the tests");
    expect(reviewBody?.event).toBe("REQUEST_CHANGES");
    expect(reviewBody?.body).toBe("please fix the tests");
  });

  it("mergePullRequest() puts merge_method then re-fetches the issue", async () => {
    let mergeBody: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith("/pulls/9/merge") && init?.method === "PUT") {
        mergeBody = JSON.parse(String(init.body));
        return jsonResponse({ sha: "abc", merged: true, message: "Merged" });
      }
      if (url.endsWith("/pulls/9/reviews")) return jsonResponse([]);
      if (url.endsWith("/pulls/9")) return jsonResponse({ ...PULL_FULL, merged: true, merged_at: "2024-01-03T00:00:00Z" });
      if (url.endsWith("/issues/9")) return jsonResponse({ ...RAW_ISSUE(9, "A PR"), pull_request: { merged_at: "2024-01-03T00:00:00Z" } });
      throw new Error(`unexpected url ${url}`);
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", token: "t", fetchImpl });
    const issue = await repo.mergePullRequest("#9", "squash");
    expect(mergeBody?.merge_method).toBe("squash");
    expect(issue.pullRequest?.merged).toBe(true);
  });

  it("review actions require a token, matching every other write", async () => {
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl: mockFetch(() => jsonResponse({})) });
    await expect(repo.approvePullRequest("#9")).rejects.toThrow(AuthRequiredError);
    await expect(repo.requestPullRequestChanges("#9", "x")).rejects.toThrow(AuthRequiredError);
    await expect(repo.mergePullRequest("#9")).rejects.toThrow(AuthRequiredError);
  });

  it("refuses to create/update without a token (read-only mode)", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({}));
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    await expect(repo.create({ title: "x" })).rejects.toThrow(AuthRequiredError);
  });

  it("maps a 404 to a not-found error, not a generic API error", async () => {
    const fetchImpl = mockFetch(() => new Response("not found", { status: 404 }));
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    await expect(repo.get("#999")).rejects.toThrow(/not found/);
  });

  it("update() with an assignee sends assignees: [login] -- GitHub's real write contract, confirmed via octokit's generated types", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      if (init?.method === "PATCH") {
        sentBody = JSON.parse(String(init.body));
        return jsonResponse(RAW_ISSUE(7, "Fix the thing"));
      }
      return jsonResponse(RAW_ISSUE(7, "Fix the thing"));
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", token: "t", fetchImpl });
    await repo.update("#7", { assignee: "carol" });
    expect(sentBody?.assignees).toEqual(["carol"]);
  });

  it("update() with assignee: '' unassigns (empty assignees array), not a no-op", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      if (init?.method === "PATCH") {
        sentBody = JSON.parse(String(init.body));
      }
      return jsonResponse(RAW_ISSUE(7, "Fix the thing"));
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", token: "t", fetchImpl });
    await repo.update("#7", { assignee: "" });
    expect(sentBody?.assignees).toEqual([]);
  });

  it("reports repository-scoped reads as partial and writes as blocked without repo/token, without probing GitHub", () => {
    const repo = new GitHubRepository("github", { owner: "acme", fetchImpl: mockFetch(() => jsonResponse([])) });
    expect(repo.configurationReadiness()).toEqual({
      backendType: "github",
      connectivity: "not_checked",
      read: {
        state: "partial",
        missingConfiguration: ["GITHUB_REPO"],
        recovery: expect.stringContaining("organization search remains available"),
      },
      write: {
        state: "blocked",
        missingConfiguration: ["GITHUB_REPO", "GITHUB_TOKEN"],
        recovery: expect.stringContaining("GITHUB_TOKEN"),
      },
    });
  });

  it("classifies a reviewed DNS cause as a retryable backend connection failure", async () => {
    const networkError = Object.assign(new Error("getaddrinfo token=must-not-leak"), { code: "ENOTFOUND" });
    const repo = new GitHubRepository("github", {
      owner: "acme",
      repo: "widgets",
      fetchImpl: mockFetch(() => {
        throw networkError;
      }),
    });
    await expect(repo.get("#7")).rejects.toBeInstanceOf(BackendConnectionError);
  });

  it("does not relabel an unexpected fetch implementation defect as connectivity or expose its message", async () => {
    const repo = new GitHubRepository("github", {
      owner: "acme",
      repo: "widgets",
      fetchImpl: mockFetch(() => {
        throw new TypeError("programmer token=must-not-leak");
      }),
    });
    const thrown = await repo.get("#7").catch((error: unknown) => error);
    expect(thrown).not.toBeInstanceOf(BackendConnectionError);
    const mapped = toTicketsVehicleError(thrown);
    expect(mapped.code).toBe("handler-failed");
    expect(mapped.message).not.toContain("must-not-leak");
  });
});
