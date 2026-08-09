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
  readonly calls: Array<{ name: string; version: number; input: unknown; options: VehicleInvocationOptions | undefined }> = [];

  constructor(private value: VehicleManifest) {}

  /** Simulates a backend added/removed between manifest fetches -- e.g. tickets-vehicle.ts's syncDiscoverAvailability flipping discover.fields on a live backend change. */
  setManifest(value: VehicleManifest): void {
    this.value = value;
  }

  manifest(): Promise<VehicleManifest> {
    return Promise.resolve(this.value);
  }

  async invoke<Output = unknown>(name: string, version: number, input: unknown, options?: VehicleInvocationOptions): Promise<Output> {
    this.calls.push({ name, version, input, options });
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
  const notifications: Array<{ message: string; type: string }> = [];
  const fire = async (event: string, toolName?: string) => {
    const ctx = { ui: { notify: (message: string, type: string) => notifications.push({ message, type }) } };
    for (const handler of handlers[event] ?? []) await handler({ toolName }, ctx);
  };
  return { pi, tools, active: () => active, fire, notifications };
}

describe("registerTicketsVehicle", () => {
  it("logs client-unavailable (not silently returning) when the daemon has never started (no target resolves), and settles to undefined", async () => {
    const { pi, tools, fire } = fakePi();
    const events: unknown[] = [];
    const deps: TicketsVehicleDeps = { resolveTarget: () => undefined, retry: { attempts: 1 }, onReadyEvent: (e) => events.push(e) };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    const result = await ready;
    expect(result).toBeUndefined();
    expect(tools).toHaveLength(0);
    expect((events[0] as { kind: string }).kind).toBe("client-unavailable");
  });

  it("logs registration-failed (not silently swallowing) when the client construction or manifest fetch throws", async () => {
    const { pi, fire } = fakePi();
    const events: unknown[] = [];
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:1", token: "t" }),
      createClient: () => {
        throw new Error("connection refused");
      },
      retry: { attempts: 1 },
      onReadyEvent: (e) => events.push(e),
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    const result = await ready;
    expect(result).toBeUndefined();
    expect(events.some((e) => (e as { kind: string }).kind === "registration-failed")).toBe(true);
  });

  it("registers one Pi tool per real operation once session_start fires and a target resolves", async () => {
    const { pi, tools, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.list"), operation("focus.set")]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    const result = await ready;
    expect(result?.tools.map((t) => t.toolName).sort()).toEqual(["focus_set", "issue_list"]);
    expect(tools.map((t) => t.name).sort()).toEqual(["focus_set", "issue_list"]);
  });

  it("retries with bounded backoff and eventually registers once the daemon becomes reachable", async () => {
    const { pi, tools, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.list")]));
    let calls = 0;
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => {
        calls++;
        return calls < 3 ? undefined : { baseUrl: "http://127.0.0.1:9", token: "t" };
      },
      createClient: () => client,
      retry: { attempts: 5, initialDelayMs: 1, maxDelayMs: 2 },
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    const result = await ready;
    expect(result?.tools.map((t) => t.toolName)).toEqual(["issue_list"]);
    expect(tools.map((t) => t.name)).toEqual(["issue_list"]);
  });

  it("grants vehicle:approvals:resolve alongside tickets:read/write -- required for registerVehicleTools' own ctx.ui.confirm()-then-resolve dance on a gated write (issue.create/update/comment_add, stage.push) to actually complete once a human approves", async () => {
    const { pi, tools, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.create", { effect: "external-write" })]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    await ready;
    const tool = tools.find((t) => t.name === "issue_create")!;
    const execute = tool.execute as unknown as (
      toolCallId: string,
      input: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      context: unknown,
    ) => Promise<unknown>;
    await execute("call-1", { backend: "github", input: {} }, new AbortController().signal, undefined, {
      sessionManager: { getSessionId: () => "session-a" },
      hasUI: false,
    });
    expect(client.calls[0]?.options?.permissions).toContain("vehicle:approvals:resolve");
  });

  it("wires renderCall/renderResult for every registered operation, using the paired bounded presentation contract", async () => {
    const { pi, tools, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.comment_add")]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    await ready;
    const tool = tools[0];
    expect(tool?.renderCall).toBeDefined();
    expect(tool?.renderResult).toBeDefined();
  });

  it("persists presentation-only details while keeping model content independent and omitting raw output", async () => {
    const { pi, tools, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.get")]));
    client.result = {
      issue: {
        ref: "jira:PROJ-1",
        title: "PRESENTATION_ONLY",
        status: "todo",
        priority: "none",
        description: "RAW_OUTPUT_ONLY",
      },
      content: [{ type: "text", text: "MODEL_ONLY" }],
    };
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    await ready;

    const execute = tools[0]!.execute as unknown as (
      toolCallId: string,
      input: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      context: unknown,
    ) => Promise<{ content: unknown; details: unknown }>;
    const result = await execute("call-projection", { ref: "jira:PROJ-1" }, new AbortController().signal, undefined, {
      sessionManager: { getSessionId: () => "session-a" },
      hasUI: false,
    });

    expect(result.content).toEqual([{ type: "text", text: "MODEL_ONLY" }]);
    const serializedDetails = JSON.stringify(result.details);
    expect(serializedDetails).toContain("tickets.tool-details/v1");
    expect(serializedDetails).toContain("PRESENTATION_ONLY");
    expect(serializedDetails).not.toContain("MODEL_ONLY");
    expect(serializedDetails).not.toContain("RAW_OUTPUT_ONLY");
    expect((result.details as { output?: unknown }).output).toBeUndefined();
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
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    await ready;
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
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    await ready;

    client.setManifest(manifest([operation("discover.fields", { available: false })]));
    await fire("tool_execution_end", "read");

    expect(active()).toEqual(["discover_fields"]);
  });
});

describe("registerTicketsVehicle's default notification", () => {
  it("notifies the human once retries are exhausted, instead of leaving zero tools with zero signal", async () => {
    const { pi, fire, notifications } = fakePi();
    const deps: TicketsVehicleDeps = { resolveTarget: () => undefined, retry: { attempts: 2, initialDelayMs: 1, maxDelayMs: 2 } };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    await ready;
    expect(notifications.some((n) => n.type === "warning" && n.message.includes("tickets"))).toBe(true);
  });
});

describe("isTicketsVehicleTool", () => {
  it("recognizes every real projected tool namespace", () => {
    expect(isTicketsVehicleTool("issue_list")).toBe(true);
    expect(isTicketsVehicleTool("focus_set")).toBe(true);
    expect(isTicketsVehicleTool("ledger_search")).toBe(true);
    expect(isTicketsVehicleTool("discover_fields")).toBe(true);
    expect(isTicketsVehicleTool("backends_list")).toBe(true);
    expect(isTicketsVehicleTool("stage_add")).toBe(true);
    expect(isTicketsVehicleTool("stage_push")).toBe(true);
  });

  it("rejects an unrelated tool name", () => {
    expect(isTicketsVehicleTool("read")).toBe(false);
    expect(isTicketsVehicleTool("bash")).toBe(false);
  });
});
