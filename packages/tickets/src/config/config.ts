/**
 * Configuration loading — mirrors the env-var-first, config-file-override pattern:
 * $XDG_CONFIG_HOME/tickets/config.yaml (default ~/.config/tickets/config.yaml),
 * falling back to well-known env vars per backend when no config file is present.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { GitHubRepository } from "../adapters/github.js";
import { GitLabRepository } from "../adapters/gitlab.js";
import { JiraRepository } from "../adapters/jira.js";
import type { IssueRepository } from "../ports/repository.js";
import { isTokenFresh, loadToken } from "../auth/token-store.js";
import { type TryEnigmaCredential, tryEnigmaCredential } from "@danypops/enigma-client";

export interface BackendConfig {
  /** Adapter type: "github" | "gitlab" | "jira". Falls back to the config key when omitted. */
  type?: string;
  token?: string;
  tokenEnv?: string;
  url?: string;
  email?: string;
  owner?: string;
  project?: string;
  repo?: string;
}

export interface Config {
  backends: Record<string, BackendConfig>;
}

const APP_NAME = "tickets";

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, APP_NAME);
}

export function defaultConfigPath(): string {
  return join(configDir(), "config.yaml");
}

export function loadConfig(path?: string): Config {
  const target = path ?? defaultConfigPath();
  if (!existsSync(target)) return { backends: {} };
  const data = readFileSync(target, "utf8");
  const parsed = parseYaml(data) as Partial<Config> | undefined;
  return { backends: parsed?.backends ?? {} };
}

function resolveToken(cfg: BackendConfig, env: NodeJS.ProcessEnv, envFallback: string): string | undefined {
  if (cfg.token) return cfg.token;
  if (cfg.tokenEnv) return env[cfg.tokenEnv];
  return env[envFallback];
}

/**
 * Resolution order, highest priority first: (1) a running Enigma vault, if
 * one happens to be configured for this backend — entirely optional, never a
 * hard dependency, and bounded so Tickets never waits long for it (see
 * @danypops/enigma-client); (2) a locally stored, still-fresh delegated OAuth
 * token (see auth/token-store.ts, populated by `tickets auth login`); (3) a
 * static config/env PAT. (1) is additive to the pre-Enigma precedence this
 * project already followed for GitHub, GitLab, and Jira — see RESEARCH.md
 * for the auth flows each backend actually supports (device flow for
 * GitHub/GitLab, authorization code for Jira, which has no device flow or
 * PKCE).
 */
export async function preferredAuth(
  name: string,
  cfg: BackendConfig,
  env: NodeJS.ProcessEnv,
  envFallback: string,
  tryEnigma: TryEnigmaCredential = tryEnigmaCredential,
): Promise<{ token: string | undefined; oauth: boolean; extra?: Record<string, string> }> {
  const fromEnigma = await tryEnigma(name, { env });
  if (fromEnigma) return { token: fromEnigma.accessToken, oauth: true, extra: fromEnigma.extra };

  const stored = loadToken(name, { env });
  if (stored && isTokenFresh(stored)) {
    return { token: stored.accessToken, oauth: true, extra: stored.extra };
  }
  return { token: resolveToken(cfg, env, envFallback), oauth: false };
}

/**
 * Builds one repository per configured backend, plus any of github/gitlab/jira
 * inferrable purely from environment variables when not present in the config file.
 * Config-file entries take precedence over bare env-var inference for the same name.
 */
export async function buildRepositories(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  tryEnigma: TryEnigmaCredential = tryEnigmaCredential,
): Promise<Record<string, IssueRepository>> {
  const repos: Record<string, IssueRepository> = {};

  for (const [name, cfg] of Object.entries(config.backends)) {
    const type = cfg.type ?? name;
    const repo = await createRepository(name, type, cfg, env, tryEnigma);
    if (repo) repos[name] = repo;
  }

  if (!repos.github && (env.GITHUB_OWNER || env.GITHUB_TOKEN)) {
    const repo = await createRepository("github", "github", {}, env, tryEnigma);
    if (repo) repos.github = repo;
  }
  if (!repos.gitlab && (env.GITLAB_PROJECT || env.GITLAB_TOKEN)) {
    const repo = await createRepository("gitlab", "gitlab", {}, env, tryEnigma);
    if (repo) repos.gitlab = repo;
  }
  if (!repos.jira && env.JIRA_URL) {
    const repo = await createRepository("jira", "jira", {}, env, tryEnigma);
    if (repo) repos.jira = repo;
  }

  return repos;
}

async function createRepository(
  name: string,
  type: string,
  cfg: BackendConfig,
  env: NodeJS.ProcessEnv,
  tryEnigma: TryEnigmaCredential,
): Promise<IssueRepository | undefined> {
  switch (type) {
    case "github": {
      const owner = cfg.owner ?? env.GITHUB_OWNER;
      if (!owner) return undefined;
      const auth = await preferredAuth(name, cfg, env, "GITHUB_TOKEN", tryEnigma);
      return new GitHubRepository(name, {
        owner,
        repo: cfg.repo ?? env.GITHUB_REPO,
        token: auth.token,
        baseUrl: cfg.url,
      });
    }
    case "gitlab": {
      const project = cfg.project ?? env.GITLAB_PROJECT;
      if (!project) return undefined;
      const auth = await preferredAuth(name, cfg, env, "GITLAB_TOKEN", tryEnigma);
      return new GitLabRepository(name, {
        projectId: project,
        token: auth.token,
        tokenType: auth.oauth ? "oauth" : "private",
        baseUrl: cfg.url ?? env.GITLAB_URL,
      });
    }
    case "jira": {
      const auth = await preferredAuth(name, cfg, env, "JIRA_API_TOKEN", tryEnigma);
      if (auth.oauth && auth.token && auth.extra?.cloudId) {
        return new JiraRepository(name, {
          accessToken: auth.token,
          cloudId: auth.extra.cloudId,
          project: cfg.project ?? env.JIRA_PROJECT,
        });
      }
      const baseUrl = cfg.url ?? env.JIRA_URL;
      const email = cfg.email ?? env.JIRA_EMAIL;
      if (!baseUrl || !email || !auth.token) return undefined;
      return new JiraRepository(name, {
        baseUrl,
        email,
        token: auth.token,
        project: cfg.project ?? env.JIRA_PROJECT,
      });
    }
    default:
      return undefined;
  }
}
