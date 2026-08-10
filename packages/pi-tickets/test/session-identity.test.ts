import { afterEach, describe, expect, it } from "bun:test";
import {
  cacheSessionSecret,
  focusSessionFields,
  forgetSessionSecret,
  resetSessionSecretsForTests,
  sessionSecretField,
} from "../src/session-identity.js";

afterEach(() => {
  resetSessionSecretsForTests();
});

describe("sessionSecretField", () => {
  it("is empty (key omitted, not sessionSecret: undefined) when nothing is cached for this sessionId", () => {
    expect(sessionSecretField("never-cached")).toEqual({});
  });

  it("returns the cached secret once one has been cached for this exact sessionId", () => {
    cacheSessionSecret("session-a", "secret-1");
    expect(sessionSecretField("session-a")).toEqual({ sessionSecret: "secret-1" });
    forgetSessionSecret("session-a");
  });

  it("forgetSessionSecret removes the cached value; a later lookup is empty again", () => {
    cacheSessionSecret("session-b", "secret-2");
    forgetSessionSecret("session-b");
    expect(sessionSecretField("session-b")).toEqual({});
  });

  it("caching a new secret for the same sessionId replaces the old one (rotation)", () => {
    cacheSessionSecret("session-c", "secret-3");
    cacheSessionSecret("session-c", "secret-4");
    expect(sessionSecretField("session-c")).toEqual({ sessionSecret: "secret-4" });
    forgetSessionSecret("session-c");
  });

  it("is scoped per sessionId -- caching one session's secret never leaks into another's lookup", () => {
    cacheSessionSecret("session-d", "secret-5");
    expect(sessionSecretField("session-e")).toEqual({});
    forgetSessionSecret("session-d");
  });
});

describe("focusSessionFields", () => {
  it("always includes sessionId, and the cached secret when one exists", () => {
    cacheSessionSecret("session-f", "secret-6");
    expect(focusSessionFields("session-f")).toEqual({ sessionId: "session-f", sessionSecret: "secret-6" });
    forgetSessionSecret("session-f");
  });

  it("omits sessionSecret entirely (not null/undefined) when nothing is cached", () => {
    expect(focusSessionFields("session-g")).toEqual({ sessionId: "session-g" });
  });
});
