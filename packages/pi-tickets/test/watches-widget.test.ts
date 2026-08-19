import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AutoRotatingWindow } from "malevich-tui-components";
import { buildWatchesWidgetProjection, renderWatchesWidgetLines } from "../src/watches-widget.ts";

const theme = { fg: (_color: string, text: string) => text } as { fg(color: string, text: string): string };

function rotation(pageSize: number, totalRows: number, now: () => number = () => 0): AutoRotatingWindow {
  return new AutoRotatingWindow({ totalRows, pageSize, intervalMs: 1000, now });
}

describe("buildWatchesWidgetProjection", () => {
  it("returns zero rows for no watches at all", () => {
    expect(buildWatchesWidgetProjection([], [])).toEqual({ rows: [], total: 0 });
  });

  it("merges issue and query watches into one projection, each tagged with its own kind", () => {
    const projection = buildWatchesWidgetProjection([{ ref: "jira:CNF-1" }, { ref: "github:#2" }], [{ name: "my-saved-query" }]);
    expect(projection.total).toBe(3);
    expect(projection.rows).toEqual([
      { kind: "issue", key: "jira:CNF-1" },
      { kind: "issue", key: "github:#2" },
      { kind: "query", key: "my-saved-query" },
    ]);
  });
});

describe("renderWatchesWidgetLines", () => {
  it("returns no lines at all (hides the widget) when there are no watches", () => {
    expect(renderWatchesWidgetLines(theme, buildWatchesWidgetProjection([], []), 80)).toEqual([]);
  });

  it("renders a bordered card naming the owning Vehicle, the widget, and the watch count, plus one line per watch", () => {
    const projection = buildWatchesWidgetProjection([{ ref: "jira:CNF-1" }], [{ name: "my-query" }]);
    const lines = renderWatchesWidgetLines(theme, projection, 80);
    expect(lines[0]).toContain("Tickets · Watches · 2");
    expect(lines[0]).toContain("╭");
    expect(lines[lines.length - 1]).toContain("╰");
    expect(lines.some((line) => line.includes("jira:CNF-1"))).toBe(true);
    expect(lines.some((line) => line.includes("my-query"))).toBe(true);
  });

  it("distinguishes an issue row from a query row visually", () => {
    const projection = buildWatchesWidgetProjection([{ ref: "jira:CNF-1" }], [{ name: "my-query" }]);
    const lines = renderWatchesWidgetLines(theme, projection, 80);
    const issueLine = lines.find((line) => line.includes("jira:CNF-1"))!;
    const queryLine = lines.find((line) => line.includes("my-query"))!;
    expect(issueLine).not.toBe(queryLine);
  });

  it("never produces a line wider than the given width", () => {
    const projection = buildWatchesWidgetProjection([{ ref: "x".repeat(200) }], []);
    for (const width of [40, 80, 120]) {
      for (const line of renderWatchesWidgetLines(theme, projection, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  describe("auto-rotating overflow hint", () => {
    it("never shows a page hint when every watch already fits on one page", () => {
      const projection = buildWatchesWidgetProjection([{ ref: "a" }], []);
      const lines = renderWatchesWidgetLines(theme, projection, 80, rotation(5, 1));
      expect(lines[0]).not.toMatch(/\d\/\d ⟳/);
    });

    it("shows a page/total rotation hint once watches genuinely outgrow one page, and pages through them as the clock advances", () => {
      const issueWatches = Array.from({ length: 5 }, (_, i) => ({ ref: `ref-${i}` }));
      const projection = buildWatchesWidgetProjection(issueWatches, []);
      let now = 0;
      const paging = rotation(2, 5, () => now);

      const page1 = renderWatchesWidgetLines(theme, projection, 80, paging);
      expect(page1[0]).toMatch(/1\/3 ⟳/);

      now = 1000;
      const page2 = renderWatchesWidgetLines(theme, projection, 80, paging);
      expect(page2[0]).toMatch(/2\/3 ⟳/);
    });
  });
});
