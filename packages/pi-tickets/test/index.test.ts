import { describe, expect, it } from "bun:test";

describe("extension registration", () => {
  it("registers the /tickets and /secrets commands and its event handlers synchronously, deferring registerTicketsVehicle to session_start", async () => {
    const { __resetSecretsRegistryForTests, listSecretsContributors } = await import("@danypops/vehicle-client-pi/secrets-registry");
    __resetSecretsRegistryForTests();

    const registered: { name: string }[] = [];
    const commands: string[] = [];
    const sessionStartHandlers: Array<() => unknown> = [];
    const fakePi = {
      registerTool: (def: { name: string }) => registered.push(def),
      registerCommand: (name: string) => commands.push(name),
      on: (event: string, handler: () => unknown) => {
        if (event === "session_start") sessionStartHandlers.push(handler);
      },
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
    // The default export is synchronous again and does NOT call registerVehicle
    // directly -- it defers that to a session_start handler. Calling
    // registerVehicleTools() (which registerTicketsVehicle wraps) directly from
    // the top-level factory body throws "Extension runtime not initialized"
    // (Pi's extension runtime only finishes initializing after every extension's
    // factory resolves) -- previously silently swallowed by registerTicketsVehicle's
    // own daemon-unreachable try/catch, making every projected tool invisible to
    // the model with zero visible sign why. Confirmed live before this fix.
    (mod.default as (pi: unknown, deps: unknown) => void)(fakePi, {
      registerVehicle: async () => {
        vehicleCalled = true;
        return undefined;
      },
    });

    // Not called yet -- only registered as a session_start handler so far.
    expect(vehicleCalled).toBe(false);
    expect(sessionStartHandlers.length).toBeGreaterThanOrEqual(1);
    for (const handler of sessionStartHandlers) await handler();
    expect(vehicleCalled).toBe(true);

    // No mega-tool anymore; real per-operation tools come from registerVehicleTools itself.
    expect(registered).toHaveLength(0);
    // tickets claims the real /secrets registration here since nothing else registered first in this test's isolated registry
    expect(commands).toEqual(["tickets", "secrets"]);
    expect(listSecretsContributors().map((c) => c.source)).toEqual(["tickets"]);
  });
});
