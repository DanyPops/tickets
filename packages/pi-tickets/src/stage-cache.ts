/**
 * A best-effort, session-local mirror of the tickets daemon's own staged-item content, keyed by
 * stage id -- exists solely so a stage.push approval prompt (see vehicle-client.ts's own
 * approvalPrompt/onInvoked wiring) can show the actual payload being committed instead of the
 * bare `{id}` its own tool-call input carries; the payload itself is never part of stage.push's
 * own call arguments, only the daemon-side stage store has it. Populated from any
 * stage.add/stage.list/stage.show/stage.patch result this pi-tickets process happens to observe
 * -- a cold cache (a different session staged it, or this process restarted since) is a plain
 * miss, never blocks or fails the approval itself.
 *
 * Bounded the same two ways the daemon's own StageStore is (see @danypops/tickets's own
 * stage/store.ts): a max entry count (oldest evicted first) and each entry's own real
 * `expiresAt`, mirrored from the daemon's response rather than independently guessed -- an entry
 * past its authoritative expiry is treated as a miss instead of serving stale content.
 */
import type { TicketOpOutputs } from "@danypops/tickets";

const STAGE_CACHE_MAX_ITEMS = 50;

type StagedItem = TicketOpOutputs["stage.add"]["item"];

interface StagedCacheEntry {
  readonly payload: unknown;
  readonly expiresAtMs: number;
}

const cache = new Map<string, StagedCacheEntry>();

function evictExpired(now: number): void {
  for (const [id, entry] of cache) {
    if (entry.expiresAtMs <= now) cache.delete(id);
  }
}

function evictOldestIfFull(): void {
  if (cache.size < STAGE_CACHE_MAX_ITEMS) return;
  const oldestId: string | undefined = cache.keys().next().value; // Map preserves insertion order
  if (oldestId !== undefined) cache.delete(oldestId);
}

function isStagedItem(value: unknown): value is StagedItem {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.expiresAt === "string" && "payload" in record;
}

function recordStagedItem(item: StagedItem): void {
  const expiresAtMs = Date.parse(item.expiresAt);
  if (Number.isNaN(expiresAtMs)) return; // malformed timestamp -- never cache on a value we can't trust to expire
  evictExpired(Date.now());
  cache.delete(item.id); // re-insert to refresh insertion order (most-recently-seen last)
  evictOldestIfFull();
  cache.set(item.id, { payload: item.payload, expiresAtMs });
}

/**
 * Observes one operation's real RPC output and records whichever staged item(s) it carries.
 * Called from vehicle-client.ts's onInvoked hook for every tickets operation; a no-op for
 * anything that isn't stage.add/stage.list/stage.show/stage.patch, or a malformed/unexpected
 * output shape.
 */
export function recordStagedItemsFromOutput(operationName: string, output: unknown): void {
  if (typeof output !== "object" || output === null) return;
  const record = output as Record<string, unknown>;
  if (operationName === "stage.add" || operationName === "stage.show" || operationName === "stage.patch") {
    if (isStagedItem(record.item)) recordStagedItem(record.item);
    return;
  }
  if (operationName === "stage.list" && Array.isArray(record.items)) {
    for (const item of record.items) {
      if (isStagedItem(item)) recordStagedItem(item);
    }
  }
}

/** Returns the cached payload for a staged item id, or undefined on a cold/expired/never-seen entry. */
export function getStagedPayload(id: string): unknown | undefined {
  evictExpired(Date.now());
  return cache.get(id)?.payload;
}

/** Drops one id from the cache -- called once its staged item is gone daemon-side (pushed or dropped). Idempotent. */
export function forgetStagedPayload(id: string): void {
  cache.delete(id);
}

/** Test-only: clears every cached entry so tests don't leak state across cases. */
export function clearStagedPayloadCacheForTests(): void {
  cache.clear();
}
