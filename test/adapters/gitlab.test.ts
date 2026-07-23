import { describe, expect, it } from "bun:test";
import { GitLabRepository, validateUrl } from "../../src/adapters/gitlab.js";
import { InvalidUrlError } from "../../src/adapters/errors.js";

function mockFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
}

const RAW_ISSUE = (iid: number, title: string) => ({
  id: iid,
  iid,
  title,
  description: "desc",
  state: "opened",
  web_url: `https://gitlab.com/acme/widgets/-/issues/${iid}`,
  author: { username: "alice", name: "Alice" },
  assignee: { username: "bob", name: "Bob" },
  labels: ["bug"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
});

describe("GitLabRepository", () => {
  it("get() fetches /api/v4/projects/{id}/issues/{iid} and maps fields", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("/api/v4/projects/acme%2Fwidgets/issues/3");
      return new Response(JSON.stringify(RAW_ISSUE(3, "Fix it")), { status: 200 });
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", token: "t", fetchImpl });
    const issue = await repo.get("#3");
    expect(issue.ref).toBe("gitlab:#3");
    expect(issue.assignee).toBe("bob");
  });

  it("two different explicit issue refs return two different issues", async () => {
    const fetchImpl = mockFetch((url) => {
      const iid = Number(url.split("/").pop());
      return new Response(JSON.stringify(RAW_ISSUE(iid, `Issue ${iid}`)), { status: 200 });
    });
    const repo = new GitLabRepository("gitlab", { projectId: "acme/widgets", fetchImpl });
    const a = await repo.get("#10");
    const b = await repo.get("#20");
    expect(a.key).not.toBe(b.key);
    expect(a.title).not.toBe(b.title);
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
