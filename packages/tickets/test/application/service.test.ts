import { describe, expect, it } from "bun:test";
import { NotSupportedError, TicketService, UnknownBackendError } from "../../src/application/service.js";
import type { IssueRepository } from "../../src/ports/repository.js";
import { FakeRepository } from "../support/fake-repository.js";

/** A minimal IssueRepository with none of the optional capabilities -- proves backendCapabilities() reflects what a repo actually implements, not a hardcoded backend name. */
class BareRepository implements IssueRepository {
  constructor(readonly name: string) {}
  async list() {
    return [];
  }
  async get(key: string): Promise<never> {
    throw new Error(`not found: ${key}`);
  }
  async create(): Promise<never> {
    throw new Error("not implemented");
  }
  async update(): Promise<never> {
    throw new Error("not implemented");
  }
  async search() {
    return [];
  }
  async listChildren() {
    return [];
  }
}

function makeService() {
  const github = new FakeRepository("github", [
    { ref: "github:#1", id: "1", key: "#1", title: "First issue", status: "todo", priority: "none" },
    { ref: "github:#2", id: "2", key: "#2", title: "Second issue", status: "done", priority: "high" },
  ]);
  const jira = new FakeRepository("jira", [
    { ref: "jira:PROJ-1", id: "1", key: "PROJ-1", title: "Jira one", status: "in_progress", priority: "urgent" },
  ]);
  return new TicketService({ github, jira });
}

describe("TicketService", () => {
  it("lists backends", () => {
    expect(makeService().backends().sort()).toEqual(["github", "jira"]);
  });

  it("reports each backend's real runQuery capability, not a hardcoded backend name", () => {
    const svc = new TicketService({ github: new BareRepository("github"), jira: new FakeRepository("jira", []) });
    const capabilities = svc.backendCapabilities().sort((a, b) => a.name.localeCompare(b.name));
    expect(capabilities).toEqual([
      { name: "github", supportsRawQuery: false },
      { name: "jira", supportsRawQuery: true },
    ]);
  });

  it("routes get() by parsing the ref's backend prefix", async () => {
    const svc = makeService();
    const issue = await svc.get("jira:PROJ-1");
    expect(issue.title).toBe("Jira one");
  });

  it("returns two DIFFERENT issues for two different explicit refs — never the same one twice", async () => {
    const svc = makeService();
    const a = await svc.get("github:#1");
    const b = await svc.get("github:#2");
    expect(a.key).toBe("#1");
    expect(b.key).toBe("#2");
    expect(a.title).not.toBe(b.title);
    expect(a).not.toEqual(b);
  });

  it("throws UnknownBackendError for an unconfigured backend", async () => {
    const svc = makeService();
    await expect(svc.list("nonexistent", {})).rejects.toThrow(UnknownBackendError);
  });

  it("search() forwards an explicit project override to the repository, distinct from its own configured default", async () => {
    const jira = new FakeRepository("jira", []);
    const svc = new TicketService({ jira });
    await svc.search("jira", "PTP", 10, "OPS");
    expect(jira.lastSearchCall).toEqual({ query: "PTP", limit: 10, project: "OPS" });
  });

  it("create() and update() route to the named backend", async () => {
    const svc = makeService();
    const created = await svc.create("github", { title: "New one" });
    expect(created.ref).toStartWith("github:");
    const updated = await svc.update(created.ref, { status: "done" });
    expect(updated.status).toBe("done");
  });

  it("comments() throws NotSupportedError when the repo lacks CommentCapable", async () => {
    const bareRepo = {
      name: "bare",
      list: async () => [],
      get: async () => {
        throw new Error("n/a");
      },
      create: async () => {
        throw new Error("n/a");
      },
      update: async () => {
        throw new Error("n/a");
      },
      search: async () => [],
      listChildren: async () => [],
    };
    const svc = new TicketService({ bare: bareRepo });
    await expect(svc.comments("bare:1")).rejects.toThrow(NotSupportedError);
  });

  it("runQuery() throws NotSupportedError when the repo lacks RawQueryable", async () => {
    const bareRepo = {
      name: "bare",
      list: async () => [],
      get: async () => {
        throw new Error("n/a");
      },
      create: async () => {
        throw new Error("n/a");
      },
      update: async () => {
        throw new Error("n/a");
      },
      search: async () => [],
      listChildren: async () => [],
    };
    const svc = new TicketService({ bare: bareRepo });
    await expect(svc.runQuery("bare", "project = X")).rejects.toThrow(NotSupportedError);
  });

  it("runQuery() forwards the raw query and limit to a RawQueryable repo", async () => {
    const jira = new FakeRepository("jira", [
      { ref: "jira:PROJ-1", id: "1", key: "PROJ-1", title: "Sprint issue", status: "todo", priority: "none" },
    ]);
    const svc = new TicketService({ jira });
    const issues = await svc.runQuery("jira", "Sprint", 5);
    expect(issues.map((i) => i.title)).toEqual(["Sprint issue"]);
    expect(jira.lastRunQueryCall).toEqual({ query: "Sprint", limit: 5 });
  });

  describe("setRepos", () => {
    it("swaps in a newly available backend without reconstructing the service", async () => {
      const github = new FakeRepository("github", [
        { ref: "github:#1", id: "1", key: "#1", title: "First issue", status: "todo", priority: "none" },
      ]);
      const svc = new TicketService({ github });
      await expect(svc.list("gitlab", {})).rejects.toThrow(UnknownBackendError);

      const gitlab = new FakeRepository("gitlab", [
        { ref: "gitlab:1", id: "1", key: "1", title: "GitLab issue", status: "todo", priority: "none" },
      ]);
      svc.setRepos({ github, gitlab });
      const issue = await svc.get("gitlab:1");
      expect(issue.title).toBe("GitLab issue");
    });

    it("drops a backend that's no longer configured", async () => {
      const svc = makeService();
      expect(svc.backends().sort()).toEqual(["github", "jira"]);

      const jira = new FakeRepository("jira", [
        { ref: "jira:PROJ-1", id: "1", key: "PROJ-1", title: "Jira one", status: "in_progress", priority: "urgent" },
      ]);
      svc.setRepos({ jira });

      expect(svc.backends()).toEqual(["jira"]);
      await expect(svc.list("github", {})).rejects.toThrow(UnknownBackendError);
    });
  });
});
