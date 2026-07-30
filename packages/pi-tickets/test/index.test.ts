import { describe, expect, it, mock } from "bun:test";
import type { TicketsRpcClient } from "@danypops/tickets";
import { dispatch } from "../src/index.js";

function fakeClient(handler: (op: string, input: unknown) => unknown): TicketsRpcClient {
  return { call: mock((op: string, input: unknown) => Promise.resolve(handler(op, input))) } as unknown as TicketsRpcClient;
}

describe("pi-tickets dispatch", () => {
  it("get routes to issue.get with the ref", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("issue.get");
      expect(input).toEqual({ ref: "jira:PROJ-42" });
      return { issue: { key: "PROJ-42" } };
    });
    const result = (await dispatch(client, { action: "get", ref: "jira:PROJ-42" })) as { issue: { key: string } };
    expect(result.issue.key).toBe("PROJ-42");
  });

  it("list requires backend", async () => {
    const client = fakeClient(() => ({ issues: [] }));
    await expect(dispatch(client, { action: "list" })).rejects.toThrow(/requires backend/);
  });

  it("list passes a project override through to reach a non-default project (e.g. ENG, OPS)", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("issue.list");
      expect(input).toEqual({ backend: "jira", filter: { project: "ENG", status: undefined, assignee: undefined, labels: undefined, limit: undefined } });
      return { issues: [] };
    });
    await dispatch(client, { action: "list", backend: "jira", project: "ENG" });
  });

  it("search passes a project override through, distinct from the backend's own configured default", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("issue.search");
      expect(input).toEqual({ backend: "jira", query: "PTP", limit: undefined, project: "OPS" });
      return { issues: [] };
    });
    await dispatch(client, { action: "search", backend: "jira", query: "PTP", project: "OPS" });
  });

  it("create builds a CreateInput from flat params", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("issue.create");
      expect(input).toEqual({ backend: "github", input: { title: "New bug", priority: "high", description: undefined, labels: undefined, assignee: undefined, project: undefined } });
      return { issue: { key: "#1" } };
    });
    await dispatch(client, { action: "create", backend: "github", title: "New bug", priority: "high" });
  });

  it("comment_add requires both ref and body", async () => {
    const client = fakeClient(() => ({}));
    await expect(dispatch(client, { action: "comment_add", ref: "github:#1" })).rejects.toThrow(/requires ref and body/);
  });

  it("ledger_search routes to ledger.search", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("ledger.search");
      expect(input).toEqual({ query: "bug", limit: 5 });
      return { issues: [] };
    });
    await dispatch(client, { action: "ledger_search", query: "bug", limit: 5 });
  });

  it("rejects an action outside the known set", async () => {
    const client = fakeClient(() => ({}));
    await expect(dispatch(client, { action: "delete_everything" })).rejects.toThrow(/unknown action/);
  });

  it("focus_set requires ref and routes to focus.set", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("focus.set");
      expect(input).toEqual({ ref: "github:#7" });
      return { focus: { ref: "github:#7", url: "https://github.com/acme/widgets/issues/7" } };
    });
    const result = (await dispatch(client, { action: "focus_set", ref: "github:#7" })) as { focus: { url: string } };
    expect(result.focus.url).toBe("https://github.com/acme/widgets/issues/7");
    await expect(dispatch(client, { action: "focus_set" })).rejects.toThrow(/requires ref/);
  });

  it("focus_get routes to focus.get with no input", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("focus.get");
      expect(input).toEqual({});
      return { focus: null };
    });
    await dispatch(client, { action: "focus_get" });
  });

  it("focus_pause forwards an optional reason", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("focus.pause");
      expect(input).toEqual({ reason: "waiting on review" });
      return { focus: { status: "paused" } };
    });
    await dispatch(client, { action: "focus_pause", reason: "waiting on review" });
  });

  it("focus_unpause and focus_clear route with no input", async () => {
    const client = fakeClient((op) => {
      expect(["focus.unpause", "focus.clear"]).toContain(op);
      return op === "focus.clear" ? { cleared: true } : { focus: { status: "active" } };
    });
    await dispatch(client, { action: "focus_unpause" });
    await dispatch(client, { action: "focus_clear" });
  });

  it("discover_fields requires backend and routes to discover.fields", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("discover.fields");
      expect(input).toEqual({ backend: "jira" });
      return { mappings: { "Target Version": "customfield_10855" } };
    });
    await dispatch(client, { action: "discover_fields", backend: "jira" });
    await expect(dispatch(client, { action: "discover_fields" })).rejects.toThrow(/requires backend/);
  });

  it("discover_statuses requires backend and routes to discover.statuses", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("discover.statuses");
      expect(input).toEqual({ backend: "jira" });
      return { mappings: { ON_QA: "in_review" } };
    });
    await dispatch(client, { action: "discover_statuses", backend: "jira" });
    await expect(dispatch(client, { action: "discover_statuses" })).rejects.toThrow(/requires backend/);
  });

  it("discover_template requires backend, project, and issueType and routes to discover.template", async () => {
    const client = fakeClient((op, input) => {
      expect(op).toBe("discover.template");
      expect(input).toEqual({ backend: "jira", project: "PROJ", issueType: "Bug", sampleSize: 3 });
      return { template: { project: "PROJ", issueType: "Bug", sections: [], body: "" } };
    });
    await dispatch(client, { action: "discover_template", backend: "jira", project: "PROJ", issueType: "Bug", sampleSize: 3 });
    await expect(dispatch(client, { action: "discover_template", backend: "jira" })).rejects.toThrow(/requires backend, project, and issueType/);
  });
});

describe("extension registration", () => {
  it("registers exactly one tool named 'tickets', the /tickets command, contributes to the shared /secrets namespace, and its event handlers", async () => {
    const { __resetSecretsRegistryForTests, listSecretsContributors } = await import("@danypops/vehicle-client-pi/secrets-registry");
    __resetSecretsRegistryForTests();
    const registered: { name: string }[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const fakePi = {
      registerTool: (def: { name: string }) => registered.push(def),
      registerCommand: (name: string) => commands.push(name),
      on: (event: string) => events.push(event),
    };
    const mod = await import("../src/index.js");
    // biome-ignore lint: test-only cast into the ExtensionAPI shape the factory expects
    (mod.default as (pi: unknown) => void)(fakePi);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("tickets");
    // tickets claims the real /secrets registration here since nothing else registered first in this test's isolated registry
    expect(commands).toEqual(["tickets", "secrets"]);
    expect(listSecretsContributors().map((c) => c.source)).toEqual(["tickets"]);
    expect(events).toEqual(expect.arrayContaining(["session_start", "tool_execution_end"]));
  });
});
