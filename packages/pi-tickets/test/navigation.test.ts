import { describe, expect, it, mock } from "bun:test";
import { FULL_SCREEN_OVERLAY, pushView } from "../src/navigation.js";

function fakeCtx(customImpl: (factory: unknown, options?: unknown) => Promise<unknown>) {
  return { ui: { custom: mock(customImpl) } } as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;
}

describe("FULL_SCREEN_OVERLAY", () => {
  it("fills the terminal instead of a centered minified box", () => {
    expect(FULL_SCREEN_OVERLAY).toEqual({ width: "100%", maxHeight: "100%", anchor: "top-center", offsetY: 1, margin: 0 });
  });
});

describe("pushView", () => {
  it("delegates to ctx.ui.custom with overlay:true and the full-screen overlay options", async () => {
    const ctx = fakeCtx((_factory, options) => {
      expect(options).toEqual({ overlay: true, overlayOptions: FULL_SCREEN_OVERLAY });
      return Promise.resolve("result");
    });
    const result = await pushView(ctx, () => ({ render: () => [], invalidate: () => {}, handleInput: () => {} }));
    expect(result).toBe("result");
  });

  it("passes the factory through unchanged", async () => {
    let received: unknown;
    const ctx = fakeCtx((factory) => {
      received = factory;
      return Promise.resolve(undefined);
    });
    const factory = () => ({ render: () => [], invalidate: () => {}, handleInput: () => {} });
    await pushView(ctx, factory);
    expect(received).toBe(factory);
  });
});
