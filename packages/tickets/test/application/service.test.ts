import { describe, expect, it } from "bun:test";
import { NotSupportedError, TicketService, UnknownBackendError } from "../../src/application/service.js";
import { FakeRepository } from "../support/fake-repository.js";

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
