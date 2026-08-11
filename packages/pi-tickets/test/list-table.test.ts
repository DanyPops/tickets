import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderTicketsListTable, statusStyle } from "../src/list-table.js";
import { TICKETS_PRESENTATION_SCHEMA, type TicketsPresentation } from "../src/presentation.js";

/** Identity theme, matching render.test.ts's own fake -- asserts on content, not color codes. */
const fakeTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

type ListPresentation = Extract<TicketsPresentation, { kind: "list" }>;

function listPresentation(overrides: Partial<ListPresentation> = {}): ListPresentation {
  return {
    schemaVersion: TICKETS_PRESENTATION_SCHEMA,
    operation: "issue.list",
    kind: "list",
    title: "Issues",
    completeness: { total: 2, returned: 2, omitted: 0 },
    omissions: [],
    rows: [
      { id: "github:#1", label: "Fix the thing", status: "todo", metadata: ["high", "alice"] },
      { id: "github:#2", label: "Add the feature", status: "done", metadata: ["low"] },
    ],
    ...overrides,
  };
}

function renderText(list: ListPresentation, expanded = false, width = 100): string {
  return renderTicketsListTable(list, fakeTheme, expanded).render(width).join("\n");
}

/** Tags color tokens visibly (`<token>text</token>`) instead of stripping them, so a status-color test can assert on which token was chosen. */
const taggingTheme = {
  fg: (color: string, text: string) => (text ? `<${color}>${text}</${color}>` : text),
  bold: (text: string) => text,
} as unknown as Theme;

describe("renderTicketsListTable", () => {
  it("renders real aligned columns (Ref/Title/Status/Details), not raw Issue fields", () => {
    const text = renderText(listPresentation());
    expect(text).toContain("Ref");
    expect(text).toContain("Title");
    expect(text).toContain("Status");
    expect(text).toContain("Details");
    // Never a raw-field dump -- no Issue-only fields (rawStatus/url/createdAt/pullRequest/...) leak in.
    expect(text).not.toContain("rawStatus");
    expect(text).not.toContain("pullRequest");
    expect(text).not.toContain("createdAt");
  });

  it("renders every row's id, label, status, and joined metadata", () => {
    const text = renderText(listPresentation());
    expect(text).toContain("github:#1");
    expect(text).toContain("Fix the thing");
    expect(text).toContain("todo");
    expect(text).toContain("high");
    expect(text).toContain("alice");
    expect(text).toContain("github:#2");
    expect(text).toContain("Add the feature");
    expect(text).toContain("done");
  });

  it("shows a leading title/count line", () => {
    const text = renderText(listPresentation({ completeness: { total: 7, returned: 2, omitted: 5 } }));
    expect(text.split("\n")[0]).toContain("Issues (7)");
  });

  it("appends a trailing omissions/completeness line reusing presentation.ts's own omissionLine", () => {
    const text = renderText(listPresentation({ completeness: { total: 25, returned: 20, omitted: 5 }, omissions: ["description"] }));
    expect(text).toContain("5 row(s) omitted");
    expect(text).toContain("omitted: description");
  });

  it("adds no trailing annotation line when nothing was omitted", () => {
    const text = renderText(listPresentation());
    const lines = text.split("\n");
    expect(lines.some((l) => l.includes("omitted"))).toBe(false);
  });

  it("shows a plain empty-state message, not an empty table, when there are no rows", () => {
    const text = renderText(listPresentation({ rows: [], completeness: { total: 0, returned: 0, omitted: 0 } }));
    expect(text.toLowerCase()).toContain("no issues");
    expect(text).not.toContain("Ref");
  });

  it("bounds rows to the default visible cap and appends a 'more' line when collapsed", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `github:#${i}`, label: `Issue ${i}`, status: "todo", metadata: [] }));
    const text = renderText(listPresentation({ rows, completeness: { total: 25, returned: 25, omitted: 0 } }), false);
    expect(text).toContain("github:#0");
    expect(text).toContain("github:#19");
    expect(text).not.toContain("github:#20");
    expect(text).toContain("more row");
  });

  it("shows every row with no 'more' line when expanded", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `github:#${i}`, label: `Issue ${i}`, status: "todo", metadata: [] }));
    const text = renderText(listPresentation({ rows, completeness: { total: 25, returned: 25, omitted: 0 } }), true);
    expect(text).toContain("github:#24");
    expect(text).not.toContain("more row");
  });

  it("never renders a line wider than the given width, regardless of column content", () => {
    const rows = [{ id: "github:#1", label: "x".repeat(300), status: "todo", metadata: ["y".repeat(300)] }];
    const lines = renderTicketsListTable(listPresentation({ rows }), fakeTheme, false).render(40);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("never leaves a truncated cell's embedded SGR reset able to kill an outer Box's background mid-line", () => {
    const rows = [{ id: "github:#1", label: "x".repeat(300), status: "todo", metadata: ["y".repeat(300)] }];
    const lines = renderTicketsListTable(listPresentation({ rows }), fakeTheme, false).render(40);
    for (const line of lines) expect(line).not.toContain("\x1b[0m");
  });

  describe("semantic status coloring", () => {
    function escapeRegExp(value: string): string {
      return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function statusToken(status: string): string {
      const rows = [{ id: "github:#1", label: "a distinct title", status, metadata: [] }];
      const text = renderTicketsListTable(listPresentation({ rows }), taggingTheme, false).render(100).join("\n");
      const match = new RegExp(`<(\\w+)>${escapeRegExp(status)}\\s*</\\w+>`).exec(text);
      return match?.[1] ?? "(none)";
    }

    it("maps done/closed/merged-ish statuses to success", () => {
      for (const status of ["done", "closed", "merged", "resolved"]) expect(statusToken(status)).toBe("success");
    });

    it("maps in-progress/open-ish statuses to accent", () => {
      for (const status of ["todo", "open", "in_progress", "in review", "backlog"]) expect(statusToken(status)).toBe("accent");
    });

    it("maps canceled/rejected/blocked-ish statuses to error", () => {
      for (const status of ["canceled", "rejected", "blocked", "won't fix"]) expect(statusToken(status)).toBe("error");
    });

    it("falls back to plain text for an unrecognized or missing status", () => {
      expect(statusToken("triaging")).toBe("text");
    });
  });

  /**
   * statusStyle's own theme-completeness cascade -- distinct from the plain classification
   * above (statusToken, exercised only through fully-distinguishing themes so far). These
   * tests deliberately use a THEME THAT COLLAPSES some tokens onto the same rendering as
   * plain text, the one case none of the tests above (or the renderer's own default
   * fakeTheme/taggingTheme fixtures) ever exercises, to prove the cascade -- not just the
   * classification -- actually does something.
   */
  describe("statusStyle: cascades to a theme-distinguishable token instead of trusting the most specific one blindly", () => {
    /** Every token renders distinctly -- the common case. Picks the primary (most specific) candidate, same as a bare theme.fg(statusToken(status), text) would. */
    const fullyDistinguishingTheme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    } as unknown as Theme;

    /** "success" is defined identically to plain "text" (a theme that never bothered giving it its own color) -- "accent" still is distinct, so the cascade should skip past success to it. */
    const collapsesSuccessOnlyTheme = {
      fg: (color: string, text: string) => (color === "success" || color === "text" ? text : `<${color}>${text}</${color}>`),
      bold: (text: string) => text,
    } as unknown as Theme;

    /** Every candidate collapses onto plain text -- the cascade has nowhere left to go but its own hardcoded ANSI fallback. */
    const collapsesEverythingTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

    it("picks the primary token when the theme already distinguishes it from plain text", () => {
      expect(statusStyle(fullyDistinguishingTheme, "done", "Done")).toBe("<success>Done</success>");
      expect(statusStyle(fullyDistinguishingTheme, "canceled", "Canceled")).toBe("<error>Canceled</error>");
      expect(statusStyle(fullyDistinguishingTheme, "in_progress", "In Progress")).toBe("<accent>In Progress</accent>");
    });

    it("falls through to the next preference-ordered candidate when the primary token collapses onto plain text", () => {
      // success's own candidate list is ["success", "accent"] -- collapsesSuccessOnlyTheme makes
      // the first entry indistinguishable from plain text, so this must land on "accent" instead
      // of silently rendering "Done" with no color at all.
      expect(statusStyle(collapsesSuccessOnlyTheme, "done", "Done")).toBe("<accent>Done</accent>");
    });

    it("falls all the way through to the hardcoded ANSI fallback when every themed candidate collapses onto plain text", () => {
      const styled = statusStyle(collapsesEverythingTheme, "done", "Done");
      expect(styled).not.toBe("Done"); // never silently renders as indistinguishable plain text
      expect(styled).toContain("Done");
      expect(styled.startsWith("\x1b[")).toBe(true);
      expect(styled.endsWith("\x1b[39m")).toBe(true);
    });

    it("never cascades or colors the plain 'text' token, even under a theme that collapses everything -- an unrecognized/absent status should never invent a color", () => {
      expect(statusStyle(fullyDistinguishingTheme, "triaging", "Triaging")).toBe("<text>Triaging</text>");
      expect(statusStyle(collapsesEverythingTheme, "triaging", "Triaging")).toBe("Triaging");
      expect(statusStyle(collapsesEverythingTheme, undefined, "Triaging")).toBe("Triaging");
    });
  });
});
