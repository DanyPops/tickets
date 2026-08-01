/**
 * Regression for the same live bug already found and fixed in pi-papyrus's
 * vehicle-notes-client.ts: registerTicketsVehicle(pi) built a bare Vehicle
 * client once from a target resolved a single time, captured forever in
 * every registered tool's closure. The Tickets daemon rebinds a new random
 * port on every restart; that bare client had no way to notice its baseUrl
 * had died, so every Vehicle-projected tool (issue_*, focus_*, ledger_*,
 * discover_*, backends_*) failed for the rest of the Pi session until a
 * full extension reload.
 *
 * Fixed by wrapping the client in createReconnectingVehicleClient(),
 * re-resolving resolveTarget()/createClient() on every reconnect attempt
 * instead of once. This test proves the fix end to end: register against a
 * real server, invoke successfully, kill that server and start a genuinely
 * new one on a new port, then invoke the SAME already-registered tool again.
 */
import { describe, expect, it } from "bun:test";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerTicketsVehicle, type TicketsVehicleDeps } from "../src/vehicle-client.js";

const passthroughSchema = defineVehicleSchema<Record<string, unknown>>({
  jsonSchema: { type: "object" },
  safeParse: (value) => ({ success: true, value: (value ?? {}) as Record<string, unknown> }),
});

const LIMITS = { defaultTimeoutMs: 2_000, maxTimeoutMs: 5_000, maxRequestBytes: 4_096, maxResponseBytes: 4_096 } as const;

const Ping = defineVehicleOperation({
  name: "test.ping",
  version: 1,
  description: "Returns which server instance actually answered.",
  input: passthroughSchema,
  output: passthroughSchema,
  permissions: [],
  effect: "read",
  idempotency: { mode: "safe" },
  limits: LIMITS,
});

function startServer(instanceLabel: string): { baseUrl: string; stop: () => void } {
  const registry = new VehicleRegistry({ name: "test-tickets", version: "1.0.0", description: "Test Tickets" });
  registry.register(
    "test-owner",
    bindVehicleOperation(Ping, () => async () => ({ answeredBy: instanceLabel })),
  );
  const app = createVehicleHttpApp({ registry, token: "test-token" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function fakePi() {
  const tools: ToolDefinition[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
    on: () => {},
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

describe("registerTicketsVehicle survives a daemon restart without a Pi extension reload", () => {
  it("a tool registered against the original daemon keeps working after it restarts on a new port", async () => {
    let current = startServer("first");
    let resolvedBaseUrl = current.baseUrl;

    const { pi, tools } = fakePi();
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: resolvedBaseUrl, token: "test-token" }),
    };

    await registerTicketsVehicle(pi, deps);
    const tool = tools.find((t) => t.name === "test_ping");
    expect(tool).toBeDefined();

    const execute = tool!.execute as unknown as (
      toolCallId: string,
      input: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      context: unknown,
    ) => Promise<{ details?: { output?: unknown } }>;
    const toolContext = { sessionManager: { getSessionId: () => "session-a" } };

    const first = await execute("call-1", {}, new AbortController().signal, undefined, toolContext);
    expect(first.details?.output).toEqual({ answeredBy: "first" });

    // Simulate a real restart: the old process is gone, a new one binds a new random port.
    // The injected resolveTarget stands in for the handle file being rewritten.
    current.stop();
    current = startServer("second");
    resolvedBaseUrl = current.baseUrl;

    // This exact call's own request really did fail (the port it was sent to is dead) --
    // never a silent double-invoke of what could be a mutating operation.
    await expect(execute("call-2", {}, new AbortController().signal, undefined, toolContext)).rejects.toThrow();

    // No reload, no re-registration -- the SAME tool object, called again, now reconnects
    // and succeeds against the new daemon instance.
    const third = await execute("call-3", {}, new AbortController().signal, undefined, toolContext);
    expect(third.details?.output).toEqual({ answeredBy: "second" });

    current.stop();
  });
});
