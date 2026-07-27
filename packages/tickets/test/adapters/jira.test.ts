import { describe, expect, it } from "bun:test";
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { JiraRepository } from "../../src/adapters/jira.js";
import { IssueNotFoundError } from "../../src/adapters/errors.js";

/**
 * jira.js's sanctioned test-injection point is axios's own `adapter` config
 * option (jira.js is built on axios, not fetch — unlike octokit/the old
 * hand-rolled HttpClient) — see axios's AxiosRequestConfig.adapter. The handler
 * receives the fully-built axios request config and must return an
 * axios-response-shaped object.
 *
 * Status validation (rejecting for non-2xx) normally lives inside each real
 * axios adapter implementation via its own settle() call, not in axios's
 * generic dispatch wrapper -- a custom adapter that just resolves
 * unconditionally would silently "succeed" on a 404. Confirmed this for real
 * before relying on it, not assumed: a bare custom adapter returning
 * `{status: 404}` resolved instead of rejecting. So this mock replicates that
 * validation explicitly, matching what a real adapter does.
 */
function mockAdapter(
  handler: (config: InternalAxiosRequestConfig) => { data: unknown; status: number },
): AxiosAdapter {
  return (async (config: InternalAxiosRequestConfig) => {
    const { data, status } = handler(config);
    const response = { data, status, statusText: "", headers: {}, config };
    if (status < 200 || status >= 300) {
      throw new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_REQUEST, config, {}, response);
    }
    return response;
  }) as AxiosAdapter;
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
    const axiosAdapter = mockAdapter((config) => {
      expect(config.url).toBe("/rest/api/2/issue/PROJ-42");
      const auth = config.headers?.Authorization as string | undefined;
      expect(auth).toStartWith("Basic ");
      return { data: RAW_ISSUE("PROJ-42", "Do the thing"), status: 200 };
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter });
    const issue = await repo.get("PROJ-42");
    expect(issue.ref).toBe("jira:PROJ-42");
    expect(issue.status).toBe("in_progress");
    expect(issue.priority).toBe("high");
    expect(issue.url).toBe("https://acme.atlassian.net/browse/PROJ-42");
  });

  it("two different explicit keys return two different issues, never the same one twice", async () => {
    const axiosAdapter = mockAdapter((config) => {
      const key = String(config.url).split("/").pop() as string;
      return { data: RAW_ISSUE(key, `Summary for ${key}`), status: 200 };
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter });
    const a = await repo.get("PROJ-1");
    const b = await repo.get("PROJ-2");
    expect(a.key).toBe("PROJ-1");
    expect(b.key).toBe("PROJ-2");
    expect(a.title).not.toBe(b.title);
  });

  it("maps a 404 to a not-found error, not a generic API error", async () => {
    const axiosAdapter = mockAdapter(() => ({ data: { errorMessages: ["Issue does not exist"] }, status: 404 }));
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter });
    await expect(repo.get("PROJ-999")).rejects.toThrow(IssueNotFoundError);
  });

  it("list() posts a JQL search built from the filter", async () => {
    const axiosAdapter = mockAdapter((config) => {
      expect(config.url).toBe("/rest/api/2/search");
      const body = JSON.parse(String(config.data)) as { jql: string };
      expect(body.jql).toContain('project = "PROJ"');
      expect(body.jql).toContain('status = "Done"');
      return { data: { issues: [RAW_ISSUE("PROJ-1", "One")] }, status: 200 };
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", project: "PROJ", axiosAdapter });
    const issues = await repo.list({ status: "done" });
    expect(issues).toHaveLength(1);
  });

  it("update() with a status resolves the matching transition before re-fetching", async () => {
    const calls: string[] = [];
    const axiosAdapter = mockAdapter((config) => {
      const url = String(config.url);
      calls.push(`${config.method?.toUpperCase()} ${url}`);
      if (url.endsWith("/transitions") && config.method?.toLowerCase() === "post") {
        return { data: undefined, status: 204 };
      }
      if (url.endsWith("/transitions")) {
        return { data: { transitions: [{ id: "31", name: "Done" }] }, status: 200 };
      }
      return { data: RAW_ISSUE("PROJ-9", "Ship it"), status: 200 };
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter });
    const issue = await repo.update("PROJ-9", { status: "done" });
    expect(issue.key).toBe("PROJ-9");
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/transitions"))).toBe(true);
  });

  it("update() never touches assignee -- intentionally out of scope for this migration", async () => {
    let sentFields: Record<string, unknown> | undefined;
    const axiosAdapter = mockAdapter((config) => {
      if (config.method?.toLowerCase() === "put") {
        sentFields = (JSON.parse(String(config.data)) as { fields: Record<string, unknown> }).fields;
      }
      return { data: RAW_ISSUE("PROJ-9", "Ship it"), status: 200 };
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter });
    await repo.update("PROJ-9", { title: "New title", assignee: "someone" });
    expect(sentFields).toEqual({ summary: "New title" });
    expect(sentFields?.assignee).toBeUndefined();
  });

  it("create() resolves a custom field display name to its customfield_ID via issueFields.getFields() and writes it", async () => {
    let createdFields: Record<string, unknown> | undefined;
    const axiosAdapter = mockAdapter((config) => {
      const url = String(config.url);
      if (url === "/rest/api/2/field") {
        return {
          data: [
            { id: "customfield_10619", name: "QE Priority", custom: true, schema: { type: "option" } },
            { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
          ],
          status: 200,
        };
      }
      if (config.method?.toLowerCase() === "post" && url === "/rest/api/2/issue") {
        createdFields = (JSON.parse(String(config.data)) as { fields: Record<string, unknown> }).fields;
        return { data: { key: "PROJ-100" }, status: 201 };
      }
      return { data: RAW_ISSUE("PROJ-100", "New ticket"), status: 200 };
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", project: "PROJ", axiosAdapter });
    await repo.create({ title: "New ticket", customFields: { "QE Priority": "P1" } });
    expect(createdFields?.customfield_10619).toEqual({ value: "P1" });
  });

  it("update() throws a clear error for an unknown custom field display name", async () => {
    const axiosAdapter = mockAdapter((config) => {
      if (String(config.url) === "/rest/api/2/field") {
        return { data: [{ id: "customfield_1", name: "Known Field", custom: true, schema: { type: "string" } }], status: 200 };
      }
      return { data: RAW_ISSUE("PROJ-9", "x"), status: 200 };
    });
    const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter });
    await expect(repo.update("PROJ-9", { customFields: { "Nonexistent Field": "x" } })).rejects.toThrow(/unknown custom field/);
  });

  it("OAuth mode (accessToken + cloudId) routes through the api.atlassian.com gateway, no baseUrl needed", async () => {
    const axiosAdapter = mockAdapter((config) => {
      expect(config.baseURL).toContain("api.atlassian.com/ex/jira/");
      const auth = config.headers?.Authorization as string | undefined;
      expect(auth).toBe("Bearer oauth-token");
      return { data: RAW_ISSUE("PROJ-1", "x"), status: 200 };
    });
    const repo = new JiraRepository("jira", { accessToken: "oauth-token", cloudId: "cloud-123", axiosAdapter });
    const issue = await repo.get("PROJ-1");
    expect(issue.key).toBe("PROJ-1");
  });
});
