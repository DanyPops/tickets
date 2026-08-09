import { describe, expect, it } from "bun:test";
import { classifyBackendTransportFailure } from "../../src/issue/transport-error.js";

describe("classifyBackendTransportFailure", () => {
  it.each([
    ["ENOTFOUND", "unreachable"],
    ["ECONNREFUSED", "unreachable"],
    ["ECONNRESET", "unreachable"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "unreachable"],
    ["ETIMEDOUT", "timeout"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
  ] as const)("classifies reviewed code %s as %s", (code, expected) => {
    expect(classifyBackendTransportFailure(Object.assign(new Error("ignored"), { code }))).toBe(expected);
  });

  it("walks a bounded cause chain without inspecting messages", () => {
    const error = new Error("outer", { cause: new TypeError("fetch failed", { cause: { code: "EAI_AGAIN" } }) });
    expect(classifyBackendTransportFailure(error)).toBe("unreachable");
  });

  it("fails closed for unknown exceptions without matching on message text", () => {
    const errors: unknown[] = [
      new TypeError("fetch failed ENOTFOUND"),
      Object.assign(new Error("unknown"), { code: "ERR_ASSERTION" }),
      { name: "ProgrammerError", message: "ETIMEDOUT" },
      "ECONNRESET",
    ];
    for (const error of errors) expect(classifyBackendTransportFailure(error)).toBeUndefined();
  });
});
