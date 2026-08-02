import { describe, expect, it } from "bun:test";
import { makeRef, parsePriority, parseRef, parseStatus } from "../../src/issue/issue.js";

describe("parsePriority", () => {
  it("accepts known values case-insensitively", () => {
    expect(parsePriority("HIGH")).toBe("high");
    expect(parsePriority("urgent")).toBe("urgent");
  });

  it("falls back to none for anything unrecognized", () => {
    expect(parsePriority("what")).toBe("none");
    expect(parsePriority(undefined)).toBe("none");
    expect(parsePriority(42)).toBe("none");
  });
});

describe("parseStatus", () => {
  it("accepts known values and a custom fallback", () => {
    expect(parseStatus("done")).toBe("done");
    expect(parseStatus("nonsense", "backlog")).toBe("backlog");
  });
});

describe("parseRef / makeRef", () => {
  it("splits backend:key on the first colon only", () => {
    expect(parseRef("jira:PROJ-42")).toEqual({ backend: "jira", key: "PROJ-42" });
    expect(parseRef("github:#7")).toEqual({ backend: "github", key: "#7" });
  });

  it("preserves colons inside the key", () => {
    expect(parseRef("gitlab:group/sub:5")).toEqual({ backend: "gitlab", key: "group/sub:5" });
  });

  it("rejects refs with no backend or no key", () => {
    expect(() => parseRef("noColonHere")).toThrow();
    expect(() => parseRef(":onlykey")).toThrow();
    expect(() => parseRef("onlybackend:")).toThrow();
  });

  it("round-trips through makeRef", () => {
    expect(parseRef(makeRef("jira", "PROJ-1"))).toEqual({ backend: "jira", key: "PROJ-1" });
  });
});
