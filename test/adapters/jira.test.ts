import { describe, expect, it } from "bun:test";
import { JiraRepository } from "../../src/adapters/jira.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

const RAW_ISSUE = (key: string, summary: string) => ({
  id: key,
  key,
  self: `https://acme.atlassian.net/rest/api/2/issue/${key}`,
  fields: {
    summary,
    description: "desc",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    priority: { name: "Major" },
    assignee: { displayName: "Alice" },
    labels: ["bug"],
    project: { key: "PROJ" },
    issuetype: { name: "Bug" },
    created: "2024-01-01T00:00:00.000+0000",
    updated: "2024-01-02T00:00:00.000+0000",
  },
});

describe("JiraRepository", () => {
  it("get() sends Basic auth and hits /rest/api/2/issue/{key}", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe("https://acme.atlassian.net/rest/api/2/issue/PROJ-42");
      const auth = (init?.headers as Record<string, string>).Authorization;
      expect(auth).toStartWith("Basic ");
      return new Response(JSON.stringify(RAW_ISSUE("PROJ-42", "Do the thing")), { status: 200 });
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", fetchImpl });
    const issue = await repo.get("PROJ-42");
    expect(issue.ref).toBe("jira:PROJ-42");
    expect(issue.status).toBe("in_progress");
    expect(issue.priority).toBe("high");
    expect(issue.url).toBe("https://acme.atlassian.net/browse/PROJ-42");
  });

  it("two different explicit keys return two different issues, never the same one twice", async () => {
    const fetchImpl = mockFetch((url) => {
      const key = url.split("/").pop() as string;
      return new Response(JSON.stringify(RAW_ISSUE(key, `Summary for ${key}`)), { status: 200 });
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", fetchImpl });
    const a = await repo.get("PROJ-1");
    const b = await repo.get("PROJ-2");
    expect(a.key).toBe("PROJ-1");
    expect(b.key).toBe("PROJ-2");
    expect(a.title).not.toBe(b.title);
  });

  it("list() posts a JQL search built from the filter", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe("https://acme.atlassian.net/rest/api/2/search");
      const body = JSON.parse(String(init?.body)) as { jql: string };
      expect(body.jql).toContain('project = "PROJ"');
      expect(body.jql).toContain('status = "Done"');
      return new Response(JSON.stringify({ issues: [RAW_ISSUE("PROJ-1", "One")] }), { status: 200 });
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", project: "PROJ", fetchImpl });
    const issues = await repo.list({ status: "done" });
    expect(issues).toHaveLength(1);
  });

  it("update() with a status resolves the matching transition before re-fetching", async () => {
    const calls: string[] = [];
    const fetchImpl = mockFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/transitions") && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/transitions")) {
        return new Response(JSON.stringify({ transitions: [{ id: "31", name: "Done" }] }), { status: 200 });
      }
      return new Response(JSON.stringify(RAW_ISSUE("PROJ-9", "Ship it")), { status: 200 });
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", fetchImpl });
    const issue = await repo.update("PROJ-9", { status: "done" });
    expect(issue.key).toBe("PROJ-9");
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/transitions"))).toBe(true);
  });
});
