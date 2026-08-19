import { describe, expect, it, mock } from "bun:test";
import type { Comment, Issue, IssueLink } from "@danypops/tickets";
import { curatedCustomFields, formatDescriptionLines, IssueDetailComponent } from "../../src/issues/issue-detail-view.js";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as import("@earendil-works/pi-coding-agent").Theme;

function fakeTui(rows = 40) {
  return { terminal: { rows }, requestRender: mock(() => {}) } as unknown as import("@earendil-works/pi-tui").TUI;
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return { ref: "jira:ENG-1", id: "1", key: "ENG-1", title: "Sample issue", status: "todo", priority: "high", ...overrides };
}

describe("IssueDetailComponent", () => {
  it("frames the view with a full-width border rule top and bottom, so it reads as a distinct overlay", () => {
    const view = new IssueDetailComponent(fakeTui(), fakeTheme, issue(), [], () => {});
    const lines = view.render(80);
    expect(lines[0]).toBe("\u2500".repeat(80));
    expect(lines.at(-1)).toBe("\u2500".repeat(80));
  });

  it("never renders more lines than the terminal has, even with far more content than fits -- the closing border always stays on screen", () => {
    // Below the visible-rows MAX cap, so this genuinely exercises
    // DETAIL_RESERVED_ROWS rather than being masked by the ceiling.
    const longComments: Comment[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      body: `Comment body ${i}`,
      author: `User ${i}`,
    }));
    const view = new IssueDetailComponent(fakeTui(20), fakeTheme, issue(), longComments, () => {});

    const lines = view.render(100);

    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.at(-1)).toBe("\u2500".repeat(100));
  });

  it("renders the key/title, the epic and project in a breadcrumb, and status/type/priority/people in a header summary line -- not a same-weight field list", () => {
    const view = new IssueDetailComponent(
      fakeTui(),
      fakeTheme,
      issue({
        project: "ENG",
        assignee: "Jane Doe",
        reporter: "John Roe",
        issueType: "Story",
        parent: { key: "ENG-100", title: "Epic One" },
        labels: ["a", "b"],
      }),
      [],
      () => {},
    );
    const rendered = view.render(100).join("\n");
    expect(rendered).toContain("ENG / ENG-100 Epic One / ENG-1");
    expect(rendered).toContain("ENG-1  Sample issue");
    expect(rendered).toContain("[todo]");
    expect(rendered).toContain("Story");
    expect(rendered).toContain("high");
    expect(rendered).toContain("Jane Doe (assignee)");
    expect(rendered).toContain("John Roe (reporter)");
    expect(rendered).toContain("Labels: a, b");
    // Moved to the header -- must not also appear as a redundant flat field row.
    expect(rendered).not.toContain("Assignee: Jane Doe");
    expect(rendered).not.toContain("Epic: ENG-100");
  });

  it("renders the description (Jira wiki markup formatted) and every comment with its author", () => {
    const comments: Comment[] = [
      { id: "1", body: "First comment", author: "Alice", createdAt: "2024-01-01" },
      { id: "2", body: "Second comment", author: "Bob", createdAt: "2024-01-02" },
    ];
    const view = new IssueDetailComponent(fakeTui(), fakeTheme, issue({ description: "The full description." }), comments, () => {});
    const rendered = view.render(100).join("\n");
    expect(rendered).toContain("Description");
    expect(rendered).toContain("The full description.");
    expect(rendered).toContain("Comments (2):");
    expect(rendered).toContain("Alice");
    expect(rendered).toContain("First comment");
    expect(rendered).toContain("Bob");
    expect(rendered).toContain("Second comment");
  });

  it("renders linked issues as their own section, status-chip colored", () => {
    const issueLinks: IssueLink[] = [
      {
        type: "relates to",
        direction: "outward",
        targetRef: "jira:ENG-2",
        targetKey: "ENG-2",
        targetTitle: "Other work",
        targetStatus: "Closed",
      },
    ];
    const view = new IssueDetailComponent(fakeTui(), fakeTheme, issue({ issueLinks }), [], () => {});
    const rendered = view.render(100).join("\n");
    expect(rendered).toContain("Linked issues");
    expect(rendered).toContain("relates to");
    expect(rendered).toContain("ENG-2");
    expect(rendered).toContain("Other work");
    expect(rendered).toContain("[Closed]");
  });

  it("omits the linked-issues section entirely when there are none", () => {
    const view = new IssueDetailComponent(fakeTui(), fakeTheme, issue(), [], () => {});
    expect(view.render(100).join("\n")).not.toContain("Linked issues");
  });

  it("renders curated custom fields as a Details section, dropping Jira-internal bookkeeping", () => {
    const view = new IssueDetailComponent(
      fakeTui(),
      fakeTheme,
      issue({
        customFields: {
          "Story Points": "5",
          Sprint: "Sprint 1",
          Rank: "0|abc:",
          Development: "{}",
        },
      }),
      [],
      () => {},
    );
    const rendered = view.render(100).join("\n");
    expect(rendered).toContain("Details");
    expect(rendered).toContain("Story Points: 5");
    expect(rendered).toContain("Sprint: Sprint 1");
    expect(rendered).not.toContain("Rank");
    expect(rendered).not.toContain("Development");
  });

  it("always shows the scroll keys in the footer, even when everything already fits on screen", () => {
    const view = new IssueDetailComponent(fakeTui(), fakeTheme, issue(), [], () => {});
    const rendered = view.render(100).join("\n");
    expect(rendered).toContain("\u2191/\u2193 scroll");
    expect(rendered).toContain("pgup/pgdn page");
    expect(rendered).not.toMatch(/\d+-\d+\/\d+/); // no position indicator when nothing to scroll
  });

  it("omits the comments section entirely when there are none", () => {
    const view = new IssueDetailComponent(fakeTui(), fakeTheme, issue(), [], () => {});
    expect(view.render(100).join("\n")).not.toContain("Comments");
  });

  it("QoL: wraps the footer's own url in a clickable OSC 8 hyperlink when the issue has one, shows nothing there otherwise", () => {
    const withUrl = new IssueDetailComponent(fakeTui(), fakeTheme, issue({ url: "https://issues.redhat.com/browse/ENG-1" }), [], () => {});
    const rendered = withUrl.render(100).join("\n");
    expect(rendered).toContain("\x1b]8;;https://issues.redhat.com/browse/ENG-1\x1b\\issues.redhat.com/browse/ENG-1\x1b]8;;\x1b\\");

    const withoutUrl = new IssueDetailComponent(fakeTui(), fakeTheme, issue({ url: undefined }), [], () => {});
    expect(withoutUrl.render(100).join("\n")).not.toContain("]8;;");
  });

  it("escape calls close", () => {
    let closed = false;
    const view = new IssueDetailComponent(fakeTui(), fakeTheme, issue(), [], () => {
      closed = true;
    });
    view.render(100);
    view.handleInput("\x1b");
    expect(closed).toBe(true);
  });

  it("down/up scroll within bounds; scrolling is reflected in the footer position", () => {
    const longComments: Comment[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      body: `Comment body ${i}`,
      author: `User ${i}`,
    }));
    const view = new IssueDetailComponent(fakeTui(15), fakeTheme, issue(), longComments, () => {});
    const before = view.render(100).join("\n");
    expect(before).toContain("1-");
    view.handleInput("\x1b[B"); // down
    const after = view.render(100).join("\n");
    expect(after).toContain("2-");
  });
});

describe("curatedCustomFields", () => {
  it("keeps genuinely useful custom fields exactly as the backend named them", () => {
    expect(curatedCustomFields({ "Story Points": "5", Sprint: "Sprint 1" })).toEqual([
      ["Story Points", "5"],
      ["Sprint", "Sprint 1"],
    ]);
  });

  it("drops named Jira-internal bookkeeping fields regardless of their value", () => {
    expect(curatedCustomFields({ Rank: "0|abc:", "Epic Link": "ENG-100", Development: "{}" })).toEqual([]);
  });

  it("drops an empty JSON placeholder value even under an unrecognized field name", () => {
    expect(curatedCustomFields({ SomeFutureField: "{}", AnotherOne: "[]" })).toEqual([]);
  });

  it("drops a long, whitespace-free opaque token value (e.g. an AI/internal id), regardless of field name", () => {
    const opaque = "rfv1:k1:016011022029015000000000:FjFI4vRDXIGtYHewzEzZdaPH9V2fVxqQyVjaS1sekg29EjebK182eW";
    expect(curatedCustomFields({ "Intelligence Requested": opaque })).toEqual([]);
  });

  it("keeps a short value with no whitespace -- length alone doesn't make something opaque", () => {
    expect(curatedCustomFields({ Blocked: "False", Ready: "True" })).toEqual([
      ["Blocked", "False"],
      ["Ready", "True"],
    ]);
  });

  it("keeps a long value that DOES contain whitespace -- opaqueness is about token shape, not just length", () => {
    const longSentence = "This is a perfectly readable, if unusually long, free-text custom field value someone typed.";
    expect(curatedCustomFields({ Notes: longSentence })).toEqual([["Notes", longSentence]]);
  });

  it("returns nothing for undefined/empty input rather than throwing", () => {
    expect(curatedCustomFields(undefined)).toEqual([]);
    expect(curatedCustomFields({})).toEqual([]);
  });
});

describe("formatDescriptionLines", () => {
  it("turns an 'hN. Heading' line into just the heading text, styled distinctly", () => {
    const calls: Array<{ color: string; text: string }> = [];
    const spyTheme = {
      ...fakeTheme,
      fg: (color: string, text: string) => {
        calls.push({ color, text });
        return text;
      },
    } as typeof fakeTheme;
    const lines = formatDescriptionLines("h2. Done Criteria", spyTheme);
    expect(lines).toEqual(["Done Criteria"]);
    expect(calls.some((call) => call.text === "Done Criteria" && call.color === "accent")).toBe(true);
  });

  it("turns a '* '/'# ' bulleted line into a real bullet character, preserving leading indent", () => {
    expect(formatDescriptionLines("* First point\n  # Nested point", fakeTheme)).toEqual(["\u2022 First point", "  \u2022 Nested point"]);
  });

  it("turns a '[text|url]' link into just the label when it differs from the url, with an arrow marker", () => {
    const lines = formatDescriptionLines("See [the doc|https://example.com/doc]", fakeTheme);
    expect(lines[0]).toContain("the doc");
    expect(lines[0]).toContain("\u2197");
    expect(lines[0]).not.toContain("https://example.com/doc");
  });

  it("turns a '[url|url]' link (label equals url, the common 'Design doc:' shape) into the bare url", () => {
    const url = "https://docs.google.com/document/d/abc/edit";
    const lines = formatDescriptionLines(`Design doc: [${url}|${url}]`, fakeTheme);
    expect(lines[0]).toContain(url);
  });

  it("turns a bare '[PROJ-123]' issue-key reference into an arrow to the ref", () => {
    const lines = formatDescriptionLines("Origin: [CNF-25754]", fakeTheme);
    expect(lines[0]).toContain("\u2192");
    expect(lines[0]).toContain("CNF-25754");
  });

  it("leaves a plain paragraph line untouched aside from any inline constructs", () => {
    expect(formatDescriptionLines("Just a plain sentence.", fakeTheme)).toEqual(["Just a plain sentence."]);
  });

  it("preserves blank lines as genuinely empty strings, never a styled empty string", () => {
    expect(formatDescriptionLines("First.\n\nSecond.", fakeTheme)).toEqual(["First.", "", "Second."]);
  });

  it("never misfires on a GitHub/GitLab-style Markdown description -- no 'hN.' headings or pipe-links there", () => {
    const markdown = "## A markdown heading\n\nSee [a link](https://example.com) for details.";
    const lines = formatDescriptionLines(markdown, fakeTheme);
    // Markdown's own "## " heading syntax is left alone (not a Jira "h2." heading) -- still a
    // plain line, not converted to a bare "A markdown heading" the way "h2. " would be.
    expect(lines[0]).toContain("## A markdown heading");
    // Markdown's own "[text](url)" link syntax has no "|" separator, so the Jira pipe-link
    // pattern doesn't match it -- left exactly as written, not mangled.
    expect(lines[2]).toContain("[a link](https://example.com)");
  });
});
