/**
 * Loads this extension the same way Pi's real Bun binary loads it -- via
 * jiti -- rather than a plain Bun import(), and boots it through a real
 * ExtensionAPI stub (createExtensionHarness) to check actual behavior, not
 * just "does importing this throw". A jiti transform can behave differently
 * from a native import in real, previously hit ways, and this test caught a
 * genuine regression once already: a stale @danypops/vehicle-client-pi
 * dependency meant promptSnippet was missing under this exact load path
 * even though vehicle-client.test.ts's fake-client coverage passed.
 */
import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionHarness, loadExtensionViaJiti } from "@danypops/pi-extension-harness";
import { verifyLoadableUnderPi } from "@danypops/vehicle-client-pi/pi-load-harness";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(__dirname, "../src/index.ts");

describe("pi-tickets loaded under every Pi extension load path", () => {
	it("loads without throwing via native ESM, jiti tryNative:false, and jiti tryNative:true", async () => {
		const results = await verifyLoadableUnderPi(EXTENSION_PATH);
		for (const result of results) {
			expect(result.ok, `${result.path}: ${result.error ?? ""}`).toBe(true);
		}
	});
});

describe("pi-tickets loaded via the production jiti path", () => {
	it("registers the /tickets, /query, and /secrets commands and every promptSnippet-bearing tool", async () => {
		// The shared secrets-contributor registry lives on globalThis (see
		// secrets-registry.ts) -- reset it first so this test doesn't see
		// "secrets" as already claimed by whichever test ran earlier in this
		// same process.
		const { __resetSecretsRegistryForTests } = await import("@danypops/vehicle-client-pi/secrets-registry");
		__resetSecretsRegistryForTests();

		const factory = await loadExtensionViaJiti(EXTENSION_PATH);
		const h = createExtensionHarness(factory);
		await h.boot();
		try {
			expect(h.commands).toEqual(["tickets", "query", "secrets"]);
			// Whether any tools registered depends on whether a real tickets
			// daemon happens to be reachable on this machine (registerTicketsVehicle
			// degrades silently otherwise) -- but any tool that DID register must
			// carry a real promptSnippet, or Pi's system prompt silently omits it
			// (the exact bug this suite exists to catch a regression of).
			for (const tool of h.tools.values()) {
				expect(tool.definition.promptSnippet, `${tool.definition.name} is missing promptSnippet`).toBeTruthy();
			}
		} finally {
			await h.shutdown();
		}
	});
});
