#!/usr/bin/env bun
/**
 * The tickets CLI is a thin client of the tickets daemon: every command maps
 * 1:1 to a daemon RPC op (see daemon/ops.ts and daemon/server.ts), the same
 * ops the pi-tickets extension calls. Nothing here opens the daemon's SQLite
 * ledger or a backend adapter directly.
 */
import { Command } from "commander";
import type { CreateInput, ListFilter, Priority, Status, UpdateInput } from "../domain/issue.js";
import { parseStatus } from "../domain/issue.js";
import { createTicketsClient, type TicketsRpcClient } from "../client/tickets-client.js";
import { openUrl } from "../auth/browser.js";
import { loginWithGitHubDeviceFlow } from "../auth/github-oauth.js";
import { gitlabDeviceEndpoints, loginWithGitLabDeviceFlow } from "../auth/gitlab-oauth.js";
import { loginWithJiraAuthorizationCode } from "../auth/jira-oauth.js";
import { deleteToken, isTokenFresh, listStoredBackends, loadToken, saveToken } from "../auth/token-store.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function withClient<T>(fn: (client: TicketsRpcClient) => Promise<T>): Promise<void> {
  try {
    const client = await createTicketsClient();
    printJson(await fn(client));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}

const program = new Command();
program.name("tickets").description("Unified issue tracking CLI (GitHub, GitLab, Jira)").version("0.1.0");

program
  .command("list")
  .description("list issues on a backend")
  .requiredOption("-b, --backend <name>", "backend name")
  .option("--status <status>", "filter by status")
  .option("--assignee <user>", "filter by assignee")
  .option("--label <label...>", "filter by label(s)")
  .option("--limit <n>", "max results", (v) => Number.parseInt(v, 10))
  .action(async (opts) => {
    const filter: ListFilter = {
      status: opts.status ? parseStatus(opts.status) : undefined,
      assignee: opts.assignee,
      labels: opts.label,
      limit: opts.limit,
    };
    await withClient((client) => client.call("issue.list", { backend: opts.backend, filter }));
  });

program
  .command("get <ref>")
  .description('get one issue, e.g. "jira:PROJ-42" or "github:#7"')
  .action(async (ref: string) => {
    await withClient((client) => client.call("issue.get", { ref }));
  });

program
  .command("create <title>")
  .description("create an issue")
  .requiredOption("-b, --backend <name>", "backend name")
  .option("--description <text>", "issue description")
  .option("--priority <priority>", "priority: none|urgent|high|medium|low")
  .option("--label <label...>", "label(s)")
  .option("--assignee <user>", "assignee")
  .option("--project <project>", "project key/id override")
  .action(async (title: string, opts) => {
    const input: CreateInput = {
      title,
      description: opts.description,
      priority: opts.priority as Priority | undefined,
      labels: opts.label,
      assignee: opts.assignee,
      project: opts.project,
    };
    await withClient((client) => client.call("issue.create", { backend: opts.backend, input }));
  });

program
  .command("update <ref>")
  .description("update an issue")
  .option("--title <text>", "new title")
  .option("--description <text>", "new description")
  .option("--status <status>", "new status")
  .option("--priority <priority>", "new priority")
  .option("--label <label...>", "replace labels")
  .option("--assignee <user>", "reassign (empty string to unassign)")
  .action(async (ref: string, opts) => {
    const input: UpdateInput = {
      title: opts.title,
      description: opts.description,
      status: opts.status ? parseStatus(opts.status) : (undefined as Status | undefined),
      priority: opts.priority as Priority | undefined,
      labels: opts.label,
      assignee: opts.assignee,
    };
    await withClient((client) => client.call("issue.update", { ref, input }));
  });

program
  .command("search <query>")
  .description("search issues on a backend")
  .requiredOption("-b, --backend <name>", "backend name")
  .option("--limit <n>", "max results", (v) => Number.parseInt(v, 10))
  .action(async (query: string, opts) => {
    await withClient((client) => client.call("issue.search", { backend: opts.backend, query, limit: opts.limit }));
  });

program
  .command("children <ref>")
  .description("list child issues (Jira sub-tasks/epics; empty on backends without native sub-issues)")
  .action(async (ref: string) => {
    await withClient((client) => client.call("issue.children", { ref }));
  });

const comment = program.command("comment").description("comment operations");

comment
  .command("list <ref>")
  .description("list comments on an issue")
  .action(async (ref: string) => {
    await withClient((client) => client.call("issue.comments", { ref }));
  });

comment
  .command("add <ref> <body>")
  .description("add a comment to an issue")
  .action(async (ref: string, body: string) => {
    await withClient((client) => client.call("issue.comment_add", { ref, body }));
  });

const ledger = program.command("ledger").description("query the daemon's locally pooled issue cache");

ledger
  .command("search <query>")
  .description("search the local ledger (works even if the backend is currently unreachable)")
  .option("--limit <n>", "max results", (v) => Number.parseInt(v, 10))
  .action(async (query: string, opts) => {
    await withClient((client) => client.call("ledger.search", { query, limit: opts.limit }));
  });

ledger
  .command("stats")
  .description("issue counts per backend in the local ledger")
  .action(async () => {
    await withClient((client) => client.call("ledger.stats", {}));
  });

program
  .command("backends")
  .description("list configured backend names")
  .action(async () => {
    await withClient((client) => client.call("backends.list", {}));
  });

const daemon = program.command("daemon").description("manage the tickets daemon process");

daemon
  .command("status")
  .description("check whether the tickets daemon is reachable (never auto-starts it)")
  .action(async () => {
    try {
      const client = await createTicketsClient({ autoStart: false });
      printJson({ reachable: true, ...(await client.health()) });
    } catch (err) {
      printJson({ reachable: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

daemon
  .command("start")
  .description("start the daemon if it isn't already running")
  .action(async () => {
    try {
      const client = await createTicketsClient({ autoStart: true });
      printJson({ status: "running", ...(await client.health()) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    }
  });

daemon
  .command("stop")
  .description("ask the running daemon to shut down gracefully")
  .action(async () => {
    try {
      const client = await createTicketsClient({ autoStart: false });
      await client.call("daemon.shutdown", {});
      printJson({ status: "stopping" });
    } catch (err) {
      printJson({ status: "not_running", detail: err instanceof Error ? err.message : String(err) });
    }
  });

daemon
  .command("restart")
  .description("stop the daemon (if running) and start a fresh one")
  .action(async () => {
    try {
      const client = await createTicketsClient({ autoStart: false });
      await client.call("daemon.shutdown", {});
    } catch {
      // not running — nothing to stop, proceed straight to starting a fresh one.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const client = await createTicketsClient({ autoStart: true });
      printJson({ status: "restarted", ...(await client.health()) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    }
  });

const auth = program.command("auth").description("delegated OAuth login (device flow for GitHub/GitLab, authorization code for Jira)");

auth
  .command("login")
  .description("authorize tickets against a backend and store the resulting token locally (0600, never printed)")
  .requiredOption("-b, --backend <name>", "github | gitlab | jira (or a custom multi-instance name, paired with --type)")
  .option("--type <type>", "adapter type, when --backend is a custom multi-instance name")
  .option("--client-id <id>", "OAuth client/application ID (falls back to <TYPE>_OAUTH_CLIENT_ID)")
  .option("--client-secret <secret>", "OAuth client secret (Jira only — GitHub/GitLab device flow needs none)")
  .option("--url <baseUrl>", "self-managed GitLab URL (defaults to gitlab.com)")
  .option("--scope <scope>", "space-delimited OAuth scope override")
  .action(async (opts) => {
    const type = opts.type ?? opts.backend;
    try {
      if (type === "github") {
        const clientId = opts.clientId ?? process.env.GITHUB_OAUTH_CLIENT_ID;
        if (!clientId) throw new Error("--client-id or GITHUB_OAUTH_CLIENT_ID is required");
        const token = await loginWithGitHubDeviceFlow({
          clientId,
          scope: opts.scope,
          onPrompt: async (prompt) => {
            process.stderr.write(`Open ${prompt.verificationUri} and enter code: ${prompt.userCode}\n`);
            try {
              openUrl(prompt.verificationUriComplete ?? prompt.verificationUri);
            } catch {
              // headless environment — the printed URL/code above is still enough to proceed manually.
            }
          },
        });
        saveToken(opts.backend, { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt, scope: token.scope });
      } else if (type === "gitlab") {
        const clientId = opts.clientId ?? process.env.GITLAB_OAUTH_CLIENT_ID;
        if (!clientId) throw new Error("--client-id or GITLAB_OAUTH_CLIENT_ID is required");
        const baseUrl = opts.url ?? process.env.GITLAB_URL;
        const token = await loginWithGitLabDeviceFlow({
          clientId,
          baseUrl,
          scope: opts.scope,
          onPrompt: async (prompt) => {
            process.stderr.write(`Open ${prompt.verificationUri} and enter code: ${prompt.userCode}\n`);
            try {
              openUrl(prompt.verificationUriComplete ?? prompt.verificationUri);
            } catch {
              // headless environment — printed instructions above are enough.
            }
          },
        });
        saveToken(opts.backend, { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt, scope: token.scope });
      } else if (type === "jira") {
        const clientId = opts.clientId ?? process.env.JIRA_OAUTH_CLIENT_ID;
        const clientSecret = opts.clientSecret ?? process.env.JIRA_OAUTH_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new Error("--client-id/--client-secret or JIRA_OAUTH_CLIENT_ID/JIRA_OAUTH_CLIENT_SECRET are required (Atlassian 3LO has no public-client flow)");
        }
        const token = await loginWithJiraAuthorizationCode({
          clientId,
          clientSecret,
          scope: opts.scope,
          onPrompt: async (authorizeUrl) => {
            process.stderr.write(`Open this URL to authorize tickets against your Atlassian site:\n${authorizeUrl}\n`);
            try {
              openUrl(authorizeUrl);
            } catch {
              // headless environment — the printed URL above is enough to proceed manually.
            }
          },
        });
        saveToken(opts.backend, {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          extra: { cloudId: token.cloudId, siteUrl: token.siteUrl },
        });
      } else {
        throw new Error(`auth login: unsupported type "${type}" (expected github, gitlab, or jira)`);
      }
      printJson({
        backend: opts.backend,
        status: "authorized",
        note: "restart the tickets daemon (or run `tickets daemon-status` after a fresh start) to pick up the new token",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    }
  });

auth
  .command("status")
  .description("list backends with a locally stored delegated token")
  .action(() => {
    const backends = listStoredBackends();
    printJson(
      backends.map((backend) => {
        const token = loadToken(backend);
        return {
          backend,
          fresh: token ? isTokenFresh(token) : false,
          expiresAt: token?.expiresAt ?? null,
          scope: token?.scope ?? null,
        };
      }),
    );
  });

auth
  .command("logout <backend>")
  .description("remove a backend's locally stored delegated token (falls back to config/env PAT)")
  .action((backend: string) => {
    deleteToken(backend);
    printJson({ backend, status: "logged_out" });
  });

program.parseAsync(process.argv).catch(() => {
  process.exitCode = 1;
});
