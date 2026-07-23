import { describe, expect, it } from "bun:test";
import { buildRepositories } from "../../src/config/config.js";
import { GitHubRepository } from "../../src/adapters/github.js";
import { GitLabRepository } from "../../src/adapters/gitlab.js";
import { JiraRepository } from "../../src/adapters/jira.js";

describe("buildRepositories", () => {
  it("builds one repository per config-file backend entry", () => {
    const repos = buildRepositories({
      backends: {
        github: { owner: "acme", repo: "widgets", token: "gh-token" },
        gitlab: { project: "acme/widgets", token: "gl-token" },
        jira: { url: "https://acme.atlassian.net", email: "me@acme.com", token: "jira-token", project: "PROJ" },
      },
    });
    expect(repos.github).toBeInstanceOf(GitHubRepository);
    expect(repos.gitlab).toBeInstanceOf(GitLabRepository);
    expect(repos.jira).toBeInstanceOf(JiraRepository);
  });

  it("falls back to well-known env vars when no config entry exists for a backend", () => {
    const repos = buildRepositories(
      { backends: {} },
      { GITHUB_OWNER: "acme", GITHUB_TOKEN: "gh", PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    );
    expect(repos.github).toBeInstanceOf(GitHubRepository);
    expect(repos.gitlab).toBeUndefined();
    expect(repos.jira).toBeUndefined();
  });

  it("omits a backend entirely when required fields are missing from both config and env", () => {
    const repos = buildRepositories({ backends: { jira: { url: "https://acme.atlassian.net" } } }, {} as NodeJS.ProcessEnv);
    expect(repos.jira).toBeUndefined();
  });

  it("supports a custom name with an explicit type (multi-instance)", () => {
    const repos = buildRepositories({
      backends: {
        "jira-staging": { type: "jira", url: "https://staging.atlassian.net", email: "a@b.com", token: "t" },
      },
    });
    expect(repos["jira-staging"]).toBeInstanceOf(JiraRepository);
    expect(repos["jira-staging"]?.name).toBe("jira-staging");
  });
});
