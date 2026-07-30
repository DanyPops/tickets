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

export default function (pi: ExtensionAPI, deps: PiTicketsDeps = {}) {
  registerTicketsTui(pi);
  registerTicketsSecretsCommand(pi);
  const registerVehicle = deps.registerVehicle ?? registerTicketsVehicle;
  // registerVehicleTools() (which registerTicketsVehicle wraps) needs
  // pi.getAllTools()/getActiveTools()/setActiveTools() -- Pi's extension
  // runtime only finishes initializing after every extension's top-level
  // factory (this one included) has resolved, so calling it directly from
  // here throws "Extension runtime not initialized" (previously silently
  // swallowed by registerTicketsVehicle's own daemon-unreachable try/catch,
  // making every projected tool invisible to the model with zero visible
  // sign why -- confirmed live). session_start fires only after that
  // initialization completes, and Pi awaits every session_start handler
  // before the model's first turn, so registering here is both safe and
  // still visible on turn one.
  pi.on("session_start", async () => {
    await registerVehicle(pi);
  });
}
