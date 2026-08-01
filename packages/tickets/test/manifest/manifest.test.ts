import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, get, load, merge, save } from "../../src/manifest/manifest.js";

function withTempDir<T>(fn: (dir: string) => T | Promise<T>): T | Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tickets-manifest-test-"));
  const result = fn(dir);
  if (result instanceof Promise) {
    return result.finally(() => rmSync(dir, { recursive: true, force: true }));
  }
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe("manifest", () => {
  it("load() returns an empty manifest when no file exists yet, not an error", () => {
    withTempDir((dir) => {
      const m = load("fields", "jira", dir);
      expect(m).toEqual({ backend: "jira", mappings: {} });
    });
  });

  it("save() then load() round-trips the mappings and discoveredAt", () => {
    withTempDir((dir) => {
      const discovered = discover("jira", { "Target Version": "customfield_10855" });
      save("fields", "jira", dir, discovered);
      const loaded = load("fields", "jira", dir);
      expect(loaded.mappings).toEqual({ "Target Version": "customfield_10855" });
      expect(loaded.discoveredAt).toBe(discovered.discoveredAt);
    });
  });

  it("save() writes a header comment pointing at the regeneration command", () => {
    withTempDir((dir) => {
      save("fields", "jira", dir, discover("jira", { Sprint: "customfield_10020" }));
      const raw = readFileSync(join(dir, "fields", "jira.yaml"), "utf8");
      expect(raw).toContain("Tickets fields manifest — jira");
      expect(raw).toContain("tickets discover fields --backend jira");
    });
  });

  it("get() returns undefined for a missing key and for an undefined manifest", () => {
    const m = discover("jira", { Sprint: "customfield_10020" });
    expect(get(m, "Sprint")).toBe("customfield_10020");
    expect(get(m, "Nonexistent")).toBeUndefined();
    expect(get(undefined, "Sprint")).toBeUndefined();
  });

  it("merge() lets overrides win without mutating the original manifest", () => {
    const base = discover("jira", { Sprint: "customfield_10020", "Story Points": "customfield_10028" });
    const merged = merge(base, { Sprint: "customfield_99999" });
    expect(merged.mappings.Sprint).toBe("customfield_99999");
    expect(merged.mappings["Story Points"]).toBe("customfield_10028");
    expect(base.mappings.Sprint).toBe("customfield_10020");
  });

  it("save() overwrites a prior manifest for the same backend", () => {
    withTempDir((dir) => {
      save("fields", "jira", dir, discover("jira", { Old: "customfield_1" }));
      save("fields", "jira", dir, discover("jira", { New: "customfield_2" }));
      const loaded = load("fields", "jira", dir);
      expect(loaded.mappings).toEqual({ New: "customfield_2" });
    });
  });

  it("fields and statuses manifests for the same backend are independent (different kind)", () => {
    withTempDir((dir) => {
      save("fields", "jira", dir, discover("jira", { Sprint: "customfield_10020" }));
      save("statuses", "jira", dir, discover("jira", { ON_QA: "in_review" }));
      expect(load("fields", "jira", dir).mappings).toEqual({ Sprint: "customfield_10020" });
      expect(load("statuses", "jira", dir).mappings).toEqual({ ON_QA: "in_review" });
    });
  });
});
