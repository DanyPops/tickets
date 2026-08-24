import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFocusWidgetLines } from "../src/focus-widget.ts";

const theme = { fg: (_color: string, text: string) => text } as { fg(color: string, text: string): string };

describe("renderFocusWidgetLines", () => {
  it("returns no lines at all (hides the widget) when nothing is focused", () => {
    expect(renderFocusWidgetLines(theme, null, 80)).toEqual([]);
  });

  it("renders a bordered card naming the owning Vehicle, the widget, the ref/title, and the ticket URL", () => {
    const lines = renderFocusWidgetLines(
      theme,
      { ref: "github:#1", title: "First bug", url: "https://github.com/a/b/issues/1", status: "active" },
      80,
    );
    expect(lines[0]).toContain("Tickets \u00b7 Focus");
    expect(lines[0]).toContain("\u256d");
    expect(lines[lines.length - 1]).toContain("\u2570");
    expect(lines.some((line) => line.includes("github:#1"))).toBe(true);
    expect(lines.some((line) => line.includes("First bug"))).toBe(true);
    expect(lines.some((line) => line.includes("https://github.com/a/b/issues/1"))).toBe(true);
  });

  it("marks the card paused and shows the pause reason once paused", () => {
    const lines = renderFocusWidgetLines(
      theme,
      { ref: "jira:PROJ-1", title: "Second bug", url: "https://x", status: "paused", pauseReason: "waiting on review" },
      80,
    );
    expect(lines[0]).toContain("Focus \u00b7 paused");
    expect(lines.some((line) => line.includes("waiting on review"))).toBe(true);
  });

  it("never produces a line wider than the given width", () => {
    const focus = { ref: "x".repeat(100), title: "y".repeat(100), url: "https://example.com/".padEnd(200, "z"), status: "active" as const };
    for (const width of [40, 80, 120]) {
      for (const line of renderFocusWidgetLines(theme, focus, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
