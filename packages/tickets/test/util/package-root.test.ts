import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../../src/util/package-root.js";

describe("packageRoot", () => {
  it("walks upward and finds the package.json matching the given name", () => {
    const root = mkdtempSync(join(tmpdir(), "pkgroot-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tickets" }));
      const nested = join(root, "src", "client");
      mkdirSync(nested, { recursive: true });
      expect(packageRoot(nested, "tickets")).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips an unrelated package.json on the way up", () => {
    const root = mkdtempSync(join(tmpdir(), "pkgroot-unrelated-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tickets" }));
      const nested = join(root, "node_modules", "@danypops", "daemon-kit");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@danypops/daemon-kit" }));
      expect(packageRoot(nested, "tickets")).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when no matching package.json exists within maxLevels", () => {
    const root = mkdtempSync(join(tmpdir(), "pkgroot-missing-"));
    try {
      expect(() => packageRoot(root, "tickets", 1)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
