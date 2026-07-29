/**
 * Spawns the real shipped `cli.ts auth set-token` command as a subprocess against a real temp
 * XDG state dir -- a pure local filesystem operation, no daemon or network involved, so this
 * exercises the real env-var/prompt branching and file-write path end to end.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli", "index.ts");

async function runCliProcess(
  args: string[],
  env: Record<string, string>,
  stdin: Blob | undefined = undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], { env, stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

function tempXdgEnv(dir: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: dir, XDG_STATE_HOME: dir };
}

describe("tickets auth set-token (real subprocess)", () => {
  it("saves a real token via TICKETS_TOKEN_VALUE, non-interactively", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tickets-set-token-"));
    try {
      const { code, stdout } = await runCliProcess(["auth", "set-token", "jira"], { ...tempXdgEnv(dir), TICKETS_TOKEN_VALUE: "real-jira-token" });
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({
        backend: "jira",
        status: "stored",
        note: "restart the tickets daemon (or run `tickets daemon-status` after a fresh start) to pick up the new token",
      });

      const stateFile = join(dir, "tickets", "oauth", "jira.json");
      expect(existsSync(stateFile)).toBe(true);
      const saved = JSON.parse(readFileSync(stateFile, "utf8"));
      expect(saved).toEqual({ accessToken: "real-jira-token" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never prints the token value itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tickets-set-token-"));
    try {
      const { stdout, stderr } = await runCliProcess(["auth", "set-token", "jira"], { ...tempXdgEnv(dir), TICKETS_TOKEN_VALUE: "should-never-be-printed" });
      expect(stdout).not.toContain("should-never-be-printed");
      expect(stderr).not.toContain("should-never-be-printed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an arbitrary custom backend name, not just github/gitlab/jira", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tickets-set-token-"));
    try {
      const { code } = await runCliProcess(["auth", "set-token", "my-custom-jira"], { ...tempXdgEnv(dir), TICKETS_TOKEN_VALUE: "x" });
      expect(code).toBe(0);
      expect(existsSync(join(dir, "tickets", "oauth", "my-custom-jira.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero with a clear message when no value is provided and stdin has nothing piped in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tickets-set-token-"));
    try {
      const { code, stderr } = await runCliProcess(["auth", "set-token", "jira"], tempXdgEnv(dir), new Blob([""]));
      expect(code).not.toBe(0);
      expect(stderr).toContain("no token value provided");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
