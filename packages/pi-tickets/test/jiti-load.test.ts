/**
 * Loads this extension the same way Pi's real Bun binary loads it -- via
 * jiti -- rather than a plain Bun import(). A jiti transform can behave
 * differently from a native import in real, previously hit ways (e.g. a
 * class re-exported through ESM interop losing its constructor identity
 * across the jiti/native realm boundary), so this is a genuinely different
 * check from vehicle-client.test.ts's fake-client coverage, not a duplicate.
 */
import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
