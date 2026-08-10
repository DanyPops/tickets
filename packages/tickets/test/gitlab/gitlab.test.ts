import { describe, expect, it } from "bun:test";
import { createRequesterFn, GitbeakerRequestError } from "@gitbeaker/requester-utils";
import { toTicketsVehicleError } from "../../src/agent-tools/error-mapping.js";
import { GitLabRepository, validateUrl } from "../../src/gitlab/gitlab.js";
import { BackendConnectionError, InvalidUrlError, IssueNotFoundError } from "../../src/issue/errors.js";

/**
 * @gitbeaker/rest's sanctioned test-injection point is `requesterFn`, not a raw
 * fetch override (unlike octokit/the old hand-rolled HttpClient): it operates one
 * level up, on already-decoded request/response objects, not HTTP bytes. The
 * `optionsHandler` here is an identity pass-through so gitbeaker's own request-building
 * (query serialization, camelCase->snake_case, projectId URL-encoding) still runs
 * exactly as it would in production — only the actual "make the HTTP call" step is
 * replaced.
 */
type MockBody = Record<string, unknown> | Record<string, unknown>[];

function mockRequesterFn(
  handler: (endpoint: string, options: Record<string, unknown>) => { body: MockBody; status: number; headers: Record<string, string> },
) {
  return createRequesterFn(
    async (_serviceOptions, requestOptions) => requestOptions,
    async (endpoint: string, options?: Record<string, unknown>) => handler(endpoint, options ?? {}),
  );
}

const RAW_ISSUE = (iid: number, title: string) => ({
  id: iid,
  iid,
  title,
  description: "desc",
  state: "opened",
  web_url: `https://gitlab.com/acme/widgets/-/issues/${iid}`,
  author: { id: 1, username: "alice", name: "Alice" },
  assignee: { id: 2, username: "bob", name: "Bob" },
  labels: ["bug"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
});

describe("GitLabRepository", () => {
  it("get() fetches /projects/{id}/issues/{iid} and maps fields", async () => {
    const requesterFn = mockRequesterFn((endpoint) => {
      expect(endpoint).toBe("projects/acme%2Fwidgets/issues/3");
      return { body: RAW_ISSUE(3, "Fix it"), status: 200, headers: {} };
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", token: "t", requesterFn });
    const issue = await repo.get("#3");
    expect(issue.ref).toBe("gitlab:#3");
    expect(issue.assignee).toBe("bob");
  });

  it("two different explicit issue refs return two different issues", async () => {
    const requesterFn = mockRequesterFn((endpoint) => {
      const iid = Number(endpoint.split("/").pop());
      return { body: RAW_ISSUE(iid, `Issue ${iid}`), status: 200, headers: {} };
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", requesterFn });
    const a = await repo.get("#10");
    const b = await repo.get("#20");
    expect(a.key).not.toBe(b.key);
    expect(a.title).not.toBe(b.title);
  });

  it("maps a 404 to a not-found error, not a generic API error", async () => {
    const requesterFn = mockRequesterFn(() => {
      throw new GitbeakerRequestError("not found", {
        cause: {
          description: "not found",
          request: new Request("https://gitlab.com/api/v4/projects/acme%2Fwidgets/issues/999"),
          response: new Response("not found", { status: 404 }),
        },
      });
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", requesterFn });
    await expect(repo.get("#999")).rejects.toThrow(IssueNotFoundError);
  });

  it("list() with no 'me' flags issues a single Issues.all() call with no scope param", async () => {
    let calls = 0;
    const requesterFn = mockRequesterFn((endpoint, options) => {
      calls += 1;
      expect(endpoint).toBe("projects/acme%2Fwidgets/issues");
      expect(String(options.searchParams)).not.toContain("scope=");
      return { body: [RAW_ISSUE(1, "Plain")], status: 200, headers: {} };
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", requesterFn });
    const issues = await repo.list({});
    expect(issues).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("list() with a single 'me' flag issues one Issues.all() call scoped server-side, no username resolution", async () => {
    let calls = 0;
    const requesterFn = mockRequesterFn((_endpoint, options) => {
      calls += 1;
      expect(String(options.searchParams)).toContain("scope=assigned_to_me");
      return { body: [RAW_ISSUE(1, "Mine")], status: 200, headers: {} };
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", requesterFn });
    const issues = await repo.list({ assignedToMe: true });
    expect(issues).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("list() with reportedByMe+assignedToMe issues two Issues.all() calls (one scope each -- GitLab's own scope param takes exactly one value), merging and deduping by ref", async () => {
    const seenScopes: string[] = [];
    const requesterFn = mockRequesterFn((_endpoint, options) => {
      const params = String(options.searchParams);
      if (params.includes("scope=created_by_me")) {
        seenScopes.push("created_by_me");
        return { body: [RAW_ISSUE(1, "Reported"), RAW_ISSUE(2, "Both")], status: 200, headers: {} };
      }
      if (params.includes("scope=assigned_to_me")) {
        seenScopes.push("assigned_to_me");
        return { body: [RAW_ISSUE(2, "Both"), RAW_ISSUE(3, "Assigned")], status: 200, headers: {} };
      }
      throw new Error(`unexpected searchParams ${params}`);
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", requesterFn });
    const issues = await repo.list({ reportedByMe: true, assignedToMe: true });
    expect(seenScopes.sort()).toEqual(["assigned_to_me", "created_by_me"]);
    expect(issues.map((i) => i.key).sort()).toEqual(["#1", "#2", "#3"]);
  });

  it("list() with qaContactIsMe throws -- a Jira-only concept", async () => {
    const repo = new GitLabRepository("gitlab", {
      projectId: "acme/widgets",
      requesterFn: mockRequesterFn(() => ({ body: [], status: 200, headers: {} })),
    });
    await expect(repo.list({ qaContactIsMe: true })).rejects.toThrow(/qaContactIsMe/);
  });

  it("list() with reviewRequestedOfMe throws -- a merge-request-only concept list()'s Issues-only scope can't express", async () => {
    const repo = new GitLabRepository("gitlab", {
      projectId: "acme/widgets",
      requesterFn: mockRequesterFn(() => ({ body: [], status: 200, headers: {} })),
    });
    await expect(repo.list({ reviewRequestedOfMe: true })).rejects.toThrow(/reviewRequestedOfMe/);
  });

  it("update() with an assignee resolves the username to a numeric user id and sends assignee_ids -- GitLab's real write contract", async () => {
    let editBody: string | undefined;
    const requesterFn = mockRequesterFn((endpoint, options) => {
      if (endpoint === "users") {
        return { body: [{ id: 77, username: "carol", name: "Carol" }], status: 200, headers: {} };
      }
      if (options.method === "PUT") {
        editBody = String(options.body);
        return { body: RAW_ISSUE(7, "Fix it"), status: 200, headers: {} };
      }
      return { body: RAW_ISSUE(7, "Fix it"), status: 200, headers: {} };
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", token: "t", requesterFn });
    await repo.update("#7", { assignee: "carol" });
    expect(JSON.parse(editBody ?? "{}")).toEqual({ assignee_ids: [77] });
  });

  it("update() with assignee: '' unassigns (empty assignee_ids), never resolving a user id", async () => {
    let editBody: string | undefined;
    let calledUsers = false;
    const requesterFn = mockRequesterFn((endpoint, options) => {
      if (endpoint === "users") calledUsers = true;
      if (options.method === "PUT") editBody = String(options.body);
      return { body: RAW_ISSUE(7, "Fix it"), status: 200, headers: {} };
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", token: "t", requesterFn });
    await repo.update("#7", { assignee: "" });
    expect(JSON.parse(editBody ?? "{}")).toEqual({ assignee_ids: [] });
    expect(calledUsers).toBe(false);
  });

  it("update() throws a clear error when the given username doesn't resolve to any GitLab user", async () => {
    const requesterFn = mockRequesterFn((endpoint) => {
      if (endpoint === "users") return { body: [], status: 200, headers: {} };
      return { body: RAW_ISSUE(7, "Fix it"), status: 200, headers: {} };
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", token: "t", requesterFn });
    await expect(repo.update("#7", { assignee: "nobody" })).rejects.toThrow(/no user found/);
  });

  it("reports unauthenticated public reads as partial and writes as blocked without exposing configuration values", () => {
    const repo = new GitLabRepository("gitlab", {
      projectId: "acme/widgets",
      requesterFn: mockRequesterFn(() => ({ body: [], status: 200, headers: {} })),
    });
    expect(repo.configurationReadiness()).toEqual({
      backendType: "gitlab",
      connectivity: "not_checked",
      read: {
        state: "partial",
        missingConfiguration: ["GITLAB_TOKEN"],
        recovery: expect.stringContaining("public projects"),
      },
      write: {
        state: "blocked",
        missingConfiguration: ["GITLAB_TOKEN"],
        recovery: expect.stringContaining("GITLAB_TOKEN"),
      },
    });
  });

  it("classifies a reviewed reset cause as a backend connection failure", async () => {
    const requesterFn = mockRequesterFn(() => {
      throw Object.assign(new Error("socket token=must-not-leak"), { code: "ECONNRESET" });
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", requesterFn });
    await expect(repo.get("#7")).rejects.toBeInstanceOf(BackendConnectionError);
  });

  it("keeps unexpected requester defects opaque instead of relabeling them as connectivity", async () => {
    const requesterFn = mockRequesterFn(() => {
      throw new TypeError("programmer token=must-not-leak");
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", requesterFn });
    const thrown = await repo.get("#7").catch((error: unknown) => error);
    expect(thrown).not.toBeInstanceOf(BackendConnectionError);
    const mapped = toTicketsVehicleError(thrown);
    expect(mapped.code).toBe("handler-failed");
    expect(mapped.message).not.toContain("must-not-leak");
  });

  const RAW_MR = (iid: number, title: string) => ({
    id: iid,
    iid,
    title,
    description: "mr desc",
    state: "opened",
    web_url: `https://gitlab.com/acme/widgets/-/merge_requests/${iid}`,
    author: { id: 1, username: "alice", name: "Alice" },
    assignee: { id: 2, username: "bob", name: "Bob" },
    labels: ["feature"],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    source_branch: "feature",
    target_branch: "main",
    sha: "head-sha",
    draft: false,
    merged_at: null as string | null,
    merge_status: "can_be_merged",
    reviewers: [{ id: 3, username: "carol", name: "Carol" }],
    changes_count: "5",
    diff_refs: { base_sha: "base-sha", head_sha: "head-sha" },
  });
  const RAW_REVIEWERS = [{ user: { id: 3, username: "carol", name: "Carol" }, state: "approved" }];

  it("get() on a !-prefixed key fetches the merge request and its reviewers, populating the full PullRequestDetails", async () => {
    const requesterFn = mockRequesterFn((endpoint) => {
      if (endpoint === "projects/acme%2Fwidgets/merge_requests/5") return { body: RAW_MR(5, "Add feature"), status: 200, headers: {} };
      if (endpoint === "projects/acme%2Fwidgets/merge_requests/5/reviewers") return { body: RAW_REVIEWERS, status: 200, headers: {} };
      throw new Error(`unexpected endpoint ${endpoint}`);
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", requesterFn });
    const issue = await repo.get("!5");
    expect(issue.ref).toBe("gitlab:!5");
    expect(issue.key).toBe("!5");
    expect(issue.pullRequest).toEqual({
      baseBranch: "main",
      headBranch: "feature",
      headSha: "head-sha",
      baseSha: "base-sha",
      draft: false,
      merged: false,
      mergedAt: undefined,
      requestedReviewers: ["carol"],
      mergeableState: "mergeable",
      diffStat: { filesChanged: 5 },
      reviewers: [{ username: "carol", state: "approved" }],
    });
  });

  it("get() on a plain #-prefixed key never calls the MergeRequests endpoint", async () => {
    const requesterFn = mockRequesterFn((endpoint) => {
      if (endpoint === "projects/acme%2Fwidgets/issues/7") return { body: RAW_ISSUE(7, "Fix it"), status: 200, headers: {} };
      throw new Error(`unexpected endpoint ${endpoint}`);
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", requesterFn });
    const issue = await repo.get("#7");
    expect(issue.pullRequest).toBeUndefined();
  });

  it("approvePullRequest() posts to the approve endpoint then re-fetches the merge request", async () => {
    let approveCalled = false;
    const requesterFn = mockRequesterFn((endpoint, options) => {
      if (endpoint === "projects/acme%2Fwidgets/merge_requests/5/approve" && options.method === "POST") {
        approveCalled = true;
        return { body: { approved: true }, status: 201, headers: {} };
      }
      if (endpoint === "projects/acme%2Fwidgets/merge_requests/5") return { body: RAW_MR(5, "Add feature"), status: 200, headers: {} };
      if (endpoint === "projects/acme%2Fwidgets/merge_requests/5/reviewers") return { body: RAW_REVIEWERS, status: 200, headers: {} };
      throw new Error(`unexpected endpoint ${endpoint}`);
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", token: "t", requesterFn });
    const issue = await repo.approvePullRequest("!5");
    expect(approveCalled).toBe(true);
    expect(issue.title).toBe("Add feature");
  });

  it("mergePullRequest() PUTs squash: true for method 'squash' and uses the merge response directly (no extra show() call)", async () => {
    let mergeBody: Record<string, unknown> | undefined;
    let showCalled = false;
    const requesterFn = mockRequesterFn((endpoint, options) => {
      if (endpoint === "projects/acme%2Fwidgets/merge_requests/5/merge" && options.method === "PUT") {
        mergeBody = JSON.parse(String(options.body));
        return { body: { ...RAW_MR(5, "Add feature"), state: "merged", merged_at: "2024-01-03T00:00:00Z" }, status: 200, headers: {} };
      }
      if (endpoint === "projects/acme%2Fwidgets/merge_requests/5") {
        showCalled = true;
        return { body: RAW_MR(5, "Add feature"), status: 200, headers: {} };
      }
      if (endpoint === "projects/acme%2Fwidgets/merge_requests/5/reviewers") return { body: RAW_REVIEWERS, status: 200, headers: {} };
      throw new Error(`unexpected endpoint ${endpoint}`);
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", token: "t", requesterFn });
    const issue = await repo.mergePullRequest("!5", "squash");
    expect(mergeBody?.squash).toBe(true);
    expect(showCalled).toBe(false);
    expect(issue.pullRequest?.merged).toBe(true);
  });

  it("does not implement PullRequestChangesRequestable -- GitLab has no REST endpoint for it", async () => {
    const repo = new GitLabRepository("gitlab", {
      projectId: "acme/widgets",
      requesterFn: mockRequesterFn(() => ({ body: [], status: 200, headers: {} })),
    });
    expect((repo as unknown as { requestPullRequestChanges?: unknown }).requestPullRequestChanges).toBeUndefined();
  });

  it("review actions require a token, matching every other write", async () => {
    const repo = new GitLabRepository("gitlab", {
      projectId: "acme/widgets",
      requesterFn: mockRequesterFn(() => ({ body: [], status: 200, headers: {} })),
    });
    await expect(repo.approvePullRequest("!5")).rejects.toThrow(/token|auth/i);
    await expect(repo.mergePullRequest("!5")).rejects.toThrow(/token|auth/i);
  });

  describe("validateUrl (SSRF guard)", () => {
    it("accepts https and localhost http", () => {
      expect(() => validateUrl("https://gitlab.example.com")).not.toThrow();
      expect(() => validateUrl("http://localhost:8080")).not.toThrow();
    });

    it("rejects plain http to a non-localhost host", () => {
      expect(() => validateUrl("http://gitlab.internal.example.com")).toThrow(InvalidUrlError);
    });

    it("rejects private/loopback IP literals", () => {
      expect(() => validateUrl("https://127.0.0.1")).toThrow(InvalidUrlError);
      expect(() => validateUrl("https://10.0.0.5")).toThrow(InvalidUrlError);
      expect(() => validateUrl("https://192.168.1.1")).toThrow(InvalidUrlError);
      expect(() => validateUrl("https://172.16.0.1")).toThrow(InvalidUrlError);
    });

    it("rejects malformed URLs", () => {
      expect(() => validateUrl("not a url")).toThrow(InvalidUrlError);
    });
  });
});
