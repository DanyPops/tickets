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
  defineLooseObjectSchema,
  defineVehicleOperation,
  type LooseObjectProperty,
  passthroughVehicleSchema,
  type VehicleEffect,
} from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { BackendCapabilities, TicketService } from "../issue/service.js";
import type { TicketOperation } from "../rpc/ops.js";
import { type HandlerCallContext, TICKET_OP_HANDLERS, type TicketsAppDeps } from "../rpc/server.js";
import { withTicketsErrorParity } from "./error-mapping.js";

const OWNER = "tickets";

const LIMITS = { defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

const stringProp: LooseObjectProperty = { type: "string" };
const numberProp: LooseObjectProperty = { type: "number" };
const booleanProp: LooseObjectProperty = { type: "boolean" };

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
    description:
      "Lists configured backends with capabilities and local credential-safe read/write readiness. Connectivity is not probed and is always reported as not_checked.",
    effect: "read",
    properties: {},
    required: [],
  },
  {
    action: "issue.list",
    description:
      "Lists issues from one backend, optionally filtered. reportedByMe/assignedToMe/reviewRequestedOfMe/qaContactIsMe filter to the caller's own tickets using each backend's own identity (no username needed); set more than one to OR them together. reviewRequestedOfMe is GitHub/GitLab-only (PR/MR reviewer requests); qaContactIsMe is Jira-only (its discovered 'QA Contact' field) -- an unsupported flag on a given backend throws rather than being silently ignored.",
    effect: "read",
    properties: {
      backend: stringProp,
      project: stringProp,
      status: stringProp,
      assignee: stringProp,
      labels: stringArrayProp,
      limit: numberProp,
      reportedByMe: booleanProp,
      assignedToMe: booleanProp,
      reviewRequestedOfMe: booleanProp,
      qaContactIsMe: booleanProp,
    },
    required: ["backend"],
    mapInput: ({ backend, project, status, assignee, labels, limit, reportedByMe, assignedToMe, reviewRequestedOfMe, qaContactIsMe }) => ({
      backend,
      filter: definedEntriesOnly({
        project,
        status,
        assignee,
        labels,
        limit,
        reportedByMe,
        assignedToMe,
        reviewRequestedOfMe,
        qaContactIsMe,
      }),
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
    action: "issue.approve",
    description: "Approves a pull request / merge request on a live backend (GitHub, GitLab) -- a real, externally visible write.",
    effect: "external-write",
    properties: { ref: stringProp, body: stringProp },
    required: ["ref"],
  },
  {
    action: "issue.request_changes",
    description:
      "Requests changes on a pull request on a live backend -- a real, externally visible write. GitHub only: GitLab has no REST endpoint for this.",
    effect: "external-write",
    properties: { ref: stringProp, body: stringProp },
    required: ["ref", "body"],
  },
  {
    action: "issue.merge",
    description: "Merges a pull request / merge request on a live backend (GitHub, GitLab) -- a real, externally visible write.",
    effect: "external-write",
    properties: { ref: stringProp, method: stringProp },
    required: ["ref"],
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
    action: "issue.subscribe",
    description:
      "Has the daemon keep watching one issue in the background -- comments, status, and other field changes are reported through watch_events, no manual re-checking needed. Idempotent. subscriberId scopes this watch to one caller (defaults to this calling Pi session's own real session id, then a shared anonymous subscriber for a raw RPC client with no session at all); scheduleMs bounds how often that subscriber's watch is refreshed, in milliseconds (omit to refresh on every background sync tick). projectRoot attributes this subscription to a project -- defaults to this calling session's own cwd; rarely needs to be passed explicitly.",
    effect: "local-write",
    properties: { ref: stringProp, subscriberId: stringProp, scheduleMs: numberProp, projectRoot: stringProp },
    required: ["ref"],
  },
  {
    action: "issue.unsubscribe",
    description:
      "Stops the daemon watching one issue in the background. Idempotent -- no error if it wasn't subscribed. subscriberId removes only that one caller's watch, leaving any other subscriber's own watch on the same issue intact.",
    effect: "local-write",
    properties: { ref: stringProp, subscriberId: stringProp },
    required: ["ref"],
  },
  {
    action: "issue.subscribed",
    description:
      "Every issue this subscriber is currently watching -- never a live backend call, cheap to call frequently. subscriberId defaults to this calling Pi session's own real session id.",
    effect: "read",
    properties: { subscriberId: stringProp },
    required: [],
  },
  {
    action: "query.subscribe",
    description:
      "Has the daemon keep re-running one saved query in the background -- new matching items or items that drop out are reported through watch_events, no manual re-checking needed. Idempotent. subscriberId/scheduleMs/projectRoot behave exactly like issue.subscribe's own.",
    effect: "local-write",
    properties: { name: stringProp, subscriberId: stringProp, scheduleMs: numberProp, projectRoot: stringProp },
    required: ["name"],
  },
  {
    action: "query.unsubscribe",
    description: "Stops the daemon re-running one saved query in the background. Idempotent -- no error if it wasn't subscribed.",
    effect: "local-write",
    properties: { name: stringProp, subscriberId: stringProp },
    required: ["name"],
  },
  {
    action: "query.subscribed",
    description:
      "Every saved query this subscriber is currently watching -- never a live backend call, cheap to call frequently. subscriberId defaults to this calling Pi session's own real session id.",
    effect: "read",
    properties: { subscriberId: stringProp },
    required: [],
  },
  {
    action: "watch.events",
    description:
      "New change events (comments, status, label/field changes, saved-query membership changes) for everything this subscriber currently watches, since sinceId -- cheaper than re-fetching every watched issue/query yourself. Pass the previous call's lastId as sinceId to page forward; omit it once to start from 'now' without replaying history.",
    effect: "read",
    properties: { subscriberId: stringProp, sinceId: numberProp, limit: numberProp },
    required: [],
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
 * The five discover.* operations, plus the three pull-request-review operations below,
 * only ever succeed against a backend whose repository implements the matching optional
 * capability (structurally -- never a hardcoded backend name: discover.* is Jira-only
 * today, issue.approve/issue.merge need PullRequestReviewable (GitHub, GitLab both),
 * issue.request_changes needs PullRequestChangesRequestable (GitHub only)). An operation
 * none of the currently configured backends could possibly satisfy is marked unavailable
 * so it never appears in the LLM's callable tool list in the first place, instead of being
 * offered and then failing with NotSupportedError on the first real call.
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
  {
    action: "issue.approve",
    capability: "supportsPullRequestReview",
    reason: "no configured backend supports pull request review (GitHub, GitLab)",
  },
  {
    action: "issue.merge",
    capability: "supportsPullRequestReview",
    reason: "no configured backend supports pull request review (GitHub, GitLab)",
  },
  {
    action: "issue.request_changes",
    capability: "supportsPullRequestChangesRequest",
    reason: "no configured backend supports requesting changes on a pull request (GitHub only)",
  },
];

/**
 * Re-syncs every capability-gated operation's availability (the five discover.* operations
 * plus issue.approve/issue.request_changes/issue.merge) against the service's current
 * backend set -- called once right after the registry is built, and again after every live
 * backend refresh (config.ts's createBackendRefreshTask), so a Jira credential added or a
 * GitHub/GitLab backend added or removed at runtime flips these tools' visibility without a
 * daemon restart. Name kept from before pull-request support existed -- still exported and
 * called by that name from bootstrap.ts and existing tests.
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
          withTicketsErrorParity<unknown>(() => {
            // Threaded through unconditionally -- harmless for the vast majority of handlers that
            // never read it; issue.subscribe/query.subscribe (and their siblings) use it to default
            // subscriberId/projectRoot from this real call's own session identity, mirroring
            // @danypops/pipes' own ci.subscribe. See HandlerCallContext's own doc comment.
            const callContext: HandlerCallContext = {
              callerSessionId: context.callerSessionId,
              callerProjectRoot: context.callerProjectRoot,
            };
            return handler(deps, mapInput(context.input as Record<string, unknown>) as never, callContext);
          }),
      ),
    );
  }

  syncDiscoverAvailability(registry, deps.service);
  return registry;
}
