/**
 * Pure projection/render pair for the Watches widget -- mirrors pi-papyrus's own task-widget.ts /
 * pi-pipes' own jobs-widget.ts split: subscription lists in, a bounded intermediate shape out, no
 * I/O, no TUI, fully unit-testable without a real daemon or terminal. See watches-overlay.ts for
 * the stateful ctx.ui.setWidget-registered class that drives these from issue.subscribed/
 * query.subscribed -- both already exist and are documented "never a live backend call, cheap to
 * call frequently", so this widget needed no new backend operation at all.
 */
import { vehicleWidgetTitle } from "@danypops/vehicle-client-pi/widget-header";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AutoRotatingWindow, renderCardRow, type TextMeasure } from "malevich-tui-components";

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** The daemon's own manifest name (see agent-tools/tickets-vehicle.ts's `new VehicleRegistry({ name: "tickets" })`). */
const VEHICLE_NAME = "tickets";

/** Visible watch rows per page before the auto-rotating overflow hint pages to the next. */
export const TICKETS_WATCHES_WIDGET_VISIBLE_ROWS = 5;

export interface WatchesWidgetRow {
  kind: "issue" | "query";
  key: string;
}

export interface WatchesWidgetProjection {
  rows: WatchesWidgetRow[];
  total: number;
}

/** Minimal shapes this widget needs from IssueWatchSubscription/QueryWatchSubscription -- avoids a
 * hard dependency on @danypops/tickets' own domain types for just two field names. */
export interface IssueWatchLike {
  ref: string;
}
export interface QueryWatchLike {
  name: string;
}

export function buildWatchesWidgetProjection(
  issueWatches: readonly IssueWatchLike[],
  queryWatches: readonly QueryWatchLike[],
): WatchesWidgetProjection {
  const rows: WatchesWidgetRow[] = [
    ...issueWatches.map((watch): WatchesWidgetRow => ({ kind: "issue", key: watch.ref })),
    ...queryWatches.map((watch): WatchesWidgetRow => ({ kind: "query", key: watch.name })),
  ];
  return { rows, total: rows.length };
}

function watchRowLine(theme: { fg(color: string, text: string): string }, row: WatchesWidgetRow, width: number): string {
  const glyph = row.kind === "issue" ? theme.fg("accent", "\u2022") : theme.fg("muted", "\u2263");
  return truncateToWidth(`${glyph} ${row.key}`, width, "\u2026");
}

/** "Tickets · Watches · <N>", plus a "page/total ⟳" suffix once genuinely paging. */
function watchesCardLabel(projection: WatchesWidgetProjection, rotation?: AutoRotatingWindow): string {
  const base = vehicleWidgetTitle(VEHICLE_NAME, "Watches", `${projection.total}`);
  return rotation?.isPaging ? `${base} \u00b7 ${rotation.pageIndex + 1}/${rotation.pageCount} \u27f3` : base;
}

/** Renders the widget as a single bordered card -- `[]` (hide the whole widget) when there are no
 * watches at all, matching every other overlay's own "hide when nothing to show" convention. */
export function renderWatchesWidgetLines(
  theme: { fg(color: string, text: string): string },
  projection: WatchesWidgetProjection,
  width: number,
  rotation?: AutoRotatingWindow,
): string[] {
  if (projection.total === 0) return [];
  rotation?.setTotalRows(projection.rows.length);
  const { start, end } = rotation?.currentPageBounds() ?? { start: 0, end: projection.rows.length };
  const visibleRows = projection.rows.slice(start, end);

  return renderCardRow(
    [
      {
        label: watchesCardLabel(projection, rotation),
        render: (innerWidth: number) => visibleRows.map((row) => watchRowLine(theme, row, innerWidth)),
      },
    ],
    width,
    { measure, frameStyle: (s) => theme.fg("borderMuted", s) },
  );
}
