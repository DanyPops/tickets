/**
 * defaultSpawner (src/auth/browser.ts) runs from inside the long-lived pi-tickets extension
 * host (tui.ts), not just the standalone tickets CLI. A spawn() failure (e.g. no `xdg-open` on
 * a minimal Linux install) surfaces asynchronously as an unlistened "error" event under real
 * Node -- an uncaught exception that kills the whole host process, not just this one URL-open
 * attempt. Bun's own spawn() throws this same ENOENT synchronously at the call site instead
 * (see @danypops/vehicle-client's spawn-error-uncaught-crash.test.ts for that comparison), so
 * this runs under real Node in a real subprocess: an uncaught exception can only be observed
 * via a child's own exit code/stderr, not caught inline without also crashing the test runner.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "tickets-browser-spawn-crash-"));
  dirs.push(dir);
  const path = join(dir, "repro.mjs");
  writeFileSync(
    path,
    `
		import { defaultSpawner } from ${JSON.stringify(join(PACKAGE_ROOT, "src", "auth", "browser.ts"))};
		defaultSpawner("/definitely/does/not/exist/xdg-open", ["https://example.com"]);
		setTimeout(() => console.log("REACHED_END_WITHOUT_CRASHING"), 300);
		`,
  );
  return path;
}

/** Real Node, not whichever runtime executes this test file -- browser.ts has no decorators or
 * parameter properties, so Node's own type-stripping imports it directly, no bundling needed. */
function runUnderNode(scriptPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("node", [scriptPath], { cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "pipe"] });
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

describe("defaultSpawner (openUrl's real spawner) never crashes the host on a missing browser-open binary", () => {
  it("a missing xdg-open/open/cmd binary is logged and swallowed, not an uncaught process-killing exception", async () => {
    const result = await runUnderNode(writeFixture());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("REACHED_END_WITHOUT_CRASHING");
    expect(result.stderr).toContain("failed to open URL via /definitely/does/not/exist/xdg-open");
    expect(result.stderr).not.toContain("Uncaught");
  }, 15_000);
});
