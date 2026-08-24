/**
 * Persistent above-editor widget for the current Pi session's own ticket focus -- mirrors
 * watches-overlay.ts's own factory-form ctx.ui.setWidget registration, requestRender on refresh,
 * and hides the widget entirely (setWidget(key, undefined)) rather than an empty box once
 * nothing is focused.
 *
 * Unlike WatchesOverlay (a cross-session VehicleClient read), a ticket focus is scoped to this
 * Pi session's own identity -- the same authenticated TicketsRpcClient/sessionId pairing every
 * focus.*-scoped call in this package uses (see session-identity.ts's focusSessionFields).
 */
import type { TicketFocusState, TicketsRpcClient } from "@danypops/tickets";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { BoundedPoll } from "./bounded-poll.js";
import { renderFocusWidgetLines } from "./focus-widget.js";
import { focusSessionFields } from "./session-identity.js";

const WIDGET_KEY = "pi-tickets-focus";

/** Matches WatchesOverlay's own 20s cadence -- a cheap, session-scoped read. */
export const FOCUS_WIDGET_POLL_INTERVAL_MS = 20_000;

export class FocusOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private registered = false;
  // biome-ignore lint/suspicious/noExplicitAny: same TUI-handle shape every other overlay in this ecosystem keeps untyped (requestRender is all that's used).
  private tui: any | undefined;
  private focus: TicketFocusState | null = null;
  private readonly poll = new BoundedPoll();

  constructor(
    private readonly client: TicketsRpcClient,
    /** This session's own real Pi session id -- every focus.* call is scoped to it. */
    private readonly sessionId: string,
  ) {}

  setUI(ctx: ExtensionUIContext): void {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.registered = false;
      this.tui = undefined;
    }
  }

  /** Never throws: called from a poll timer, session_start, and every own-tool completion, none
   * of which should turn a best-effort status widget into a crashed extension host over a daemon
   * that isn't running yet or a rendering bug. */
  async refresh(): Promise<void> {
    try {
      const { focus } = await this.client.call("focus.get", focusSessionFields(this.sessionId));
      this.focus = focus;
    } catch {
      this.focus = null;
    }
    try {
      this.render();
    } catch {
      // A rendering bug must not crash the extension host over a best-effort status widget.
    }
  }

  private render(): void {
    if (!this.uiCtx) return;

    if (!this.focus) {
      if (this.registered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.registered = false;
        this.tui = undefined;
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
            render: (width: number) => renderFocusWidgetLines(theme, this.focus, width),
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
    } else {
      this.tui?.requestRender?.();
    }
  }

  startPolling(intervalMs: number = FOCUS_WIDGET_POLL_INTERVAL_MS): void {
    this.poll.start(intervalMs, () => {
      void this.refresh();
    });
  }

  stopPolling(): void {
    this.poll.stop();
  }

  dispose(): void {
    this.stopPolling();
    this.uiCtx?.setWidget(WIDGET_KEY, undefined);
    this.registered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
  }
}
