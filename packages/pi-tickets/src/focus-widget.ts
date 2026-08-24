/**
 * Pure projection/render pair for the Focus widget -- mirrors watches-widget.ts's own split: a
 * TicketFocusState-shaped input in, a bounded string[] of rendered lines out, no I/O, no TUI,
 * fully unit-testable without a real daemon or terminal. See focus-overlay.ts for the stateful
 * ctx.ui.setWidget-registered class that drives this from focus.get, the same authenticated,
 * session-scoped call tui.ts's own refreshStatus makes on session start and after every own
 * tool call.
 */
import { vehicleWidgetTitle } from "@danypops/vehicle-client-pi/widget-header";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderCardRow, type TextMeasure } from "malevich-tui-components";

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** The daemon's own manifest name (see agent-tools/tickets-vehicle.ts's `new VehicleRegistry({ name: "tickets" })`). */
const VEHICLE_NAME = "tickets";

/** Minimal shape this widget needs from TicketFocusState -- avoids a hard dependency on
 * @danypops/tickets' own domain type for four field names. */
export interface FocusWidgetLike {
  ref: string;
  title: string;
  url: string;
  status: "active" | "paused";
  pauseReason?: string;
}

/** "Tickets · Focus" while active, "Tickets · Focus · paused" once paused. */
function focusCardLabel(focus: FocusWidgetLike): string {
  return focus.status === "paused" ? vehicleWidgetTitle(VEHICLE_NAME, "Focus", "paused") : vehicleWidgetTitle(VEHICLE_NAME, "Focus");
}

function focusLines(theme: { fg(color: string, text: string): string }, focus: FocusWidgetLike, width: number): string[] {
  const glyph = focus.status === "paused" ? "\u23f8" : "\ud83c\udfaf";
  const lines = [truncateToWidth(theme.fg("accent", `${glyph} ${focus.ref} \u2014 ${focus.title}`), width, "\u2026")];
  if (focus.url) lines.push(truncateToWidth(theme.fg("muted", focus.url), width, "\u2026"));
  if (focus.status === "paused" && focus.pauseReason) {
    lines.push(truncateToWidth(theme.fg("muted", `Paused: ${focus.pauseReason}`), width, "\u2026"));
  }
  return lines;
}

/** Renders the widget as a single bordered card -- `[]` (hide the whole widget) when nothing is
 * focused, matching every other overlay's own "hide when nothing to show" convention. */
export function renderFocusWidgetLines(
  theme: { fg(color: string, text: string): string },
  focus: FocusWidgetLike | null,
  width: number,
): string[] {
  if (!focus) return [];
  return renderCardRow(
    [
      {
        label: focusCardLabel(focus),
        render: (innerWidth: number) => focusLines(theme, focus, innerWidth),
      },
    ],
    width,
    { measure, frameStyle: (s) => theme.fg("borderMuted", s) },
  );
}
