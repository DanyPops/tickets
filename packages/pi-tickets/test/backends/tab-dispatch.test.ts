import { describe, expect, it, mock } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";
import { asciiTextMeasure, TabbedContainer } from "malevich-tui-components";
import { activeScopedTab, handleHorizontalArrow, handleMnemonicJump, type ScopedTab } from "../../src/backends/tab-dispatch.js";

const theme = { tab: (s: string) => s, activeTab: (s: string) => s, mnemonic: (s: string) => s };

function fakeLeaf(): Component & { handleInput: ReturnType<typeof mock> } {
  return { render: () => ["leaf"], invalidate: () => {}, handleInput: mock(() => {}) };
}

function buildContainer(tabs: ScopedTab[], initialKey?: string) {
  const container = new TabbedContainer({ tabs, theme, measure: asciiTextMeasure, initialKey });
  const tabByKey = new Map(tabs.map((t) => [t.key, t] as const));
  return { container, tabByKey };
}

describe("handleHorizontalArrow", () => {
  it("delegates straight to the active tab's own content when it captures the key, bypassing TabbedContainer's own cycle-on-arrow", () => {
    const leaf = fakeLeaf();
    const other: ScopedTab = { key: "a", label: "A", content: fakeLeaf() };
    const capturing: ScopedTab = { key: "b", label: "B", content: leaf, capturesHorizontalArrows: () => true };
    const { container, tabByKey } = buildContainer([other, capturing], "b");

    handleHorizontalArrow(container, activeScopedTab(container, tabByKey), "\x1b[C");

    expect(container.getActiveKey()).toBe("b"); // did NOT cycle away
    expect(leaf.handleInput).toHaveBeenCalledWith("\x1b[C");
  });

  it("cycles the container's own tabs when the active tab doesn't capture the key", () => {
    const other: ScopedTab = { key: "a", label: "A", content: fakeLeaf() };
    const nonCapturing: ScopedTab = { key: "b", label: "B", content: fakeLeaf() };
    const { container, tabByKey } = buildContainer([other, nonCapturing], "b");

    handleHorizontalArrow(container, activeScopedTab(container, tabByKey), "\x1b[C");

    expect(container.getActiveKey()).toBe("a"); // wrapped
  });

  it("this is the real regression this module exists for -- confirmed live: without the explicit delegation above, a captured arrow key still fell through to TabbedContainer.handleInput() and cycled anyway", () => {
    const leaf = fakeLeaf();
    const capturing: ScopedTab = { key: "b", label: "B", content: leaf, capturesHorizontalArrows: () => true };
    const other: ScopedTab = { key: "a", label: "A", content: fakeLeaf() };
    const { container } = buildContainer([other, capturing], "b");

    // The buggy version of this dispatch just called container.handleInput(data)
    // unconditionally -- reproduced here directly to prove the bug is real.
    container.handleInput("\x1b[C");
    expect(container.getActiveKey()).not.toBe("b"); // proves the bug existed
  });
});

describe("handleMnemonicJump", () => {
  it("jumps to the tab whose mnemonic matches and returns true", () => {
    const a: ScopedTab = { key: "a", label: "A", mnemonic: "x", content: fakeLeaf() };
    const b: ScopedTab = { key: "b", label: "B", mnemonic: "y", content: fakeLeaf() };
    const { container, tabByKey } = buildContainer([a, b], "a");

    const handled = handleMnemonicJump(container, activeScopedTab(container, tabByKey), "y");

    expect(handled).toBe(true);
    expect(container.getActiveKey()).toBe("b");
  });

  it("returns false and does nothing for a key with no matching mnemonic", () => {
    const a: ScopedTab = { key: "a", label: "A", mnemonic: "x", content: fakeLeaf() };
    const { container, tabByKey } = buildContainer([a], "a");

    expect(handleMnemonicJump(container, activeScopedTab(container, tabByKey), "z")).toBe(false);
    expect(container.getActiveKey()).toBe("a");
  });

  it("returns false when the active tab wants every printable key for itself", () => {
    const a: ScopedTab = { key: "a", label: "A", mnemonic: "x", content: fakeLeaf(), capturesMnemonics: () => true };
    const b: ScopedTab = { key: "b", label: "B", mnemonic: "y", content: fakeLeaf() };
    const { container, tabByKey } = buildContainer([a, b], "a");

    expect(handleMnemonicJump(container, activeScopedTab(container, tabByKey), "y")).toBe(false);
    expect(container.getActiveKey()).toBe("a");
  });

  it("returns false for a multi-character key (an escape sequence, not a real mnemonic press)", () => {
    const a: ScopedTab = { key: "a", label: "A", content: fakeLeaf() };
    const { container, tabByKey } = buildContainer([a], "a");

    expect(handleMnemonicJump(container, activeScopedTab(container, tabByKey), "\x1b[C")).toBe(false);
  });

  it("returns false (not a real jump) when the mnemonic resolves to the tab that's already active", () => {
    const a: ScopedTab = { key: "a", label: "A", mnemonic: "x", content: fakeLeaf() };
    const { container, tabByKey } = buildContainer([a], "a");

    expect(handleMnemonicJump(container, activeScopedTab(container, tabByKey), "x")).toBe(false);
  });
});
