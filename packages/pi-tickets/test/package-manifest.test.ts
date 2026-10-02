import { describe, expect, it } from "bun:test";
import manifest from "../package.json";

const HOST_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

const dependencies: Record<string, string> = manifest.dependencies;
const peerDependencies: Record<string, string> = manifest.peerDependencies;

describe("Pi host package declarations", () => {
  for (const name of HOST_PACKAGES) {
    it(`resolves ${name} through the host when declared`, () => {
      expect(dependencies[name]).toBeUndefined();
      if (name in peerDependencies) {
        expect(peerDependencies[name]).toBe("*");
      }
    });
  }

  it("declares the imported host packages as wildcard peers", () => {
    for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
      expect(peerDependencies[name]).toBe("*");
    }
  });
});
