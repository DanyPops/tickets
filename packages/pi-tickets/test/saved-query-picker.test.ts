import { describe, expect, it, mock } from "bun:test";
import type { TicketsRpcClient } from "@danypops/tickets";
import { SavedQueryPickerComponent } from "../src/saved-query-picker.js";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as import("@earendil-works/pi-coding-agent").Theme;

function fakeTui() {
  return { terminal: { rows: 40 }, requestRender: mock(() => {}) } as unknown as import("@earendil-works/pi-tui").TUI;
}

function fakeClient(queries: { name: string; backend: string; query: string; description?: string }[]): TicketsRpcClient {
  return { call: mock(() => Promise.resolve({ queries })) } as unknown as TicketsRpcClient;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SavedQueryPickerComponent", () => {
  it("renders no top/bottom rule of its own -- always hosted inside the persistent panel's own Envelope", async () => {
    const client = fakeClient([{ name: "sprint", backend: "jira", query: "..." }]);
    const picker = new SavedQueryPickerComponent(fakeTui(), fakeTheme, client, "jira", "Jira", () => {});
    await tick();
    const lines = picker.render(20);
    expect(lines[0]).toBe("Saved queries"); // title first, no rule line before it
    expect(lines.every((l) => l !== "\u2500".repeat(20))).toBe(true);
  });

  it("renders an inline empty-state message when the backend has no saved queries", async () => {
    const client = fakeClient([]);
    const picker = new SavedQueryPickerComponent(fakeTui(), fakeTheme, client, "jira", "Jira", () => {});
    await tick();
    expect(picker.render(80).join("\n")).toContain("No saved queries yet for Jira");
  });

  it("filters queries down to the given backend", async () => {
    const client = fakeClient([{ name: "gh", backend: "github", query: "..." }, { name: "sprint", backend: "jira", query: "..." }]);
    const picker = new SavedQueryPickerComponent(fakeTui(), fakeTheme, client, "jira", "Jira", () => {});
    await tick();
    const rendered = picker.render(80).join("\n");
    expect(rendered).toContain("sprint");
    expect(rendered).not.toContain("gh");
  });

  it("invokes onPick with the selected query's name on enter", async () => {
    const client = fakeClient([{ name: "sprint", backend: "jira", query: "..." }]);
    let picked: string | undefined;
    const picker = new SavedQueryPickerComponent(fakeTui(), fakeTheme, client, "jira", "Jira", (name) => { picked = name; });
    await tick();
    picker.handleInput("\r");
    expect(picked).toBe("sprint");
  });
});
