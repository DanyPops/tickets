/**
 * Adopts @danypops/vehicle-conformance's dual-channel matrix against pi-tickets' real
 * production rendering path (renderTicketsResult/renderTicketsCall/projectTicketsPresentation)
 * -- proves this consumer's own bespoke rendering (layered on top of the generic Shell via its
 * `presentations()`/`renderers()` extensibility hooks, see doc 4e9e08c1 Finding 5) is conformant,
 * not just the inherited generic default renderer.
 */
import { assertJsonSafePresentation } from "@danypops/vehicle-client-pi/vehicle-render-model";
import { runToolShellDualChannelConformance, type ToolShellDualChannelFixture } from "@danypops/vehicle-conformance";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { createTicketsErrorPresentation, projectTicketsPresentation, TICKETS_PRESENTATION_MAX_BYTES } from "../src/presentation.js";
import { renderTicketsCall, renderTicketsResult } from "../src/vehicle-client.js";

// A real Theme emitting real ANSI SGR escapes -- required because the conformance suite's own
// physical-line-width assertion strips real ANSI via a CSI regex before counting visible width.
const REAL_FG_COLORS: Record<ThemeColor, string> = {
  accent: "#ee0000",
  border: "#4d4d4d",
  borderAccent: "#ee0000",
  borderMuted: "#383838",
  success: "#6c9b4b",
  error: "#bd6e51",
  warning: "#dca614",
  muted: "#8f8f8f",
  dim: "#757575",
  text: "#e0e0e0",
  thinkingText: "#8f8f8f",
  searchMatchText: "#8f8f8f",
  userMessageText: "#e0e0e0",
  customMessageText: "#e0e0e0",
  customMessageLabel: "#876fd4",
  toolTitle: "#d39292",
  toolOutput: "#e0e0e0",
  mdHeading: "#e0e0e0",
  mdLink: "#0066cc",
  mdLinkUrl: "#0066cc",
  mdCode: "#e0e0e0",
  mdCodeBlock: "#e0e0e0",
  mdCodeBlockBorder: "#383838",
  mdQuote: "#8f8f8f",
  mdQuoteBorder: "#383838",
  mdHr: "#383838",
  mdListBullet: "#e0e0e0",
  toolDiffAdded: "#6c9b4b",
  toolDiffRemoved: "#bd6e51",
  toolDiffContext: "#8f8f8f",
  syntaxComment: "#8f8f8f",
  syntaxKeyword: "#876fd4",
  syntaxFunction: "#63bdbd",
  syntaxVariable: "#e0e0e0",
  syntaxString: "#6c9b4b",
  syntaxNumber: "#dca614",
  syntaxType: "#63bdbd",
  syntaxOperator: "#e0e0e0",
  syntaxPunctuation: "#e0e0e0",
  thinkingOff: "#8f8f8f",
  thinkingMinimal: "#8f8f8f",
  thinkingLow: "#8f8f8f",
  thinkingMedium: "#8f8f8f",
  thinkingHigh: "#8f8f8f",
  thinkingXhigh: "#8f8f8f",
  thinkingMax: "#8f8f8f",
  bashMode: "#e0e0e0",
};

const REAL_BG_COLORS = {
  selectedBg: "#292929",
  userMessageBg: "#1f1f1f",
  customMessageBg: "#1b0d33",
  toolPendingBg: "#1f1f1f",
  toolSuccessBg: "#1d2b12",
  toolErrorBg: "#4c1405",
};

const theme = new Theme(REAL_FG_COLORS, REAL_BG_COLORS, "truecolor");
initTheme();

/** One representative real operation per TicketsPresentation["kind"] -- the actual discriminator
 * renderTicketsResult dispatches on (list -> table, board -> board view, everything else -> a
 * single styled line via formatTicketsPresentation). */
const OPERATION_FOR_KIND: Record<string, string> = {
  list: "issue.children",
  board: "issue.list",
  detail: "issue.get",
  mutation: "issue.create",
  summary: "discover.template",
  error: "issue.get",
};

function presentationFor(kind: string, rawPayload: unknown) {
  if (kind === "error") return createTicketsErrorPresentation(OPERATION_FOR_KIND[kind]!, "NOT_FOUND", String(rawPayload));
  return projectTicketsPresentation(OPERATION_FOR_KIND[kind]!, rawPayload);
}

function renderResultLines(
  operation: string,
  details: unknown,
  contentText: string,
  options: { width: 40 | 80 | 120; expanded: boolean; partial?: boolean },
) {
  const result = { content: [{ type: "text" as const, text: contentText }], details: details as never };
  return renderTicketsResult(operation, result, theme, false, options.partial ?? false, options.expanded).render(options.width);
}

const fixture: ToolShellDualChannelFixture = {
  label: "pi-tickets",
  async create() {
    const subject = {
      bounds: { modelContentBytes: 4_096, presentationDetailsBytes: TICKETS_PRESENTATION_MAX_BYTES },
      execute: async () => {
        const presentation = projectTicketsPresentation("issue.children", {
          issues: [{ ref: "T-1", title: "PRESENTATION_ONLY row", status: "open" }],
        });
        return { content: "MODEL_ONLY: semantic result", details: { presentation } };
      },
      render: (snapshot: { content: string; details: unknown }, options: { width: 40 | 80 | 120; expanded: boolean; partial?: boolean }) =>
        renderResultLines("issue.children", snapshot.details, snapshot.content, options),
      replay: (rawPresentation: unknown, fallbackContent: string, options: { width: 40 | 80 | 120 }) =>
        renderResultLines("issue.children", { presentation: rawPresentation }, fallbackContent, { ...options, expanded: false }),
      renderCall: (args: unknown, width: 40 | 80 | 120) => renderTicketsCall("issue.get", args, theme).render(width),
      invalidProjection: async () => {
        // The real production analog: vehicle-client-pi's own invoke() pathway validates every
        // custom projector's output (see tool-creation.ts's presentationProjector) through this
        // exact function before persisting it -- a cyclic value fails it the same way regardless
        // of which consumer supplied the projector.
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        assertJsonSafePresentation(cyclic, TICKETS_PRESENTATION_MAX_BYTES);
      },
      // One representative raw payload per TicketsPresentation["kind"] -- proves the real
      // projector+renderer pipeline differentiates every declared kind instead of collapsing most
      // of them into an undifferentiated raw-JSON dump (the pi-web-spider bug class, generalized).
      declaredValueCases: [
        { value: "list", rawPayload: { issues: [{ ref: "T-1", title: "First issue", status: "open" }] } },
        { value: "board", rawPayload: { issues: [{ ref: "T-2", title: "A pull request", pullRequest: { draft: false } }] } },
        { value: "detail", rawPayload: { issue: { ref: "T-3", title: "Detail issue", status: "open" } } },
        { value: "mutation", rawPayload: { issue: { ref: "T-4", title: "New issue" } } },
        { value: "summary", rawPayload: {} },
        { value: "error", rawPayload: "Issue not found" },
      ],
      renderDeclaredValue: (value: string, rawPayload: unknown, options: { width: 40 | 80 | 120; expanded: boolean }) =>
        renderResultLines(OPERATION_FOR_KIND[value]!, { presentation: presentationFor(value, rawPayload) }, "MODEL_ONLY", options),
    };
    return { subject, cleanup: () => Promise.resolve() };
  },
};

runToolShellDualChannelConformance(fixture);
