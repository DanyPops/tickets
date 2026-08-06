/**
 * spawnDaemon (src/cli/tickets-client.ts) is reached via createTicketsClient -> ensureDaemonRunning
 * from inside the long-lived pi-tickets extension host (tui.ts), not just the standalone tickets
 * CLI. A spawn() failure surfaces asynchronously as an unlistened "error" event under real Node --
 * an uncaught exception that kills the whole host process, not just this one connect attempt.
 * Bun's own spawn() throws this same failure synchronously at the call site instead (see
 * @danypops/vehicle-client's spawn-error-uncaught-crash.test.ts for that comparison), so this
 * runs under real Node in a real subprocess: an uncaught exception can only be observed via a
 * child's own exit code/stderr, not caught inline without also crashing the test runner.
 *
 * spawnDaemon hardcodes `spawn("bun", ...)` -- forcing that to ENOENT means running the child
 * with an empty PATH, not a bogus binPath (there is no separate binPath parameter to override).
 *
 * tickets-client.ts imports across package/module boundaries Node's own type-stripper can't
 * resolve unbundled (extensionless internal imports); Bun.build() compiles it to a
 * Node-runnable artifact, same approach as papyrus's spawn-crash regression test.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUILD_ROOT = join(import.meta.dir, "..", "..", ".node-crash-test-build");

afterAll(() => rmSync(BUILD_ROOT, { recursive: true, force: true }));

async function buildClientForNode(outDir: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "..", "src", "cli", "tickets-client.ts")],
    target: "node",
    outdir: outDir,
  });
  if (!result.success) throw new Error(`build failed: ${result.logs.map(String).join("\n")}`);
  return join(outDir, "tickets-client.js");
}

function runUnderNode(scriptPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("node", [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("spawnDaemon under real Node -- a bun-less PATH must never crash the host", () => {
  it("a missing `bun` binary is logged and swallowed, never crashes the host process", async () => {
    mkdirSync(BUILD_ROOT, { recursive: true });
    const dir = mkdtempSync(join(BUILD_ROOT, "run-"));
    const clientPath = await buildClientForNode(dir);

    const scriptPath = join(dir, "run.mjs");
    writeFileSync(
      scriptPath,
      `
				// No \`bun\` reachable on PATH -- forces spawn("bun", [...]) to ENOENT the same way a
				// missing/misconfigured binary would in production. Set from inside the script itself,
				// not the outer spawn('node', ...)'s own env -- that still needs a real PATH to find node.
				process.env.PATH = "/definitely/empty/path";
				import { spawnDaemon } from ${JSON.stringify(clientPath)};
				spawnDaemon();
				setTimeout(() => console.log("REACHED_END_WITHOUT_CRASHING"), 300);
				`,
    );

    const result = await runUnderNode(scriptPath);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("REACHED_END_WITHOUT_CRASHING");
    expect(result.stderr).toContain("tickets daemon auto-spawn failed: spawn bun ENOENT");
    expect(result.stderr).not.toContain("Uncaught");
  }, 15_000);
});
