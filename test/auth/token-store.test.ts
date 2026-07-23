import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteToken, isTokenFresh, listStoredBackends, loadToken, saveToken } from "../../src/auth/token-store.js";

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function env() {
  scratch = mkdtempSync(join(tmpdir(), "tickets-token-store-"));
  return { env: { XDG_STATE_HOME: scratch } };
}

describe("token-store", () => {
  it("round-trips a token through save/load", () => {
    const opts = env();
    saveToken("github", { accessToken: "tok_1", scope: "repo" }, opts);
    const loaded = loadToken("github", opts);
    expect(loaded?.accessToken).toBe("tok_1");
  });

  it("writes token files with 0600 permissions", () => {
    const opts = env();
    saveToken("jira", { accessToken: "tok_2" }, opts);
    const path = join(opts.env.XDG_STATE_HOME, "tickets", "oauth", "jira.json");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns undefined for a backend with no stored token", () => {
    const opts = env();
    expect(loadToken("gitlab", opts)).toBeUndefined();
  });

  it("deleteToken is idempotent", () => {
    const opts = env();
    saveToken("github", { accessToken: "tok_3" }, opts);
    deleteToken("github", opts);
    deleteToken("github", opts);
    expect(loadToken("github", opts)).toBeUndefined();
  });

  it("listStoredBackends reflects saved tokens", () => {
    const opts = env();
    saveToken("github", { accessToken: "a" }, opts);
    saveToken("gitlab", { accessToken: "b" }, opts);
    expect(listStoredBackends(opts).sort()).toEqual(["github", "gitlab"]);
  });

  it("isTokenFresh: no expiry means always fresh; past expiry is stale", () => {
    expect(isTokenFresh({ accessToken: "a" })).toBe(true);
    expect(isTokenFresh({ accessToken: "a", expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(false);
    expect(isTokenFresh({ accessToken: "a", expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).toBe(true);
  });
});
