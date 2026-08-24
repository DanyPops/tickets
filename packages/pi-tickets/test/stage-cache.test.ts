import { beforeEach, describe, expect, it } from "bun:test";
import { clearStagedPayloadCacheForTests, forgetStagedPayload, getStagedPayload, recordStagedItemsFromOutput } from "../src/stage-cache.js";

function stagedItem(id: string, payload: unknown, expiresAt = "2099-01-01T00:00:00.000Z") {
  return { id, payload, createdAt: "2026-01-01T00:00:00.000Z", expiresAt };
}

beforeEach(() => {
  clearStagedPayloadCacheForTests();
});

describe("recordStagedItemsFromOutput / getStagedPayload", () => {
  it("caches a stage.add result's payload, retrievable by id", () => {
    const payload = { kind: "create", backend: "jira", input: { title: "Do the thing" } };
    recordStagedItemsFromOutput("stage.add", { item: stagedItem("s1", payload) });
    expect(getStagedPayload("s1")).toEqual(payload);
  });

  it("caches a stage.show or stage.patch result's payload the same way", () => {
    const payload = { kind: "update", ref: "jira:PROJ-1", input: { title: "Renamed" } };
    recordStagedItemsFromOutput("stage.show", { item: stagedItem("s2", payload) });
    expect(getStagedPayload("s2")).toEqual(payload);
    const patched = { ...payload, input: { title: "Renamed again" } };
    recordStagedItemsFromOutput("stage.patch", { item: stagedItem("s2", patched) });
    expect(getStagedPayload("s2")).toEqual(patched);
  });

  it("caches every item in a stage.list result, not just the first", () => {
    recordStagedItemsFromOutput("stage.list", {
      items: [
        stagedItem("s3", { kind: "comment", ref: "github:#1", body: "hi" }),
        stagedItem("s4", { kind: "create", backend: "github", input: {} }),
      ],
    });
    expect(getStagedPayload("s3")).toEqual({ kind: "comment", ref: "github:#1", body: "hi" });
    expect(getStagedPayload("s4")).toEqual({ kind: "create", backend: "github", input: {} });
  });

  it("returns undefined for an id never observed -- a cold cache, not an error", () => {
    expect(getStagedPayload("never-seen")).toBeUndefined();
  });

  it("ignores an operation this module doesn't care about", () => {
    recordStagedItemsFromOutput("stage.push", { result: { issue: { ref: "jira:PROJ-1" } } });
    expect(getStagedPayload("anything")).toBeUndefined();
  });

  it("ignores a malformed/unexpected output shape rather than throwing", () => {
    expect(() => recordStagedItemsFromOutput("stage.add", undefined)).not.toThrow();
    expect(() => recordStagedItemsFromOutput("stage.add", null)).not.toThrow();
    expect(() => recordStagedItemsFromOutput("stage.add", { item: "not an object" })).not.toThrow();
    expect(() => recordStagedItemsFromOutput("stage.add", { item: { id: "s5" } })).not.toThrow(); // missing payload/expiresAt
    expect(getStagedPayload("s5")).toBeUndefined();
  });

  it("never caches an entry with an unparseable expiresAt -- can't trust it to expire later", () => {
    recordStagedItemsFromOutput("stage.add", { item: stagedItem("s6", { kind: "create" }, "not-a-date") });
    expect(getStagedPayload("s6")).toBeUndefined();
  });

  it("treats an entry past its own real expiresAt as a miss instead of serving stale content", () => {
    recordStagedItemsFromOutput("stage.add", { item: stagedItem("s7", { kind: "create" }, "2000-01-01T00:00:00.000Z") });
    expect(getStagedPayload("s7")).toBeUndefined();
  });

  it("bounds total entries -- the oldest-inserted entry is evicted to make room, never grows unbounded", () => {
    for (let i = 0; i < 51; i++) {
      recordStagedItemsFromOutput("stage.add", { item: stagedItem(`bulk-${i}`, { n: i }) });
    }
    expect(getStagedPayload("bulk-0")).toBeUndefined(); // evicted to make room for the 51st
    expect(getStagedPayload("bulk-50")).toEqual({ n: 50 });
  });
});

describe("forgetStagedPayload", () => {
  it("drops a cached id once its stage.push/stage.drop has landed, so a stale approval can't reuse it", () => {
    recordStagedItemsFromOutput("stage.add", { item: stagedItem("s8", { kind: "create" }) });
    forgetStagedPayload("s8");
    expect(getStagedPayload("s8")).toBeUndefined();
  });

  it("is idempotent -- forgetting an id already gone (or never cached) is a no-op, not an error", () => {
    expect(() => forgetStagedPayload("never-cached")).not.toThrow();
  });
});
