/**
 * Persistent above-editor widget for currently-watched issues/saved queries -- mirrors
 * pi-papyrus's own TaskOverlay/NoteOverlay and pi-pipes' own JobsOverlay: factory-form
 * ctx.ui.setWidget registration, requestRender on refresh, hides the widget entirely
 * (setWidget(key, undefined)) rather than an empty box once nothing is watched.
 *
 * issue.subscribed/query.subscribed already exist and are documented "never a live backend
 * call, cheap to call frequently" -- no new backend operation was needed for this widget.
 */
import type { VehicleClient } from "@danypops/vehicle-core";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { AutoRotatingWindow } from "malevich-tui-components";
import { BoundedPoll } from "./bounded-poll.js";
import {
  buildWatchesWidgetProjection,
  type IssueWatchLike,
  type QueryWatchLike,
  renderWatchesWidgetLines,
  TICKETS_WATCHES_WIDGET_VISIBLE_ROWS,
  type WatchesWidgetProjection,
} from "./watches-widget.js";

const WIDGET_KEY = "pi-tickets-watches";

/** Matches pi-papyrus's/pi-pipes' own 15-20s cadence -- a cheap, non-live-backend read. */
export const WATCHES_WIDGET_POLL_INTERVAL_MS = 20_000;

/** How often the widget's own auto-rotating overflow page advances. */
export const WATCHES_WIDGET_ROTATION_INTERVAL_MS = 6_000;

const EMPTY_PROJECTION: WatchesWidgetProjection = { rows: [], total: 0 };

export class WatchesOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private registered = false;
  // biome-ignore lint/suspicious/noExplicitAny: same TUI-handle shape every other overlay in this ecosystem keeps untyped (requestRender is all that's used).
  private tui: any | undefined;
  private projection: WatchesWidgetProjection = EMPTY_PROJECTION;
  private readonly poll = new BoundedPoll();
  /** Repaint-only ticker (no data refetch) so the widget's own auto-rotating page visibly
   * advances even when nothing else has changed. */
  private readonly rotationPoll = new BoundedPoll();
  private readonly rotation = new AutoRotatingWindow({
    totalRows: 0,
    pageSize: TICKETS_WATCHES_WIDGET_VISIBLE_ROWS,
    intervalMs: WATCHES_WIDGET_ROTATION_INTERVAL_MS,
  });

  constructor(
    private readonly client: VehicleClient,
    private readonly permissions: readonly string[],
    /** This session's own real Pi session id -- defaults to the daemon's own anonymous
     * subscriber when omitted, matching WatchEventsPoll's own subscriberId convention. */
    private readonly subscriberId?: string,
  ) {}

  setUI(ctx: ExtensionUIContext): void {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.registered = false;
      this.tui = undefined;
    }
  }

  /** Never throws: called from a poll timer and from session_start, neither of which should turn
   * a best-effort status widget into a crashed extension host over a daemon that isn't running
   * yet or a rendering bug. */
  async refresh(): Promise<void> {
    try {
      const [issueResult, queryResult] = await Promise.all([
        this.client.invoke<{ watches: IssueWatchLike[] }>(
          "issue.subscribed",
          1,
          { subscriberId: this.subscriberId },
          { permissions: this.permissions },
        ),
        this.client.invoke<{ watches: QueryWatchLike[] }>(
          "query.subscribed",
          1,
          { subscriberId: this.subscriberId },
          { permissions: this.permissions },
        ),
      ]);
      this.projection = buildWatchesWidgetProjection(issueResult.watches, queryResult.watches);
    } catch {
      this.projection = EMPTY_PROJECTION;
    }
    try {
      this.render();
    } catch {
      // A rendering bug must not crash the extension host over a best-effort status widget.
    }
  }

  private render(): void {
    if (!this.uiCtx) return;

    if (this.projection.total === 0) {
      if (this.registered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.registered = false;
        this.tui = undefined;
        this.rotationPoll.stop();
      }
      return;
    }

    if (!this.registered) {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        // biome-ignore lint/suspicious/noExplicitAny: tui is only ever used for requestRender(), matching every other overlay in this ecosystem.
        (tui: any, theme: Theme) => {
          this.tui = tui;
          return {
            render: (width: number) => renderWatchesWidgetLines(theme, this.projection, width, this.rotation),
            invalidate: () => {
              // Theme changed -- force re-registration, matching every other overlay in this ecosystem.
              this.registered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.registered = true;
      this.rotationPoll.start(WATCHES_WIDGET_ROTATION_INTERVAL_MS, () => this.tui?.requestRender?.());
    } else {
      this.tui?.requestRender?.();
    }
  }

  startPolling(intervalMs: number = WATCHES_WIDGET_POLL_INTERVAL_MS): void {
    this.poll.start(intervalMs, () => {
      void this.refresh();
    });
  }

  stopPolling(): void {
    this.poll.stop();
  }

  dispose(): void {
    this.stopPolling();
    this.rotationPoll.stop();
    this.uiCtx?.setWidget(WIDGET_KEY, undefined);
    this.registered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
  }
}
