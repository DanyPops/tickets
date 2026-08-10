/**
 * Client-side "get notified about watched issue/query changes" poll -- the pi-tickets analog of
 * @danypops/pipes' own pi-pipes/src/jobs-overlay.ts poll loop, minus the visual widget: there is
 * no per-row "vanished" lifecycle to render here (an issue watch persists until explicitly
 * unsubscribed, unlike a CI job's own watched-until-terminal shape), so this is deliberately just
 * the notification half.
 *
 * Unlike pi-pipes' own JobsOverlay (which re-derives "did anything change" itself via
 * AgentPollTicker, because ci.subscribed's own output carries no pre-computed diff), this doesn't
 * need any client-side diffing at all: @danypops/tickets' watch.events op already does the real
 * diff server-side (see its own process/watch-sync.ts) and persists exactly the change events
 * worth telling a human about. This poll only ever advances a cursor (sinceId) and forwards
 * whatever's new, once each, via pi.sendMessage's gentle non-turn-forcing `followUp` delivery
 * (see @danypops/vehicle-client-pi/agent-poll-ticker's own doc comment for why that API, not
 * pi.sendUserMessage).
 *
 * Deliberately never replays history on its own first tick: a subscription that already existed
 * before this poll started (e.g. from a previous session, or the CLI) must not dump every
 * historical event the moment a new Pi session opens -- only changes observed from here on.
 */
import type { VehicleClient } from "@danypops/vehicle-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface WatchEvent {
  id: number;
  kind: "issue" | "query";
  key: string;
  message: string;
  createdAt: string;
}

interface WatchEventsResult {
  events: WatchEvent[];
  lastId: number;
}

export interface WatchEventsPollOptions {
  client: VehicleClient;
  pi: ExtensionAPI;
  /** This session's own real id (ctx.sessionManager.getSessionId()) -- scopes watch.events to only this session's own subscriptions, the same cross-session-leak fix ci.subscribed/ci.pool already apply. */
  subscriberId: string;
  permissions: readonly string[];
  /** Defaults to DEFAULT_WATCH_EVENTS_POLL_INTERVAL_MS (30s) -- matches pi-pipes' own JOBS_WIDGET_POLL_INTERVAL_MS order of magnitude. */
  intervalMs?: number;
}

export const DEFAULT_WATCH_EVENTS_POLL_INTERVAL_MS = 30_000;

export class WatchEventsPoll {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** undefined means "never ticked yet" -- the very next successful tick primes the cursor without notifying (see this module's own doc comment). */
  private sinceId: number | undefined;

  constructor(private readonly options: WatchEventsPollOptions) {}

  /** Idempotent -- a second start() while already running is a no-op, matching pi-pipes' own BoundedPoll. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? DEFAULT_WATCH_EVENTS_POLL_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Never throws: a poll timer callback crashing the extension host over a transient daemon hiccup
   * (not running yet, mid-restart) would be strictly worse than silently retrying next tick.
   */
  async tick(): Promise<void> {
    try {
      const result = await this.options.client.invoke<WatchEventsResult>(
        "watch.events",
        1,
        { subscriberId: this.options.subscriberId, sinceId: this.sinceId },
        { permissions: this.options.permissions },
      );
      const primingFirstTick = this.sinceId === undefined;
      this.sinceId = result.lastId;
      if (primingFirstTick) return;
      for (const event of result.events) this.deliver(event);
    } catch {
      // Best-effort background poll -- see this method's own doc comment.
    }
  }

  private deliver(event: WatchEvent): void {
    this.options.pi.sendMessage(
      { customType: "pi-tickets:watch-event", content: `[pi-tickets] ${event.message}`, display: true },
      { deliverAs: "followUp" },
    );
  }
}
