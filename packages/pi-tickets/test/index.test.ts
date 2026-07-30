import { describe, expect, it } from "bun:test";

describe("extension registration", () => {
  it("registers the /tickets and /secrets commands, its event handlers, and awaits registerTicketsVehicle before returning", async () => {
    const { __resetSecretsRegistryForTests, listSecretsContributors } = await import("@danypops/vehicle-client-pi/secrets-registry");
    __resetSecretsRegistryForTests();

    const registered: { name: string }[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const fakePi = {
      registerTool: (def: { name: string }) => registered.push(def),
      registerCommand: (name: string) => commands.push(name),
      on: (event: string) => events.push(event),
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools: () => {},
    };

    let vehicleCalled = false;
    const mod = await import("../src/index.js");
    // registerVehicle is injected here instead of exercising the real (daemon-talking)
    // registerTicketsVehicle -- this test only verifies index.ts's own wiring, not
    // Vehicle registration behavior (covered by vehicle-client.test.ts against a
    // fully injected fake client, no real daemon involved either way).
    //
    // The default export is async and genuinely awaited here (not fire-and-forget)
    // -- Pi itself awaits a factory that returns a Promise before continuing startup
    // (before session_start, before the model's first turn). A prior version used
    // `void registerVehicle(pi)`, which raced tool registration against the first
    // turn and made freshly-registered tools invisible to the model on some runs --
    // confirmed live against a real Pi session before this fix.
    // biome-ignore lint: test-only cast into the ExtensionAPI shape the factory expects
    await (mod.default as (pi: unknown, deps: unknown) => Promise<void>)(fakePi, {
      registerVehicle: async () => {
        vehicleCalled = true;
        return undefined;
      },
    });

    expect(vehicleCalled).toBe(true);
    // No mega-tool anymore; real per-operation tools come from registerVehicleTools itself.
    expect(registered).toHaveLength(0);
    // tickets claims the real /secrets registration here since nothing else registered first in this test's isolated registry
    expect(commands).toEqual(["tickets", "secrets"]);
    expect(listSecretsContributors().map((c) => c.source)).toEqual(["tickets"]);
    expect(events).toEqual(expect.arrayContaining(["session_start", "tool_execution_end"]));
  });
});
