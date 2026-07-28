import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveToken } from "@danypops/tickets";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { __resetSecretsRegistryForTests, claimSecretsCommandName, listSecretsContributors } from "@danypops/daemon-kit/secrets-registry";
import { buildTicketsSecretsBackends, buildTicketsSecretsContribution, registerTicketsSecretsCommand } from "../src/secrets.js";

function tempEnv(): { root: string; env: Record<string, string> } {
	const root = mkdtempSync(join(tmpdir(), "pi-tickets-secrets-"));
	return { root, env: { ...(process.env as Record<string, string>), XDG_STATE_HOME: join(root, "state"), GITHUB_TOKEN: "", GITLAB_TOKEN: "", JIRA_API_TOKEN: "" } };
}

describe("buildTicketsSecretsBackends", () => {
	it("returns a local backend over tickets' own oauth token-store directory, and an env backend for github/gitlab/jira static fallbacks", async () => {
		const { root, env } = tempEnv();
		try {
			saveToken("github", { accessToken: "gho_x" }, { env });
			const backends = buildTicketsSecretsBackends(env);
			expect(backends.map((b) => b.source).sort()).toEqual(["env", "local"]);

			const local = backends.find((b) => b.source === "local")!;
			expect(await local.get("github")).toEqual({ name: "github", source: "local", configured: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("the env backend reflects GITHUB_TOKEN/GITLAB_TOKEN/JIRA_API_TOKEN presence", async () => {
		const { root, env } = tempEnv();
		try {
			const backends = buildTicketsSecretsBackends({ ...env, JIRA_API_TOKEN: "tok" });
			const envBackend = backends.find((b) => b.source === "env")!;
			expect(await envBackend.list()).toEqual([
				{ name: "github", source: "env", configured: false },
				{ name: "gitlab", source: "env", configured: false },
				{ name: "jira", source: "env", configured: true },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("buildTicketsSecretsContribution", () => {
	it("declares tickets itself as a [services] entry using github/gitlab/jira", async () => {
		const { root, env } = tempEnv();
		try {
			const contribution = buildTicketsSecretsContribution(env);
			expect(await contribution.servicesRegistry?.list()).toEqual([{ name: "tickets", backends: ["github", "gitlab", "jira"] }]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("registerTicketsSecretsCommand", () => {
	it("contributes to the shared /secrets namespace instead of registering its own command", () => {
		__resetSecretsRegistryForTests();
		const registered: string[] = [];
		const pi = { registerCommand: (name: string) => registered.push(name) } as unknown as ExtensionAPI;
		registerTicketsSecretsCommand(pi, () => ({ backends: [] }));
		expect(registered).toEqual(["secrets"]); // claims it since nothing else registered first in this test
		expect(listSecretsContributors().map((c) => c.source)).toEqual(["tickets"]);
	});

	it("still contributes even when another consumer already claimed the real command", () => {
		__resetSecretsRegistryForTests();
		const registered: string[] = [];
		const pi = { registerCommand: (name: string) => registered.push(name) } as unknown as ExtensionAPI;
		pi.registerCommand("secrets", { description: "", handler: async () => {} } as never); // simulate enigma/pipes registering first
		claimSecretsCommandName("secrets");
		registerTicketsSecretsCommand(pi, () => ({ backends: [] }));
		expect(registered).toEqual(["secrets"]); // only the simulated first registration -- tickets did not register a second
		expect(listSecretsContributors().map((c) => c.source)).toEqual(["tickets"]);
	});
});
