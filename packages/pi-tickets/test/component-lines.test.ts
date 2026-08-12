import { describe, expect, it } from "bun:test";
import { guardedNeutralizeEmbeddedFullResets, truncateToWidth } from "../src/component-lines.js";

describe("truncateToWidth", () => {
  it("applies the real malevich-tui-components neutralization when it's genuinely available", () => {
    const result = truncateToWidth("hello world", 5);
    expect(result.startsWith("he")).toBe(true);
    // The whole point of neutralizeEmbeddedFullResets: pi-tui's own truncateToWidth always embeds
    // a literal full SGR reset (\x1b[0m), which would kill an outer component's background paint
    // early -- the real dependency must have replaced it with something background-safe.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting a real escape sequence is absent, not present
    expect(result).not.toMatch(/\x1b\[0m/);
  });
});

/**
 * Reproduces a real production crash: a long-running process resolved an older in-memory copy
 * of malevich-tui-components (loaded before neutralizeEmbeddedFullResets existed there) while
 * this package's own code -- reloaded more recently -- still called it unconditionally. The
 * resulting TypeError was thrown three frames deep inside a render call, with no containment
 * anywhere in the render tree, and took the whole Pi session down.
 */
describe("guardedNeutralizeEmbeddedFullResets", () => {
  it("degrades to the unguarded text instead of throwing when the dependency resolves without the export", () => {
    expect(guardedNeutralizeEmbeddedFullResets("hello", undefined)).toBe("hello");
  });

  it("still calls a real function when one is genuinely available", () => {
    const upper = (value: string) => value.toUpperCase();
    expect(guardedNeutralizeEmbeddedFullResets("hello", upper)).toBe("HELLO");
  });
});
