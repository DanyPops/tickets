import { describe, expect, it } from "bun:test";

describe("extension registration", () => {
  it("registers the /tickets and /secrets commands synchronously, and calls registerTicketsVehicle directly -- deferral to session_start is registerTicketsVehicle's own concern now, not index.ts's", async () => {
    const { __resetSecretsRegistryForTests, listSecretsContributors } = await import("@danypops/vehicle-client-pi/secrets-registry");
    __resetSecretsRegistryForTests();

    const registered: { name: string }[] = [];
    const commands: string[] = [];
    const fakePi = {
      registerTool: (def: { name: string }) => registered.push(def),
      registerCommand: (name: string) => commands.push(name),
      on: () => {},
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
    // The default export calls registerVehicle directly, fire-and-forget --
    // registerTicketsVehicle now defers the actual registerVehicleTools() call
    // to session_start internally (via registerVehicleToolsWhenReady), so
    // index.ts no longer needs its own session_start wrapper around it.
    (mod.default as (pi: unknown, deps: unknown) => void)(fakePi, {
      registerVehicle: async () => {
        vehicleCalled = true;
        return undefined;
      },
    });

    // Called directly at factory time -- no session_start indirection left in index.ts.
    expect(vehicleCalled).toBe(true);

    // No mega-tool anymore; real per-operation tools come from registerVehicleTools itself.
    expect(registered).toHaveLength(0);
    // tickets claims the real /secrets registration here since nothing else registered first in this test's isolated registry
    expect(commands).toEqual(["tickets", "secrets"]);
    expect(listSecretsContributors().map((c) => c.source)).toEqual(["tickets"]);
  });
});
