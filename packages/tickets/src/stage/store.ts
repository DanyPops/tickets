/**
 * Staging — a pre-submission cache for any textual write (a new issue, an
 * update, a comment) so it can be reviewed and edited before it ever touches
 * a live backend. Ported from `~/Workspace/emcee`'s working stage
 * capability, generalized from issue-creation-only to any of the three
 * payload kinds via a discriminated union, and with a generic patch()
 * instead of one hand-rolled field list per kind.
 *
 * In-memory, not persisted: a daemon restart drops whatever was staged,
 * matching emcee's own design. Bounded by both a TTL (expired items are
 * evicted lazily on the next access) and a max item count (the oldest item
 * is evicted to make room for a new one past that count) — never an
 * unbounded map.
 */
import { randomUUID } from "node:crypto";
import type { CreateInput, UpdateInput } from "../issue/issue.js";

export const STAGE_TTL_MS = 30 * 60_000;
export const STAGE_MAX_ITEMS = 50;

export interface StageCreatePayload {
  kind: "create";
  backend: string;
  input: CreateInput;
}

export interface StageUpdatePayload {
  kind: "update";
  ref: string;
  input: UpdateInput;
}

export interface StageCommentPayload {
  kind: "comment";
  ref: string;
  body: string;
}

export type StagePayload = StageCreatePayload | StageUpdatePayload | StageCommentPayload;

export interface StagedItem {
  id: string;
  payload: StagePayload;
  createdAt: string;
  expiresAt: string;
}

export class StagedItemNotFoundError extends Error {
  constructor(id: string) {
    super(`no staged item "${id}" (it may have expired -- staged items lapse after 30 minutes)`);
    this.name = "StagedItemNotFoundError";
  }
}

/** Only the free-text fields a patch may override, never kind/backend/ref: those are the staged item's identity, not text content to edit. */
export type StagePatchFields = Partial<CreateInput> & Partial<UpdateInput> & { body?: string };

function applyPatch(payload: StagePayload, fields: StagePatchFields): StagePayload {
  if (payload.kind === "comment") {
    return typeof fields.body === "string" ? { ...payload, body: fields.body } : payload;
  }
  const { body: _ignoredBody, ...inputFields } = fields;
  return { ...payload, input: { ...payload.input, ...inputFields } } as StagePayload;
}

export class StageStore {
  private readonly items = new Map<string, StagedItem>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  add(payload: StagePayload): StagedItem {
    this.evictExpired();
    if (this.items.size >= STAGE_MAX_ITEMS) this.evictOldest();

    const createdAt = this.now();
    const item: StagedItem = {
      id: randomUUID(),
      payload,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + STAGE_TTL_MS).toISOString(),
    };
    this.items.set(item.id, item);
    return item;
  }

  list(): StagedItem[] {
    this.evictExpired();
    return [...this.items.values()];
  }

  show(id: string): StagedItem {
    this.evictExpired();
    const item = this.items.get(id);
    if (!item) throw new StagedItemNotFoundError(id);
    return item;
  }

  patch(id: string, fields: StagePatchFields): StagedItem {
    const item = this.show(id);
    const patched: StagedItem = { ...item, payload: applyPatch(item.payload, fields) };
    this.items.set(id, patched);
    return patched;
  }

  /** Idempotent -- dropping an id that's already gone (removed, expired) is a no-op, not an error, matching this codebase's own undepend/uncontain convention. */
  drop(id: string): boolean {
    this.evictExpired();
    return this.items.delete(id);
  }

  private evictExpired(): void {
    const now = this.now().getTime();
    for (const [id, item] of this.items) {
      if (new Date(item.expiresAt).getTime() <= now) this.items.delete(id);
    }
  }

  private evictOldest(): void {
    const oldest = [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (oldest) this.items.delete(oldest.id);
  }
}
