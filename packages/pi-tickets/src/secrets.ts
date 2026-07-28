/**
 * tickets' own contribution to daemon-kit's shared /secrets namespace: the
 * local OAuth token-store directory every `tickets auth login` writes to
 * (github/gitlab/jira profiles), plus the three static-token env vars
 * tickets' config falls back to. Also declares tickets itself as a
 * [services] entry (the backends it depends on), so a user browsing
 * /secrets sees "tickets" alongside Enigma's own real vault clients in the
 * same reverse secret-to-consumer lookup.
 *
 * Contributes to the shared /secrets command (registerSharedSecretsCommand)
 * instead of a standalone command -- pi-enigma and pi-pipes contribute the
 * same way; whichever of the three loads first in a given Pi session ends
 * up claiming the real command registration, and all three still show up
 * in it regardless of load order.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSharedSecretsCommand, type SecretsContribution } from "@danypops/daemon-kit/secrets-tui";
import { createEnvSecretsBackend } from "@danypops/daemon-kit/secrets-backend-env";
import { createLocalSecretsBackend } from "@danypops/daemon-kit/secrets-backend-local";
import type { SecretsBackend } from "@danypops/daemon-kit/secrets-backend";
import { tokenStoreDir } from "@danypops/tickets";

const TICKETS_BACKEND_NAMES = ["github", "gitlab", "jira"];

export function buildTicketsSecretsBackends(env: NodeJS.ProcessEnv = process.env): SecretsBackend[] {
	return [
		createLocalSecretsBackend({ dir: tokenStoreDir({ env }) }),
		createEnvSecretsBackend({ github: "GITHUB_TOKEN", gitlab: "GITLAB_TOKEN", jira: "JIRA_API_TOKEN" }, env),
	];
}

export function buildTicketsSecretsContribution(env: NodeJS.ProcessEnv = process.env): SecretsContribution {
	return {
		backends: buildTicketsSecretsBackends(env),
		servicesRegistry: { list: async () => [{ name: "tickets", backends: TICKETS_BACKEND_NAMES }] },
	};
}

export function registerTicketsSecretsCommand(pi: ExtensionAPI, buildContribution: typeof buildTicketsSecretsContribution = buildTicketsSecretsContribution): void {
	registerSharedSecretsCommand(pi, { source: "tickets", resolve: () => buildContribution() });
}
