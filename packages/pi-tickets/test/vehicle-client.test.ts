import { beforeEach, describe, expect, it } from "bun:test";
import { __resetInProcessVehicleRegistryForTests, __resetVehicleShellHandleForTests } from "@danypops/vehicle-client-pi/test-utils";
import {
  type VehicleClient,
  VehicleError,
  type VehicleInvocationOptions,
  type VehicleManifest,
  type VehicleManifestOperation,
} from "@danypops/vehicle-core";
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

/**
 * Simulates a VehicleRegistry with configureApprovals() enabled: the first invoke() of the
 * gated operation always reports approval-required with a fixed requestId; vehicle.approval.resolve
 * mints "real-capability" only on a granted decision; a retried invoke() only succeeds when that
 * exact capability is presented. Mirrors vehicle-client-pi's own test/vehicle-pi.test.ts fixture of
 * the same name/shape, for the same reason: exercising the real approval-required retry dance
 * end to end, not a stubbed-out shortcut.
 */
class ApprovalFlowClient implements VehicleClient {
  readonly calls: Array<{ name: string; version: number; input: unknown; options: VehicleInvocationOptions | undefined }> = [];

  constructor(private value: VehicleManifest) {}

  manifest(): Promise<VehicleManifest> {
    return Promise.resolve(this.value);
  }

  async invoke<Output = unknown>(name: string, version: number, input: unknown, options?: VehicleInvocationOptions): Promise<Output> {
    this.calls.push({ name, version, input, options });
    if (name === "vehicle.approval.resolve") {
      const { requestId, decision } = input as { requestId: string; decision: "granted" | "denied" };
      return { requestId, decision, ...(decision === "granted" ? { capability: "real-capability" } : {}) } as Output;
    }
    if (options?.approvalCapability === "real-capability") return { ok: true } as Output;
    throw new VehicleError("approval-required", `${name}@${version} requires approval`, {
      category: "authorization",
      retryable: true,
      details: { requestId: "req-1", expiresAt: Date.now() + 60_000 },
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
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
  const fire = async (event: string, toolName?: string, ctxOverrides: Record<string, unknown> = {}) => {
    const ctx = {
      ui: { notify: (message: string, type: string) => notifications.push({ message, type }), setWidget: () => {} },
      ...ctxOverrides,
    };
    for (const handler of handlers[event] ?? []) await handler({ toolName }, ctx);
  };
  return { pi, tools, active: () => active, fire, notifications };
}

// registerVehicleTools()'s shared Vehicle Shell handle and in-process vehicle registry are both
// process-wide globalThis singletons -- bun test runs this whole package's test files in one
// process, so an earlier test's own registration would otherwise silently "win" the shared handle
// forever, leaving a later test's own fresh fake pi with tools_list/tools_man never registered on
// it at all. See @danypops/vehicle-client-pi/test-utils's own doc comment.
beforeEach(() => {
  __resetVehicleShellHandleForTests();
  __resetInProcessVehicleRegistryForTests();
});

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
      // "connection refused" is stale-connection-shaped -- without disabling connectRetry here,
      // this would wait out the real ~5s background retry budget before failing (see
      // vehicle-client's own DEFAULT_CONNECT_RETRY); this test is about the failure being
      // logged, not about how long the retry budget itself takes.
      connectRetry: false,
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
    // Unrelated to broker/shell mode -- disabled so this test's registered-tool-names assertion
    // stays about every real operation getting its own tool, not shell's own meta-tools.
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
      shell: undefined,
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    const result = await ready;
    expect(result?.tools.map((t) => t.toolName).sort()).toEqual(["focus_set", "issue_list"]);
    expect(tools.map((t) => t.name).sort()).toEqual(["focus_set", "issue_list"]);
  });

  it('turns Vehicle Shell broker mode on: registers a discoverable shell handle under the "tickets" vehicle name', async () => {
    const { pi, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.list")]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    const result = await ready;
    // registerVehicleTools only returns a shell handle at all when shell mode is on -- this is
    // the same observable this repo's own sibling projects (e.g. pi-pipes) assert broker mode by.
    expect(result?.shell).toBeDefined();
  });

  it("keeps only the core operations immediately active, leaving the rest behind tools_man", async () => {
    const { pi, active, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.list"), operation("issue.get"), operation("discover.fields")]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    await ready;
    // issue.list and issue.get are both in TICKETS_CORE_OPERATIONS -- active from turn one.
    // discover.fields is not -- reachable only via tools_list/tools_man, not directly active.
    expect(active().sort()).toEqual(["issue_get", "issue_list", "tools_list", "tools_man", "tools_type"]);
  });

  it("retries with bounded backoff and eventually registers once the daemon becomes reachable", async () => {
    const { pi, tools, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.list")]));
    let calls = 0;
    // Unrelated to broker/shell mode -- disabled so this test's registered-tool-names assertion
    // stays about the retry-then-register sequence, not shell's own meta-tools.
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => {
        calls++;
        return calls < 3 ? undefined : { baseUrl: "http://127.0.0.1:9", token: "t" };
      },
      createClient: () => client,
      retry: { attempts: 5, initialDelayMs: 1, maxDelayMs: 2 },
      shell: undefined,
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    const result = await ready;
    expect(result?.tools.map((t) => t.toolName)).toEqual(["issue_list"]);
    expect(tools.map((t) => t.name)).toEqual(["issue_list"]);
  });

  it("grants vehicle:approvals:resolve alongside tickets:read/write -- required for registerVehicleTools' own approval-then-resolve dance on a gated write (issue.create/update/comment_add, stage.push) to actually complete once a human approves", async () => {
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

  it("wires requestApproval to requestPiApprovalViaAskPrompt: an external-write approval prompts via ctx.ui.select/input (the ask-prompt dialog fallback), never ctx.ui.confirm", async () => {
    const { pi, tools, fire } = fakePi();
    const client = new ApprovalFlowClient(manifest([operation("issue.create", { effect: "external-write" })]));
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

    const selectCalls: Array<{ title: string; options: string[] }> = [];
    const result = await execute("call-1", { backend: "github", input: {} }, new AbortController().signal, undefined, {
      sessionManager: { getSessionId: () => "session-a" },
      hasUI: true,
      ui: {
        select: async (title: string, opts: string[]) => {
          selectCalls.push({ title, options: opts });
          return "Approve";
        },
        input: async () => undefined,
        confirm: async () => {
          throw new Error("the default requestPiApproval dialog must not run once requestApproval is wired");
        },
        notify: () => {},
      },
    });

    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]?.options).toEqual(["Approve", "Deny"]);
    expect(client.calls.map((call) => call.name)).toEqual(["issue.create", "vehicle.approval.resolve", "issue.create"]);
    expect(client.calls[1]?.input).toMatchObject({ requestId: "req-1", decision: "granted" });
    expect(client.calls[2]?.options?.approvalCapability).toBe("real-capability");
    expect(result).toBeTruthy();
  });

  it('requests the overlay presentation (a bigger centered box) rather than requestPiAskPrompt\'s own "integrated" default (docked in the input editor, confirmed live to need scrolling for ordinary approval content)', async () => {
    const { pi, tools, fire } = fakePi();
    const client = new ApprovalFlowClient(manifest([operation("issue.create", { effect: "external-write" })]));
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

    // A context capable of hosting EITHER presentation -- which one vehicle-client-pi actually
    // reaches for is entirely governed by the approvalPresentation option under test here.
    const overlayCalls: unknown[] = [];
    const integratedCalls: unknown[] = [];
    const result = await execute("call-1", { backend: "github", input: {} }, new AbortController().signal, undefined, {
      sessionManager: { getSessionId: () => "session-a" },
      hasUI: true,
      mode: "tui",
      ui: {
        // The real component this factory would build resolves with an internal
        // AskResponse-shaped answer (see hitl-ask-prompt.js's own toAskAnswer), not the final
        // PiApprovalAnswer -- this fake stands in for a real "Approve" selection without needing
        // to actually drive the full select-list component's own render/input loop.
        custom: async (_factory: unknown, options: unknown) => {
          overlayCalls.push(options);
          return { kind: "selection", selections: ["Approve"] };
        },
        setEditorComponent: () => {
          integratedCalls.push("integrated");
        },
        getEditorComponent: () => undefined,
        getEditorText: () => "",
        select: async () => {
          throw new Error("must not fall back to the plain select/input dialog once overlay hosting is available");
        },
        input: async () => undefined,
        confirm: async () => {
          throw new Error("must not use the plain confirm dialog once overlay hosting is available");
        },
        notify: () => {},
      },
    });

    expect(overlayCalls).toHaveLength(1);
    expect(integratedCalls).toHaveLength(0);
    expect(result).toBeTruthy();
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
    // Unrelated to broker/shell mode -- disabled here so this test's own active-set assertions
    // stay about availability refresh, not shell's own core/tools_man split.
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
      shell: undefined,
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
    // Unrelated to broker/shell mode -- disabled here for the same reason as the sibling test above.
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
      shell: undefined,
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

describe("registerTicketsVehicle's watch-events poll", () => {
  it("starts polling watch.events once tools register, only for a real UI session", async () => {
    const { pi, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.list")]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    await ready;

    try {
      // hasUI: false (this first session_start, matching every other test's default ctx) --
      // no poll should ever have started, so a second session_start with hasUI true is what
      // actually triggers the very first watch.events call below.
      expect(client.calls.some((c) => c.name === "watch.events")).toBe(false);

      await fire("session_start", undefined, { hasUI: true, sessionManager: { getSessionId: () => "session-a" } });
      // start() fires its first tick without awaiting it (fire-and-forget) -- one microtask is
      // enough for that fire-and-forget promise chain to reach the fake client's own resolved invoke().
      await Promise.resolve();
      await Promise.resolve();

      const call = client.calls.find((c) => c.name === "watch.events");
      expect(call).toMatchObject({ input: { subscriberId: "session-a", sinceId: undefined } });
    } finally {
      // Must stop the poll's own setInterval -- an un-stopped timer would otherwise keep firing
      // (and keep the fake client alive) for the rest of this entire test process.
      await fire("session_shutdown");
    }
  });

  it("never starts the poll at all when no session ever has a UI", async () => {
    const { pi, fire } = fakePi();
    const client = new FakeClient(manifest([operation("issue.list")]));
    const deps: TicketsVehicleDeps = {
      resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      createClient: () => client,
    };
    const ready = registerTicketsVehicle(pi, deps);
    await fire("session_start");
    await ready;
    await fire("session_start");
    await Promise.resolve();
    await Promise.resolve();

    expect(client.calls.some((c) => c.name === "watch.events")).toBe(false);
    await fire("session_shutdown");
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
