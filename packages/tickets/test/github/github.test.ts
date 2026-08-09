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

  it("filters out pull requests from list()", async () => {
    const fetchImpl = mockFetch(() => jsonResponse([RAW_ISSUE(1, "Real issue"), { ...RAW_ISSUE(2, "A PR"), pull_request: {} }]));
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    const issues = await repo.list({});
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toBe("Real issue");
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
