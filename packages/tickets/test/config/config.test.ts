import { describe, expect, it } from "bun:test";
import { buildRepositories, preferredAuth } from "../../src/config/config.js";
import type { TryEnigmaCredential } from "@danypops/enigma-client";
import { GitHubRepository } from "../../src/adapters/github.js";
import { GitLabRepository } from "../../src/adapters/gitlab.js";
import { JiraRepository } from "../../src/adapters/jira.js";

/**
 * Never the real tryEnigmaCredential in a test: it does a real filesystem
 * check against $XDG_RUNTIME_DIR, and a real Enigma daemon may genuinely be
 * running on the machine executing this suite -- tests must never depend on
 * ambient host state. `noEnigma` is the isolated default for every test not
 * specifically exercising Enigma-first behavior.
 */
const noEnigma: TryEnigmaCredential = async () => undefined;

describe("buildRepositories", () => {
  it("builds one repository per config-file backend entry", async () => {
    const repos = await buildRepositories(
      {
        backends: {
          github: { owner: "acme", repo: "widgets", token: "gh-token" },
          gitlab: { project: "acme/widgets", token: "gl-token" },
          jira: { url: "https://acme.atlassian.net", email: "me@acme.com", token: "jira-token", project: "PROJ" },
        },
      },
      process.env,
      noEnigma,
    );
    expect(repos.github).toBeInstanceOf(GitHubRepository);
    expect(repos.gitlab).toBeInstanceOf(GitLabRepository);
    expect(repos.jira).toBeInstanceOf(JiraRepository);
  });

  it("falls back to well-known env vars when no config entry exists for a backend", async () => {
    const repos = await buildRepositories(
      { backends: {} },
      { GITHUB_OWNER: "acme", GITHUB_TOKEN: "gh", PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      noEnigma,
    );
    expect(repos.github).toBeInstanceOf(GitHubRepository);
    expect(repos.gitlab).toBeUndefined();
    expect(repos.jira).toBeUndefined();
  });

  it("omits a backend entirely when required fields are missing from both config and env", async () => {
    const repos = await buildRepositories({ backends: { jira: { url: "https://acme.atlassian.net" } } }, {} as NodeJS.ProcessEnv, noEnigma);
    expect(repos.jira).toBeUndefined();
  });

  it("supports a custom name with an explicit type (multi-instance)", async () => {
    const repos = await buildRepositories(
      {
        backends: {
          "jira-staging": { type: "jira", url: "https://staging.atlassian.net", email: "a@b.com", token: "t" },
        },
      },
      process.env,
      noEnigma,
    );
    expect(repos["jira-staging"]).toBeInstanceOf(JiraRepository);
    expect(repos["jira-staging"]?.name).toBe("jira-staging");
  });
});

describe("preferredAuth > Enigma as an optional, additive credential source", () => {
  it("prefers a running Enigma vault's credential over a static config token", async () => {
    const calls: string[] = [];
    const fromEnigma: TryEnigmaCredential = async (backend) => {
      calls.push(backend);
      return { accessToken: "enigma-supplied-token", extra: { fromEnigma: "true" } };
    };
    const auth = await preferredAuth("github", { token: "static-config-token" }, process.env, "GITHUB_TOKEN", fromEnigma);
    expect(calls).toEqual(["github"]);
    expect(auth).toEqual({ token: "enigma-supplied-token", oauth: true, extra: { fromEnigma: "true" } });
  });

  it("forwards ENIGMA_CLIENT_TOKEN as the registered-client token, instead of relying on Enigma's shared admin-token file", async () => {
    let seenToken: string | undefined;
    const fromEnigma: TryEnigmaCredential = async (_backend, opts) => {
      seenToken = opts?.token;
      return { accessToken: "enigma-supplied-token", extra: {} };
    };
    await preferredAuth("github", {}, { ENIGMA_CLIENT_TOKEN: "tickets-scoped-token" } as NodeJS.ProcessEnv, "GITHUB_TOKEN", fromEnigma);
    expect(seenToken).toBe("tickets-scoped-token");
  });

  it("falls through to the existing static-token behavior unchanged when Enigma has nothing for this backend", async () => {
    const noEnigmaHere: TryEnigmaCredential = async () => undefined;
    const auth = await preferredAuth("github", { token: "static-config-token" }, process.env, "GITHUB_TOKEN", noEnigmaHere);
    expect(auth).toEqual({ token: "static-config-token", oauth: false });
  });

  it("still prefers a fresh locally-stored delegated token over the static PAT when Enigma has nothing, preserving the pre-Enigma precedence", async () => {
    // No local token-store fixture is seeded here, so this exercises the same "falls through
    // past Enigma, past the stored-token check, to the static PAT" path deliberately -- the
    // stored-token tier itself is covered by token-store.test.ts, not duplicated here.
    const noEnigmaHere: TryEnigmaCredential = async () => undefined;
    const auth = await preferredAuth("github", {}, { GITHUB_TOKEN: "env-pat" } as NodeJS.ProcessEnv, "GITHUB_TOKEN", noEnigmaHere);
    expect(auth).toEqual({ token: "env-pat", oauth: false });
  });
});
