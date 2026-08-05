import { describe, expect, it } from "bun:test";
import { STAGE_MAX_ITEMS, STAGE_TTL_MS, StagedItemNotFoundError, type StagePayload, StageStore } from "../../src/stage/store.js";

const createPayload: StagePayload = { kind: "create", backend: "github", input: { title: "Widget bug" } };
const updatePayload: StagePayload = { kind: "update", ref: "github:#1", input: { title: "Retitled" } };
const commentPayload: StagePayload = { kind: "comment", ref: "github:#1", body: "Draft comment" };

function harness(now: () => Date = () => new Date("2026-01-01T00:00:00.000Z")) {
  return new StageStore(now);
}

describe("StageStore", () => {
  it("add() then show() round-trips a staged create payload", () => {
    const store = harness();
    const staged = store.add(createPayload);
    expect(staged.id).toBeTruthy();
    expect(staged.payload).toEqual(createPayload);
    expect(staged.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(staged.expiresAt).toBe(new Date(new Date("2026-01-01T00:00:00.000Z").getTime() + STAGE_TTL_MS).toISOString());

    expect(store.show(staged.id)).toEqual(staged);
  });

  it("stages an update payload and a comment payload the same way as a create payload -- generic over kind", () => {
    const store = harness();
    const update = store.add(updatePayload);
    const comment = store.add(commentPayload);
    expect(store.show(update.id).payload).toEqual(updatePayload);
    expect(store.show(comment.id).payload).toEqual(commentPayload);
  });

  it("list() returns every currently staged item", () => {
    const store = harness();
    const a = store.add(createPayload);
    const b = store.add(commentPayload);
    expect(
      store
        .list()
        .map((item) => item.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it("list() on an empty store returns an empty array, not undefined", () => {
    expect(harness().list()).toEqual([]);
  });

  it("show() on an unknown id throws StagedItemNotFoundError", () => {
    const store = harness();
    expect(() => store.show("nope")).toThrow(StagedItemNotFoundError);
  });

  it("patch() merges fields into a create payload's input, leaving backend and other fields untouched", () => {
    const store = harness();
    const staged = store.add(createPayload);
    const patched = store.patch(staged.id, { description: "more detail" });
    expect(patched.payload).toEqual({
      kind: "create",
      backend: "github",
      input: { title: "Widget bug", description: "more detail" },
    });
  });

  it("patch() overrides an existing field on a create payload's input", () => {
    const store = harness();
    const staged = store.add(createPayload);
    const patched = store.patch(staged.id, { title: "Fixed title" });
    expect(patched.payload).toEqual({ kind: "create", backend: "github", input: { title: "Fixed title" } });
  });

  it("patch() merges fields into an update payload's input the same way", () => {
    const store = harness();
    const staged = store.add(updatePayload);
    const patched = store.patch(staged.id, { description: "clarified" });
    expect(patched.payload).toEqual({
      kind: "update",
      ref: "github:#1",
      input: { title: "Retitled", description: "clarified" },
    });
  });

  it("patch() on a comment payload only ever touches body, ignoring create/update-shaped fields", () => {
    const store = harness();
    const staged = store.add(commentPayload);
    const patched = store.patch(staged.id, { body: "Revised comment", title: "ignored" });
    expect(patched.payload).toEqual({ kind: "comment", ref: "github:#1", body: "Revised comment" });
  });

  it("patch() on an unknown id throws StagedItemNotFoundError", () => {
    const store = harness();
    expect(() => store.patch("nope", { title: "x" })).toThrow(StagedItemNotFoundError);
  });

  it("drop() removes a staged item and is idempotent -- dropping again is a no-op, not an error", () => {
    const store = harness();
    const staged = store.add(createPayload);
    expect(store.drop(staged.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.drop(staged.id)).toBe(false);
  });

  it("evicts an item once its TTL has lapsed, on the next access", () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const store = harness(() => clock);
    const staged = store.add(createPayload);

    clock = new Date(clock.getTime() + STAGE_TTL_MS - 1);
    expect(store.list().map((item) => item.id)).toEqual([staged.id]);

    clock = new Date(clock.getTime() + 2);
    expect(store.list()).toEqual([]);
    expect(() => store.show(staged.id)).toThrow(StagedItemNotFoundError);
  });

  it("bounds total staged items -- adding past STAGE_MAX_ITEMS evicts the single oldest item, never grows unbounded", () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const store = harness(() => clock);
    const ids: string[] = [];
    for (let i = 0; i < STAGE_MAX_ITEMS; i++) {
      ids.push(store.add({ kind: "comment", ref: "github:#1", body: `draft ${i}` }).id);
      clock = new Date(clock.getTime() + 1000);
    }
    expect(store.list()).toHaveLength(STAGE_MAX_ITEMS);

    const overflow = store.add({ kind: "comment", ref: "github:#1", body: "one too many" });

    const current = store.list().map((item) => item.id);
    expect(current).toHaveLength(STAGE_MAX_ITEMS);
    expect(current).not.toContain(ids[0]); // the oldest item was evicted
    expect(current).toContain(overflow.id);
  });
});
