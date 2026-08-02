/**
 * Configuration loading — mirrors the env-var-first, config-file-override pattern:
 * $XDG_CONFIG_HOME/tickets/config.yaml (default ~/.config/tickets/config.yaml),
 * falling back to well-known env vars per backend when no config file is present.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type TryEnigmaCredential, tryEnigmaCredential } from "@danypops/enigma-client";
import type { MaintenanceTask } from "@danypops/vehicle-server/daemon";
import type { Logger } from "@danypops/vehicle-server/logging";
import { parse as parseYaml } from "yaml";
import type { TicketService } from "../application/service.js";
import { isTokenFresh, loadToken } from "../auth/token-store.js";
import type { IssueRepository } from "../domain/repository.js";
import { GitHubRepository } from "../github/github.js";
import { GitLabRepository } from "../gitlab/gitlab.js";
import { JiraRepository } from "../jira/jira.js";

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
  /** Jira only: additional project keys the background poller also pools into the ledger, beyond the single default `project` above. */
  syncProjects?: string[];
  /** Jira only: when true, the background poller also pools everything assigned to the authenticated user, regardless of project. */
  syncMine?: boolean;
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

/** Config wins over the env var; the env var is a comma-separated list (JIRA_SYNC_PROJECTS=ENG,OPS). */
function resolveSyncProjects(cfg: BackendConfig, env: NodeJS.ProcessEnv): string[] | undefined {
  if (cfg.syncProjects) return cfg.syncProjects;
  const raw = env.JIRA_SYNC_PROJECTS;
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function resolveSyncMine(cfg: BackendConfig, env: NodeJS.ProcessEnv): boolean {
  if (cfg.syncMine !== undefined) return cfg.syncMine;
  return /^(1|true|yes)$/i.test(env.JIRA_SYNC_MINE ?? "");
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
  // ENIGMA_CLIENT_TOKEN is this daemon's own registered-client token (`enigma client add`) --
  // Enigma's shared admin-token file is deliberately unreadable outside its own service
  // account, so tickets must present its own scoped token to get anything back at all.
  const fromEnigma = await tryEnigma(name, { env, token: env.ENIGMA_CLIENT_TOKEN });
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

export type BuildRepositories = typeof buildRepositories;

/**
 * Re-runs buildRepositories on a schedule and swaps the result into a live
 * TicketService via setRepos -- the counterpart to token-provider.ts's
 * per-request freshness in Pipes, one level up: this refreshes which
 * backends exist at all, not just an existing backend's token. A backend
 * enigma login just made available becomes callable without a daemon
 * restart; a removed one stops being offered. A failed refresh (Enigma
 * unreachable, transient) keeps the previous backend set rather than
 * wiping it out.
 */
export function createBackendRefreshTask(
  service: TicketService,
  config: Config,
  buildRepos: BuildRepositories,
  intervalMs: number,
  logger?: Logger,
  /** Re-syncs Vehicle tool availability (createTicketsVehicleRegistry's syncDiscoverAvailability) against the freshly swapped-in backend set -- called after every successful refresh, so a Jira credential added or removed at runtime flips discover.* tool visibility without a daemon restart. Optional: a caller with no vehicleRegistry yet (tests, injected repos) just skips it. */
  onRefreshed?: (service: TicketService) => void,
): MaintenanceTask {
  return {
    name: "backend-refresh",
    intervalMs,
    run: async () => {
      const before = new Set(service.backends());
      let fresh: Record<string, IssueRepository>;
      try {
        fresh = await buildRepos(config);
      } catch (error) {
        logger?.warn("backend refresh failed, keeping previous backend set", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      service.setRepos(fresh);
      onRefreshed?.(service);
      const after = new Set(Object.keys(fresh));
      const added = [...after].filter((backend) => !before.has(backend));
      const removed = [...before].filter((backend) => !after.has(backend));
      if (added.length > 0 || removed.length > 0) {
        logger?.info("backend set changed", { added, removed });
      }
    },
  };
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
          syncProjects: resolveSyncProjects(cfg, env),
          syncMine: resolveSyncMine(cfg, env),
          configDir: configDir(),
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
        syncProjects: resolveSyncProjects(cfg, env),
        syncMine: resolveSyncMine(cfg, env),
        configDir: configDir(),
      });
    }
    default:
      return undefined;
  }
}
