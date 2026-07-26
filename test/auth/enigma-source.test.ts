import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryEnigmaCredential } from "../../src/auth/enigma-source.js";

function tmpXdg(): { dir: string; env: { XDG_RUNTIME_DIR: string; XDG_STATE_HOME: string } } {
	const dir = mkdtempSync(join(tmpdir(), "tickets-enigma-source-"));
	return { dir, env: { XDG_RUNTIME_DIR: join(dir, "run"), XDG_STATE_HOME: join(dir, "state") } };
}

describe("tryEnigmaCredential", () => {
	it("resolves undefined immediately when no Enigma handle file exists -- not running, not an error", async () => {
		const { dir, env } = tmpXdg();
		try {
			const result = await tryEnigmaCredential("github", { env });
			expect(result).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves undefined when a handle exists but the token file doesn't -- never mints Enigma's own token", async () => {
		const { dir, env } = tmpXdg();
		try {
			const handleDir = join(env.XDG_RUNTIME_DIR, "enigma");
			mkdirSync(handleDir, { recursive: true });
			writeFileSync(join(handleDir, "handle.json"), JSON.stringify({ host: "127.0.0.1", port: 39217, pid: 1 }));
			const result = await tryEnigmaCredential("github", { env });
			expect(result).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fetches the real credential shape from a live vault when both the handle and token are present", async () => {
		const { dir, env } = tmpXdg();
		let server: ReturnType<typeof Bun.serve> | undefined;
		try {
			server = Bun.serve({
				port: 0,
				fetch(request) {
					if (request.headers.get("authorization") !== "Bearer fixture-enigma-bearer") return new Response("unauthorized", { status: 401 });
					const url = new URL(request.url);
					if (url.pathname === "/creds/github") {
						return new Response(JSON.stringify({ accessToken: "fixture-github-token-from-enigma", scope: "repo" }), { headers: { "content-type": "application/json" } });
					}
					return new Response("not found", { status: 404 });
				},
			});

			const handleDir = join(env.XDG_RUNTIME_DIR, "enigma");
			const stateDir = join(env.XDG_STATE_HOME, "enigma");
			mkdirSync(handleDir, { recursive: true });
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(join(handleDir, "handle.json"), JSON.stringify({ host: "127.0.0.1", port: server.port, pid: process.pid }));
			writeFileSync(join(stateDir, "token"), "fixture-enigma-bearer\n");

			const result = await tryEnigmaCredential("github", { env });
			expect(result).toEqual({ accessToken: "fixture-github-token-from-enigma", scope: "repo" });

			const missing = await tryEnigmaCredential("gitlab", { env });
			expect(missing).toBeUndefined(); // real 404 -- backend not configured in the vault
		} finally {
			server?.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never throws and resolves undefined when the vault is unreachable", async () => {
		const { dir, env } = tmpXdg();
		try {
			const handleDir = join(env.XDG_RUNTIME_DIR, "enigma");
			const stateDir = join(env.XDG_STATE_HOME, "enigma");
			mkdirSync(handleDir, { recursive: true });
			mkdirSync(stateDir, { recursive: true });
			// A port nothing is listening on -- connection refused, not a timeout, but exercises the same catch-and-fall-through path.
			writeFileSync(join(handleDir, "handle.json"), JSON.stringify({ host: "127.0.0.1", port: 1, pid: process.pid }));
			writeFileSync(join(stateDir, "token"), "fixture-enigma-bearer\n");
			const result = await tryEnigmaCredential("github", { env });
			expect(result).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
