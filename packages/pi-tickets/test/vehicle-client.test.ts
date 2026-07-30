import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { VehicleClient, VehicleInvocationOptions, VehicleManifest, VehicleManifestOperation } from "@danypops/vehicle-core";
import { registerTicketsVehicle, isTicketsVehicleTool, type TicketsVehicleDeps } from "../src/vehicle-client.js";

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

  constructor(private readonly value: VehicleManifest) {}

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
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
    on: () => {},
  } as unknown as ExtensionAPI;
  return { pi, tools };
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
