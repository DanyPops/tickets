import { describe, expect, it } from "bun:test";
import type { VehicleClient, VehicleInvocationOptions, VehicleManifest, VehicleManifestOperation } from "@danypops/vehicle-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isTicketsVehicleTool, registerTicketsVehicle, type TicketsVehicleDeps } from "../src/vehicle-client.js";

type FakeEventHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

function operation(name: string, overrides: Partial<VehicleManifestOperation> = {}): VehicleManifestOperation {
  return {
    name,
    version: 1,
    description: `Run ${name}.`,
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: [] },
    outputSchema: { type: "object" },
    permissions: [],
    effect: "read",
    idempotency: { mode: "safe" },
    streaming: false,
    longRunning: false,
    limits,
    errors: [],
    available: true,
    ...overrides,
  };
}

class FakeClient implements VehicleClient {
  closed = false;
  result: unknown = { ok: true };

  constructor(private value: VehicleManifest) {}

  /** Simulates a backend added/removed between manifest fetches -- e.g. tickets-vehicle.ts's syncDiscoverAvailability flipping discover.fields on a live backend change. */
  setManifest(value: VehicleManifest): void {
    this.value = value;
  }

  manifest(): Promise<VehicleManifest> {
    return Promise.resolve(this.value);
  }

  async invoke<Output = unknown>(_name: string, _version: number, _input: unknown, _options?: VehicleInvocationOptions): Promise<Output> {
    return this.result as Output;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function manifest(operations: VehicleManifestOperation[]): VehicleManifest {
  return { name: "tickets", version: "1.0.0", description: "Tickets.", operations };
}

// Kept as a hand-rolled fake here rather than @danypops/pi-extension-harness
// (not yet published as of this commit -- once it is, this and the ExtensionAPI
// stub below become a real follow-up: see the tracked task for adopting it in
// pi-tickets' own test suite).
function fakePi() {
  const tools: ToolDefinition[] = [];
  let active: string[] = [];
  const handlers: Record<string, FakeEventHandler[]> = {};
  const pi = {
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool);
      active.push(tool.name);
    },
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    on: (event: string, handler: FakeEventHandler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
  } as unknown as ExtensionAPI;
  const fire = async (event: string, toolName?: string) => {
    for (const handler of handlers[event] ?? []) await handler({ toolName }, {});
  };
  return { pi, tools, active: () => active, fire };
}

describe("registerTicketsVehicle", () => {
  it("does nothing when the daemon has never started (no target resolves)", async () => {
    const { pi, tools } = fakePi();
    const deps: TicketsVehicleDeps = { resolveTarget: () => undefined };
    const result = await registerTicketsVehicle(pi, deps);
    expect(result).toBeUndefined();
    expect(tools).toHaveLength(0);
  });

  it("degrades silently when the client construction or manifest fetch throws", async () => {
    const { pi } = fakePi();
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:1", token: "t" }),
      createClient: () => {
        throw new Error("connection refused");
      },
    };
    const result = await registerTicketsVehicle(pi, deps);
    expect(result).toBeUndefined();
  });

  it("registers one Pi tool per real operation when a target resolves", async () => {
    const { pi, tools } = fakePi();
    const client = new FakeClient(manifest([operation("issue.list"), operation("focus.set")]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    const result = await registerTicketsVehicle(pi, deps);
    expect(result?.tools.map((t) => t.toolName).sort()).toEqual(["focus_set", "issue_list"]);
    expect(tools.map((t) => t.name).sort()).toEqual(["focus_set", "issue_list"]);
  });

  it("wires renderCall/renderResult for every registered operation, using render.ts's action-keyed rendering", async () => {
    const { pi, tools } = fakePi();
    const client = new FakeClient(manifest([operation("issue.comment_add")]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    await registerTicketsVehicle(pi, deps);
    const tool = tools[0];
    expect(tool?.renderCall).toBeDefined();
    expect(tool?.renderResult).toBeDefined();
  });
});

describe("registerTicketsVehicle's availability refresh", () => {
  it("re-syncs tool availability after one of its own tools runs, picking up a newly-unavailable operation", async () => {
    const { pi, active, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.list"), operation("discover.fields")]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    await registerTicketsVehicle(pi, deps);
    expect(active().sort()).toEqual(["discover_fields", "issue_list"]);

    // A backend refresh removed the only Jira-like backend -- tickets-vehicle.ts's
    // syncDiscoverAvailability would now mark discover.fields unavailable.
    client.setManifest(manifest([operation("issue.list"), operation("discover.fields", { available: false })]));
    await fire("tool_execution_end", "issue_list");

    expect(active().sort()).toEqual(["issue_list"]);
  });

  it("does not refresh for a tool call outside the tickets namespace", async () => {
    const { pi, active, fire } = fakePi();
    const client = new FakeClient(manifest([operation("discover.fields")]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    await registerTicketsVehicle(pi, deps);

    client.setManifest(manifest([operation("discover.fields", { available: false })]));
    await fire("tool_execution_end", "read");

    expect(active()).toEqual(["discover_fields"]);
  });
});

describe("isTicketsVehicleTool", () => {
  it("recognizes every real projected tool namespace", () => {
    expect(isTicketsVehicleTool("issue_list")).toBe(true);
    expect(isTicketsVehicleTool("focus_set")).toBe(true);
    expect(isTicketsVehicleTool("ledger_search")).toBe(true);
    expect(isTicketsVehicleTool("discover_fields")).toBe(true);
    expect(isTicketsVehicleTool("backends_list")).toBe(true);
  });

  it("rejects an unrelated tool name", () => {
    expect(isTicketsVehicleTool("read")).toBe(false);
    expect(isTicketsVehicleTool("bash")).toBe(false);
  });
});
