/**
 * tickets' own SecretsBackend set for daemon-kit's generic /secrets
 * command: the local OAuth token-store directory every `tickets auth
 * login` writes to (github/gitlab/jira profiles), plus the three
 * static-token env vars tickets' config falls back to.
 *
 * Registered as its own /tickets-secrets command, not /secrets: pi-enigma
 * already owns that name, and /tickets itself has no menu shape to fold a
 * "Secrets" entry into the way pi-pipes' /pipes does -- it's a
 * single-purpose issue browser/focus dialog, not an action list.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSecretsCommand } from "@danypops/daemon-kit/secrets-tui";
import { createEnvSecretsBackend } from "@danypops/daemon-kit/secrets-backend-env";
import { createLocalSecretsBackend } from "@danypops/daemon-kit/secrets-backend-local";
import type { SecretsBackend } from "@danypops/daemon-kit/secrets-backend";
import { tokenStoreDir } from "@danypops/tickets";

export function buildTicketsSecretsBackends(env: NodeJS.ProcessEnv = process.env): SecretsBackend[] {
	return [
		createLocalSecretsBackend({ dir: tokenStoreDir({ env }) }),
		createEnvSecretsBackend({ github: "GITHUB_TOKEN", gitlab: "GITLAB_TOKEN", jira: "JIRA_API_TOKEN" }, env),
	];
}

export function registerTicketsSecretsCommand(pi: ExtensionAPI, buildBackends: typeof buildTicketsSecretsBackends = buildTicketsSecretsBackends): void {
	registerSecretsCommand(pi, () => ({ backends: buildBackends() }), "tickets-secrets");
}
