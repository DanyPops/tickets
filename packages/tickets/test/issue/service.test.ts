import { describe, expect, it } from "bun:test";
import type { BackendConfigurationReadiness, IssueRepository } from "../../src/issue/repository.js";
import { NotSupportedError, TicketService, UnknownBackendError } from "../../src/issue/service.js";
import { FakeRepository, ReviewableFakeRepository, ReviewOnlyFakeRepository } from "../support/fake-repository.js";

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

  it("reports each backend's real optional capabilities, not a hardcoded backend name", () => {
    const svc = new TicketService({ github: new BareRepository("github"), jira: new FakeRepository("jira", []) });
    const capabilities = svc.backendCapabilities().sort((a, b) => a.name.localeCompare(b.name));
    const noDiscovery = {
      supportsFieldDiscovery: false,
      supportsStatusDiscovery: false,
      supportsTemplateDiscovery: false,
      supportsBoardQuickFilterDiscovery: false,
      supportsBoardFilterDiscovery: false,
      supportsPullRequestReview: false,
      supportsPullRequestChangesRequest: false,
    };
    const unknownReadiness = (backendType: string): BackendConfigurationReadiness => ({
      backendType,
      connectivity: "not_checked",
      read: { state: "unknown", missingConfiguration: [], recovery: "This adapter does not expose local configuration readiness." },
      write: { state: "unknown", missingConfiguration: [], recovery: "This adapter does not expose local configuration readiness." },
    });
    expect(capabilities).toEqual([
      { name: "github", readiness: unknownReadiness("github"), supportsRawQuery: false, ...noDiscovery },
      { name: "jira", readiness: unknownReadiness("jira"), supportsRawQuery: true, ...noDiscovery },
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

  describe("syncFetch (the poller's own background sync fetch)", () => {
    it("falls back to plain list() when the repo has no SyncScopeExpandable capability at all (GitHub/GitLab)", async () => {
      const github = new FakeRepository("github", [{ ref: "github:#1", id: "1", key: "#1", title: "A", status: "todo", priority: "none" }]);
      // FakeRepository implements buildSyncQuery generically; a repo genuinely
      // lacking the capability (like BareRepository above) exercises the same
      // fallback path via hasSyncScopeExpansion() returning false.
      const bare = new BareRepository("bare");
      const svc = new TicketService({ github, bare });
      await svc.syncFetch("github", 50);
      expect(github.lastListCall).toEqual({ limit: 50 });
      await svc.syncFetch("bare", 50);
    });

    it("falls back to plain list() when buildSyncQuery() returns undefined -- nothing beyond the default scope configured", async () => {
      const jira = new FakeRepository("jira", [
        { ref: "jira:PROJ-1", id: "1", key: "PROJ-1", title: "B", status: "todo", priority: "none" },
      ]);
      const svc = new TicketService({ jira });
      await svc.syncFetch("jira", 50);
      expect(jira.lastListCall).toEqual({ limit: 50 });
      expect(jira.lastRunQueryCall).toBeUndefined();
    });

    it("prefers the expanded sync query via runQuery() over list() when one is configured", async () => {
      const jira = new FakeRepository("jira", [
        { ref: "jira:ENG-1", id: "1", key: "ENG-1", title: "ENG issue", status: "todo", priority: "none" },
      ]);
      // FakeRepository.runQuery treats its query arg as a plain substring title
      // filter, unlike real JQL -- this only proves syncFetch routed through
      // runQuery with the right args, not that a real JQL string matches.
      jira.syncQuery = "ENG";
      const svc = new TicketService({ jira });

      const issues = await svc.syncFetch("jira", 50);

      expect(issues.map((i) => i.title)).toEqual(["ENG issue"]);
      expect(jira.lastRunQueryCall).toEqual({ query: "ENG", limit: 50 });
      expect(jira.lastListCall).toBeUndefined();
    });
  });

  describe("approve/requestChanges/merge", () => {
    it("approve() routes to a PullRequestReviewable repo's approvePullRequest", async () => {
      const github = new ReviewableFakeRepository("github", [
        { ref: "github:#5", id: "5", key: "#5", title: "A PR", status: "todo", priority: "none" },
      ]);
      const svc = new TicketService({ github });
      const issue = await svc.approve("github:#5", "looks good");
      expect(github.lastApproveCall).toEqual({ key: "#5", body: "looks good" });
      expect(issue.pullRequest?.reviewers).toEqual([{ username: "approver", state: "approved" }]);
    });

    it("approve() throws NotSupportedError when the repo lacks PullRequestReviewable", async () => {
      const svc = makeService();
      await expect(svc.approve("jira:PROJ-1")).rejects.toThrow(NotSupportedError);
    });

    it("merge() routes to a PullRequestReviewable repo's mergePullRequest", async () => {
      const github = new ReviewableFakeRepository("github", [
        { ref: "github:#5", id: "5", key: "#5", title: "A PR", status: "todo", priority: "none" },
      ]);
      const svc = new TicketService({ github });
      const issue = await svc.merge("github:#5", "squash");
      expect(github.lastMergeCall).toEqual({ key: "#5", method: "squash" });
      expect(issue.pullRequest?.merged).toBe(true);
    });

    it("merge() throws NotSupportedError when the repo lacks PullRequestReviewable", async () => {
      const svc = makeService();
      await expect(svc.merge("jira:PROJ-1")).rejects.toThrow(NotSupportedError);
    });

    it("requestChanges() routes to a PullRequestChangesRequestable repo (GitHub-shaped)", async () => {
      const github = new ReviewableFakeRepository("github", [
        { ref: "github:#5", id: "5", key: "#5", title: "A PR", status: "todo", priority: "none" },
      ]);
      const svc = new TicketService({ github });
      const issue = await svc.requestChanges("github:#5", "please fix the tests");
      expect(github.lastRequestChangesCall).toEqual({ key: "#5", body: "please fix the tests" });
      expect(issue.pullRequest?.reviewers).toEqual([{ username: "reviewer", state: "changes_requested" }]);
    });

    it("requestChanges() throws NotSupportedError against a PullRequestReviewable-only repo (GitLab-shaped) -- the real cross-backend asymmetry", async () => {
      const gitlab = new ReviewOnlyFakeRepository("gitlab", [
        { ref: "gitlab:!5", id: "5", key: "!5", title: "An MR", status: "todo", priority: "none" },
      ]);
      const svc = new TicketService({ gitlab });
      // gitlab does support approve/merge...
      await expect(svc.approve("gitlab:!5")).resolves.toBeDefined();
      // ...but never requestChanges, per gitlab.ts's own documented REST API gap.
      await expect(svc.requestChanges("gitlab:!5", "body")).rejects.toThrow(NotSupportedError);
    });
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
