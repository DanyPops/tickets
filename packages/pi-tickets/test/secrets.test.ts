import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveToken } from "@danypops/tickets";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildTicketsSecretsBackends, registerTicketsSecretsCommand } from "../src/secrets.js";

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

describe("registerTicketsSecretsCommand", () => {
	it("registers under 'tickets-secrets', not 'secrets' -- pi-enigma already owns that name", () => {
		const registered: string[] = [];
		const pi = { registerCommand: (name: string) => registered.push(name) } as unknown as ExtensionAPI;
		registerTicketsSecretsCommand(pi, () => []);
		expect(registered).toEqual(["tickets-secrets"]);
	});
});
