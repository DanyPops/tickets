/**
 * Every real ticket operation projected as its own VehicleRegistry entry,
 * one per TicketOperation, instead of pi-tickets' hand-rolled
 * `tickets(action=X)` mega-tool. Operation names are already dotted
 * (issue.list, focus.set, discover.fields, ...) in rpc/ops.ts -- Vehicle's
 * tool-name projection turns each into its own Pi tool (issue_list,
 * focus_set, discover_fields, ...) with zero renaming needed.
 *
 * Delegates every operation to rpc/server.ts's TICKET_OP_HANDLERS, the
 * exact same implementation the existing /api/v1/ops dispatch calls -- this
 * is a projection/contract layer on top of the existing application logic,
 * not a second copy of it.
 *
 * daemon.shutdown is deliberately excluded: it's an admin/lifecycle
 * operation, not something an agent should be able to call as a tool.
 */
import {
  bindVehicleOperation,
  defineErrorMapping,
  defineLooseObjectSchema,
  defineVehicleOperation,
  type LooseObjectProperty,
  passthroughVehicleSchema,
  type VehicleEffect,
} from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { BackendCapabilities, TicketService } from "../issue/service.js";
import { statusForKnownTicketError } from "../rpc/error-status.js";
import type { TicketOperation } from "../rpc/ops.js";
import { TICKET_OP_HANDLERS, type TicketsAppDeps } from "../rpc/server.js";

const OWNER = "tickets";

const withTicketsErrorParity = defineErrorMapping(
  [
    { matches: (error) => statusForKnownTicketError(error) === 404, category: "not_found" },
    { matches: (error) => statusForKnownTicketError(error) === 400, category: "validation" },
    { matches: (error) => statusForKnownTicketError(error) === 422, category: "authorization" },
  ],
  { fallbackCategory: "internal", fallbackCode: "handler-failed", fallbackMessage: "Tickets operation failed" },
);

const LIMITS = { defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

const stringProp: LooseObjectProperty = { type: "string" };
const numberProp: LooseObjectProperty = { type: "number" };

interface OperationSpec {
  readonly action: TicketOperation;
  readonly description: string;
  readonly effect: VehicleEffect;
  readonly properties: Record<string, LooseObjectProperty>;
  readonly required: readonly string[];
  /**
   * Reshapes the flat tool-facing input into whatever TICKET_OP_HANDLERS
   * expects, for the one operation where those differ: issue.list flattens
   * project/status/assignee/labels/limit as top-level tool properties
   * (matching issue.search's own flat convention, and pi-stef/atlassian's
   * jira_search_issues/jira_get_project_issues -- every filter param is its
   * own top-level property there too, never an opaque nested bag), while
   * the RPC/CLI-level handler contract keeps its existing nested
   * `filter: ListFilter` shape. Identity by default.
   */
  readonly mapInput?: (input: Record<string, unknown>) => Record<string, unknown>;
}

const stringArrayProp: LooseObjectProperty = { type: "array" };

function definedEntriesOnly(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

const OPERATIONS: readonly OperationSpec[] = [
  {
    action: "backends.list",
    description: "Lists every configured backend name (github, gitlab, jira, ...).",
    effect: "read",
    properties: {},
    required: [],
  },
  {
    action: "issue.list",
    description: "Lists issues from one backend, optionally filtered.",
    effect: "read",
    properties: {
      backend: stringProp,
      project: stringProp,
      status: stringProp,
      assignee: stringProp,
      labels: stringArrayProp,
      limit: numberProp,
    },
    required: ["backend"],
    mapInput: ({ backend, project, status, assignee, labels, limit }) => ({
      backend,
      filter: definedEntriesOnly({ project, status, assignee, labels, limit }),
    }),
  },
  {
    action: "issue.get",
    description: 'Gets one issue by its ref (e.g. "github:#42").',
    effect: "read",
    properties: { ref: stringProp },
    required: ["ref"],
  },
  {
    action: "issue.create",
    description: "Creates a new issue on a live backend -- a real, externally visible write, not a local draft.",
    effect: "external-write",
    properties: { backend: stringProp, input: { type: "object" } },
    required: ["backend", "input"],
  },
  {
    action: "issue.update",
    description: "Updates an existing issue on its live backend -- a real, externally visible write.",
    effect: "external-write",
    properties: { ref: stringProp, input: { type: "object" } },
    required: ["ref", "input"],
  },
  {
    action: "issue.search",
    description: "Searches one backend's issues by text query.",
    effect: "read",
    properties: { backend: stringProp, query: stringProp, limit: numberProp, project: stringProp },
    required: ["backend", "query"],
  },
  {
    action: "issue.children",
    description: "Lists an issue's child issues.",
    effect: "read",
    properties: { ref: stringProp },
    required: ["ref"],
  },
  {
    action: "issue.comments",
    description: "Lists an issue's comments.",
    effect: "read",
    properties: { ref: stringProp },
    required: ["ref"],
  },
  {
    action: "issue.comment_add",
    description: "Adds a comment to an issue on its live backend -- a real, externally visible write.",
    effect: "external-write",
    properties: { ref: stringProp, body: stringProp },
    required: ["ref", "body"],
  },
  {
    action: "ledger.search",
    description: "Searches the local pooled-issue ledger (no live backend call).",
    effect: "read",
    properties: { query: stringProp, limit: numberProp, backend: stringProp },
    required: ["query"],
  },
  {
    action: "ledger.stats",
    description: "Per-backend counts of issues pooled into the local ledger.",
    effect: "read",
    properties: {},
    required: [],
  },
  {
    action: "focus.set",
    description: "Sets the currently focused issue, by ref.",
    effect: "local-write",
    properties: { ref: stringProp },
    required: ["ref"],
  },
  { action: "focus.get", description: "Gets the currently focused issue, if any.", effect: "read", properties: {}, required: [] },
  {
    action: "focus.pause",
    description: "Pauses focus with an optional reason, without clearing it.",
    effect: "local-write",
    properties: { reason: stringProp },
    required: [],
  },
  { action: "focus.unpause", description: "Resumes a paused focus.", effect: "local-write", properties: {}, required: [] },
  { action: "focus.clear", description: "Clears the currently focused issue.", effect: "local-write", properties: {}, required: [] },
  {
    action: "discover.fields",
    description: "Discovers a backend's custom field display names and IDs (Jira).",
    effect: "read",
    properties: { backend: stringProp },
    required: ["backend"],
  },
  {
    action: "discover.statuses",
    description: "Discovers a backend's real status names.",
    effect: "read",
    properties: { backend: stringProp },
    required: ["backend"],
  },
  {
    action: "discover.template",
    description: "Samples recent issues for a project/issueType and extracts a reusable description template (Jira).",
    effect: "read",
    properties: { backend: stringProp, project: stringProp, issueType: stringProp, sampleSize: numberProp },
    required: ["backend", "project", "issueType"],
  },
  {
    action: "discover.board_quickfilter",
    description:
      "Resolves a Jira board's quick filter id to its JQL fragment -- the one-time step to turn a board/backlog view into a saved query.",
    effect: "read",
    properties: { backend: stringProp, boardId: numberProp, quickFilterId: numberProp },
    required: ["backend", "boardId", "quickFilterId"],
  },
  {
    action: "discover.board_filter",
    description:
      "Resolves a Jira board's own real base scope -- its saved filter's JQL -- rather than assuming it tracks one named project.",
    effect: "read",
    properties: { backend: stringProp, boardId: numberProp },
    required: ["backend", "boardId"],
  },
  {
    action: "query.save",
    description:
      "Saves a raw backend query (Jira JQL) under a name, so it can be run again later without retyping it -- e.g. a board's sprint or backlog view.",
    effect: "local-write",
    properties: { name: stringProp, backend: stringProp, query: stringProp, description: stringProp },
    required: ["name", "backend", "query"],
  },
  { action: "query.list", description: "Lists every saved query.", effect: "read", properties: {}, required: [] },
  {
    action: "query.remove",
    description: "Removes a saved query by name.",
    effect: "local-write",
    properties: { name: stringProp },
    required: ["name"],
  },
  {
    action: "query.run",
    description: "Runs a saved query by name against its backend and returns the matching issues.",
    effect: "read",
    properties: { name: stringProp, limit: numberProp },
    required: ["name"],
  },
  {
    action: "stage.add",
    description:
      "Stages a create/update/comment payload locally for review -- no live backend call. Free: never gated by the approval requirement stage.push carries.",
    effect: "local-write",
    properties: { payload: { type: "object" } },
    required: ["payload"],
  },
  {
    action: "stage.list",
    description: "Lists every currently staged (not yet pushed) payload.",
    effect: "read",
    properties: {},
    required: [],
  },
  {
    action: "stage.show",
    description: "Shows one staged payload by id.",
    effect: "read",
    properties: { id: stringProp },
    required: ["id"],
  },
  {
    action: "stage.patch",
    description:
      "Edits a staged payload's text fields in place before pushing it -- e.g. fixing a field that would otherwise fail backend validation.",
    effect: "local-write",
    properties: { id: stringProp, fields: { type: "object" } },
    required: ["id", "fields"],
  },
  {
    action: "stage.drop",
    description: "Discards a staged payload without ever sending it to a live backend.",
    effect: "local-write",
    properties: { id: stringProp },
    required: ["id"],
  },
  {
    action: "stage.push",
    description:
      "Commits a staged payload to its live backend (create, update, or comment) -- a real, externally visible write, gated the same as issue.create/issue.update/issue.comment_add.",
    effect: "external-write",
    properties: { id: stringProp },
    required: ["id"],
  },
];

/**
 * The five discover.* operations only ever succeed against a backend whose
 * repository implements the matching optional capability (Jira today,
 * structurally -- never a hardcoded backend name). An operation none of the
 * currently configured backends could possibly satisfy is marked
 * unavailable so it never appears in the LLM's callable tool list in the
 * first place, instead of being offered and then failing with
 * NotSupportedError on the first real call.
 */
const DISCOVER_AVAILABILITY: readonly { action: TicketOperation; capability: keyof BackendCapabilities; reason: string }[] = [
  { action: "discover.fields", capability: "supportsFieldDiscovery", reason: "no configured backend supports field discovery (Jira only)" },
  {
    action: "discover.statuses",
    capability: "supportsStatusDiscovery",
    reason: "no configured backend supports status discovery (Jira only)",
  },
  {
    action: "discover.template",
    capability: "supportsTemplateDiscovery",
    reason: "no configured backend supports template discovery (Jira only)",
  },
  {
    action: "discover.board_quickfilter",
    capability: "supportsBoardQuickFilterDiscovery",
    reason: "no configured backend supports board quick-filter discovery (Jira only)",
  },
  {
    action: "discover.board_filter",
    capability: "supportsBoardFilterDiscovery",
    reason: "no configured backend supports board filter discovery (Jira only)",
  },
];

/**
 * Re-syncs the five discover.* operations' availability against the
 * service's current backend set -- called once right after the registry is
 * built, and again after every live backend refresh (config.ts's
 * createBackendRefreshTask), so a Jira credential added or removed at
 * runtime flips these tools' visibility without a daemon restart.
 */
export function syncDiscoverAvailability(registry: VehicleRegistry, service: TicketService): void {
  const capabilities = service.backendCapabilities();
  for (const { action, capability, reason } of DISCOVER_AVAILABILITY) {
    const available = capabilities.some((backend) => backend[capability]);
    registry.setAvailability(action, 1, available, available ? undefined : reason);
  }
}

/**
 * Builds a VehicleRegistry exposing every real ticket operation, backed by
 * the exact same deps shape the daemon's own hand-rolled dispatch already
 * uses -- minus vehicleRegistry itself, which doesn't exist yet while this
 * is being built (bootstrap.ts constructs the full TicketsAppDeps by adding
 * this registry to the same base object afterward).
 */
export function createTicketsVehicleRegistry(deps: Omit<TicketsAppDeps, "vehicleRegistry">): VehicleRegistry {
  const registry = new VehicleRegistry({
    name: "tickets",
    version: deps.version,
    description: "Unified issue tracking across GitHub, GitLab, and Jira.",
  });
  // Every handler passes through the reviewed mapper above; unmatched failures stay redacted.
  registry.setExposeHandlerFailureDetails(true);
  // Drafting (stage.add/list/show/patch/drop) stays local-write/read -- free,
  // never gated. Committing a write to a live backend -- issue.create,
  // issue.update, issue.comment_add, or stage.push landing a staged payload --
  // is external-write, and this is what actually turns the gate on for that
  // effect: registerVehicleTools' own ctx.ui.confirm() dance (see @danypops/vehicle-client-pi)
  // then requires a real human decision before any of those four run.
  registry.configureApprovals({ requireApprovalForEffects: ["destructive", "open-world", "external-write"] });
  for (const spec of OPERATIONS) {
    const operation = defineVehicleOperation({
      name: spec.action,
      version: 1,
      description: spec.description,
      input: defineLooseObjectSchema(spec.properties, spec.required),
      output: passthroughVehicleSchema,
      permissions: ["tickets:read", "tickets:write"],
      effect: spec.effect,
      idempotency: { mode: spec.effect === "read" ? "safe" : "unsafe" },
      limits: LIMITS,
    });
    const handler = TICKET_OP_HANDLERS[spec.action];
    const mapInput = spec.mapInput ?? ((input: Record<string, unknown>) => input);
    registry.register(
      OWNER,
      bindVehicleOperation(
        operation,
        () => async (context) =>
          withTicketsErrorParity<unknown>(() => handler(deps, mapInput(context.input as Record<string, unknown>) as never)),
      ),
    );
  }

  syncDiscoverAvailability(registry, deps.service);
  return registry;
}
