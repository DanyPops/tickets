/**
 * pi-tickets — exposes the tickets daemon (GitHub/GitLab/Jira issue tracking)
 * two ways: real per-operation Pi tools (issue_list, focus_set,
 * discover_fields, ...) projected from the daemon's own VehicleRegistry
 * (see vehicle-client.ts and @danypops/tickets' src/vehicle/tickets-vehicle.ts),
 * and a `/tickets` interactive TUI for the human (see tui.ts) — a browsable
 * list of pooled issues across every backend, with a persistent footer status
 * showing the current focus. Neither ever talks to a backend or opens the
 * daemon's SQLite ledger directly — both go through the same authenticated
 * client the CLI uses.
 *
 * OAuth login (`tickets auth login`) and daemon lifecycle control (`tickets
 * daemon stop/restart`) are deliberately NOT exposed as a tool or a TUI
 * command: login requires a human to open a browser link and approve
 * access, and stopping the daemon out from under other callers is an
 * operational decision that belongs to a human at a terminal, not something
 * an agent or a casual keypress should trigger.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTicketsTui } from "./tui.js";
import { registerTicketsSecretsCommand } from "./secrets.js";
import { registerTicketsVehicle } from "./vehicle-client.js";

export interface PiTicketsDeps {
  /** Overridden in tests instead of exercising the real (daemon-talking) registerTicketsVehicle. */
  registerVehicle?: typeof registerTicketsVehicle;
}

export default async function (pi: ExtensionAPI, deps: PiTicketsDeps = {}) {
  registerTicketsTui(pi);
  registerTicketsSecretsCommand(pi);
  // Pi awaits a factory that returns a Promise before continuing startup
  // (before session_start, before the first turn) -- fire-and-forget here
  // would race the model's first turn against tool registration completing.
  const registerVehicle = deps.registerVehicle ?? registerTicketsVehicle;
  await registerVehicle(pi);
}
