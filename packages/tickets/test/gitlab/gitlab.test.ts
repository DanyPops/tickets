import { describe, expect, it } from "bun:test";
import { createRequesterFn, GitbeakerRequestError } from "@gitbeaker/requester-utils";
import { InvalidUrlError, IssueNotFoundError } from "../../src/domain/errors.js";
import { GitLabRepository, validateUrl } from "../../src/gitlab/gitlab.js";

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
