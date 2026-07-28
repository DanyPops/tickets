import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { JiraRepository } from "../../src/adapters/jira.js";
import { IssueNotFoundError } from "../../src/adapters/errors.js";
import { discover, load, save } from "../../src/manifest/manifest.js";

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tickets-jira-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  describe("discovery engine", () => {
    it("discoverFields() persists a name->id manifest and makes it resolvable inbound via fieldDisplayName()", async () => {
      await withTempDir(async (dir) => {
        const axiosAdapter = mockAdapter((config) => {
          expect(String(config.url)).toBe("/rest/api/2/field");
          return {
            data: [
              { id: "customfield_10855", name: "Target Version", custom: true, schema: { type: "array", items: "version" } },
              { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
            ],
            status: 200,
          };
        });
        const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter, configDir: dir });
        const mappings = await repo.discoverFields();
        expect(mappings).toEqual({ "Target Version": "customfield_10855" });
        expect(repo.fieldDisplayName("customfield_10855")).toBe("Target Version");

        const persisted = load("fields", "jira", dir);
        expect(persisted.mappings).toEqual({ "Target Version": "customfield_10855" });
      });
    });

    it("a persisted field manifest is loaded at construction -- fieldDisplayName resolves with zero network calls", async () => {
      await withTempDir(async (dir) => {
        // First repository discovers and persists (one live call).
        let fieldCalls = 0;
        const discoverAdapter = mockAdapter(() => {
          fieldCalls++;
          return { data: [{ id: "customfield_10855", name: "Target Version", custom: true, schema: { type: "array" } }], status: 200 };
        });
        const first = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter: discoverAdapter, configDir: dir });
        await first.discoverFields();
        expect(fieldCalls).toBe(1);

        // Second repository, fresh process-equivalent instance, same configDir -- no live call needed.
        const noNetworkAdapter = mockAdapter(() => {
          throw new Error("should not hit the network -- persisted manifest should have been loaded at construction");
        });
        const second = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter: noNetworkAdapter, configDir: dir });
        expect(second.fieldDisplayName("customfield_10855")).toBe("Target Version");
      });
    });

    it("discoverStatuses() seeds a manifest from Jira's category, and immediately reflects it in toDomain() without a restart", async () => {
      await withTempDir(async (dir) => {
        const axiosAdapter = mockAdapter((config) => {
          const url = String(config.url);
          if (url === "/rest/api/2/status") {
            return { data: [{ name: "ON_QA", statusCategory: { key: "indeterminate" } }], status: 200 };
          }
          return { data: { ...RAW_ISSUE("PROJ-1", "x"), fields: { ...RAW_ISSUE("PROJ-1", "x").fields, status: { name: "ON_QA", statusCategory: { key: "indeterminate" } } } }, status: 200 };
        });
        const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter, configDir: dir });
        const before = await repo.get("PROJ-1");
        expect(before.status).toBe("in_progress"); // category-based default, no manifest yet

        await repo.discoverStatuses();
        expect(load("statuses", "jira", dir).mappings.ON_QA).toBe("in_progress");

        const after = await repo.get("PROJ-1");
        expect(after.status).toBe("in_progress"); // same repo instance, in-memory manifest updated in place
      });
    });

    it("a hand-edited manifest entry (e.g. via config.yaml) overrides the category-based default", async () => {
      await withTempDir(async (dir) => {
        // Simulate a human override: ON_QA's real Jira category is "indeterminate"
        // (-> in_progress by default), but this team wants it treated as in_review.
        save("statuses", "jira", dir, discover("jira", { ON_QA: "in_review" }));
        const axiosAdapter = mockAdapter(() => ({
          data: { ...RAW_ISSUE("PROJ-1", "x"), fields: { ...RAW_ISSUE("PROJ-1", "x").fields, status: { name: "ON_QA", statusCategory: { key: "indeterminate" } } } },
          status: 200,
        }));
        const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter, configDir: dir });
        const issue = await repo.get("PROJ-1");
        expect(issue.status).toBe("in_review");
        expect(issue.rawStatus).toBe("ON_QA");
      });
    });

    it("discoverTemplate() samples issues via JQL and extracts sections common to all of them", async () => {
      const axiosAdapter = mockAdapter((config) => {
        expect(String(config.url)).toBe("/rest/api/2/search");
        const body = JSON.parse(String(config.data)) as { jql: string; maxResults: number };
        expect(body.jql).toContain('project = "PROJ"');
        expect(body.jql).toContain('issuetype = "Bug"');
        expect(body.maxResults).toBe(2);
        return {
          data: {
            issues: [
              { ...RAW_ISSUE("PROJ-1", "a"), fields: { ...RAW_ISSUE("PROJ-1", "a").fields, description: "Problem:\n\nImpact:" } },
              { ...RAW_ISSUE("PROJ-2", "b"), fields: { ...RAW_ISSUE("PROJ-2", "b").fields, description: "Problem:\n\nImpact:\n\nExtra:" } },
            ],
          },
          status: 200,
        };
      });
      const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter });
      const template = await repo.discoverTemplate("PROJ", "Bug", 2);
      expect(template).toEqual({ project: "PROJ", issueType: "Bug", sections: ["Problem:", "Impact:"], body: "Problem:\n\nImpact:" });
    });

    it("discoverTemplate() returns undefined when no common sections are found", async () => {
      const axiosAdapter = mockAdapter(() => ({ data: { issues: [RAW_ISSUE("PROJ-1", "a")] } , status: 200 }));
      const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter });
      const template = await repo.discoverTemplate("PROJ", "Bug");
      expect(template).toBeUndefined();
    });

    it("without configDir, discovery still works but persists nothing", async () => {
      const axiosAdapter = mockAdapter(() => ({
        data: [{ id: "customfield_1", name: "Sprint", custom: true, schema: { type: "number" } }],
        status: 200,
      }));
      const repo = new JiraRepository("jira", { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", axiosAdapter });
      const mappings = await repo.discoverFields();
      expect(mappings).toEqual({ Sprint: "customfield_1" });
      expect(repo.fieldDisplayName("customfield_1")).toBe("Sprint");
    });
  });
});
