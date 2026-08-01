import { describe, expect, it, mock } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";
import { BackendTabGroupComponent } from "../src/backend-tab-group.js";
import type { ScopedTab } from "../src/tab-dispatch.js";

const theme = { tab: (s: string) => s, activeTab: (s: string) => s, mnemonic: (s: string) => s };

function fakeLeaf(lines: string[] = ["leaf"]): Component & { handleInput: ReturnType<typeof mock> } {
  return { render: () => lines, invalidate: () => {}, handleInput: mock(() => {}) };
}

function threeTabs(overrides: Partial<Record<"issues" | "queries" | "board", Partial<ScopedTab>>> = {}): ScopedTab[] {
  return [
    { key: "issues", label: "Issues", mnemonic: "i", content: fakeLeaf(["issues"]), ...overrides.issues },
    { key: "queries", label: "Queries", mnemonic: "q", content: fakeLeaf(["queries"]), ...overrides.queries },
    { key: "board", label: "Board", mnemonic: "b", content: fakeLeaf(["board"]), ...overrides.board },
  ];
}

describe("BackendTabGroupComponent", () => {
  it("starts on its first tab and renders its own tab bar plus that tab's content", () => {
    const group = new BackendTabGroupComponent(threeTabs(), theme);
    expect(group.render(40).join("\n")).toContain("issues");
  });

  it("Left/Right cycle its own three tabs, wrapping", () => {
    const group = new BackendTabGroupComponent(threeTabs(), theme);
    group.handleInput("\x1b[C"); // issues -> queries
    expect(group.render(40).join("\n")).toContain("queries");
    group.handleInput("\x1b[C"); // -> board
    expect(group.render(40).join("\n")).toContain("board");
    group.handleInput("\x1b[C"); // wraps -> issues
    expect(group.render(40).join("\n")).toContain("issues");
  });

  it("delegates Left/Right straight to the active leaf when it captures them, instead of cycling away from it", () => {
    const boardLeaf = fakeLeaf(["board"]);
    const group = new BackendTabGroupComponent(threeTabs({ board: { content: boardLeaf, capturesHorizontalArrows: () => true } }), theme);
    group.handleInput("\x1b[C"); // issues -> queries
    group.handleInput("\x1b[C"); // queries -> board
    boardLeaf.handleInput.mockClear();

    group.handleInput("\x1b[C"); // captured -- should reach the leaf, not cycle back to issues

    expect(group.render(40).join("\n")).toContain("board"); // still on board
    expect(boardLeaf.handleInput).toHaveBeenCalledWith("\x1b[C");
  });

  it("a mnemonic jumps directly to that sub-tab", () => {
    const group = new BackendTabGroupComponent(threeTabs(), theme);
    group.handleInput("b");
    expect(group.render(40).join("\n")).toContain("board");
  });

  describe("capturesEscape", () => {
    it("is false at its own home with nothing captured -- lets the outer panel take over", () => {
      const group = new BackendTabGroupComponent(threeTabs(), theme);
      expect(group.capturesEscape()).toBe(false);
    });

    it("is true when not on its own home tab", () => {
      const group = new BackendTabGroupComponent(threeTabs(), theme);
      group.handleInput("\x1b[C");
      expect(group.capturesEscape()).toBe(true);
    });

    it("is true when the active leaf itself captures escape, even while on the group's own home", () => {
      const group = new BackendTabGroupComponent(threeTabs({ issues: { capturesEscape: () => true } }), theme);
      expect(group.capturesEscape()).toBe(true);
    });

    it("escape returns a non-home tab to the group's own home, without leaving the group", () => {
      const group = new BackendTabGroupComponent(threeTabs(), theme);
      group.handleInput("\x1b[C"); // -> queries
      group.handleInput("\x1b"); // escape -- not captured by queries -- back to issues
      expect(group.render(40).join("\n")).toContain("issues");
    });
  });

  it("capturesHorizontalArrows and capturesTabCycle are always true -- the group always owns these away from the outer panel", () => {
    const group = new BackendTabGroupComponent(threeTabs(), theme);
    expect(group.capturesHorizontalArrows()).toBe(true);
    expect(group.capturesTabCycle()).toBe(true);
  });

  it("capturesMnemonics reflects the active leaf's own claim", () => {
    const group = new BackendTabGroupComponent(threeTabs({ issues: { capturesMnemonics: () => true } }), theme);
    expect(group.capturesMnemonics()).toBe(true);
    group.handleInput("\x1b[C"); // -> queries, which doesn't capture
    expect(group.capturesMnemonics()).toBe(false);
  });

  it("invalidate delegates to its own container", () => {
    const group = new BackendTabGroupComponent(threeTabs(), theme);
    expect(() => group.invalidate()).not.toThrow();
  });
});
