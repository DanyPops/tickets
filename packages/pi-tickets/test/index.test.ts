import { describe, expect, it } from "bun:test";

describe("extension registration", () => {
  it("registers the /tickets and /secrets commands, its event handlers, and calls registerTicketsVehicle", async () => {
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
    // biome-ignore lint: test-only cast into the ExtensionAPI shape the factory expects
    (mod.default as (pi: unknown, deps: unknown) => void)(fakePi, {
      registerVehicle: async () => {
        vehicleCalled = true;
        return undefined;
      },
    });
    // registerVehicle is called fire-and-forget (void) -- give its microtask a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vehicleCalled).toBe(true);
    // No mega-tool anymore; real per-operation tools come from registerVehicleTools itself.
    expect(registered).toHaveLength(0);
    // tickets claims the real /secrets registration here since nothing else registered first in this test's isolated registry
    expect(commands).toEqual(["tickets", "secrets"]);
    expect(listSecretsContributors().map((c) => c.source)).toEqual(["tickets"]);
    expect(events).toEqual(expect.arrayContaining(["session_start", "tool_execution_end"]));
  });
});
