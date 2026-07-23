import { describe, expect, it } from "bun:test";
import { GitHubRepository } from "../../src/adapters/github.js";
import { AuthRequiredError } from "../../src/adapters/errors.js";

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
      return new Response(JSON.stringify(RAW_ISSUE(7, "Fix the thing")), { status: 200 });
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
      return new Response(JSON.stringify(RAW_ISSUE(number, `Issue #${number}`)), { status: 200 });
    });
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", token: "t", fetchImpl });
    const a = await repo.get("#1");
    const b = await repo.get("#2");
    expect(a.key).toBe("#1");
    expect(b.key).toBe("#2");
    expect(a.title).not.toBe(b.title);
  });

  it("filters out pull requests from list()", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(
        JSON.stringify([RAW_ISSUE(1, "Real issue"), { ...RAW_ISSUE(2, "A PR"), pull_request: {} }]),
        { status: 200 },
      ),
    );
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    const issues = await repo.list({});
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toBe("Real issue");
  });

  it("refuses to create/update without a token (read-only mode)", async () => {
    const fetchImpl = mockFetch(() => new Response("{}", { status: 200 }));
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    await expect(repo.create({ title: "x" })).rejects.toThrow(AuthRequiredError);
  });

  it("maps a 404 to a not-found error, not a generic API error", async () => {
    const fetchImpl = mockFetch(() => new Response("not found", { status: 404 }));
    const repo = new GitHubRepository("github", { owner: "acme", repo: "widgets", fetchImpl });
    await expect(repo.get("#999")).rejects.toThrow(/not found/);
  });
});
