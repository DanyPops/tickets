/**
 * Deploys the tickets daemon as an Armada-supervised service. Builds the
 * spec; createServiceCli (vehicle-server) owns install/uninstall/systemctl
 * wiring shared by every Vehicle-backed daemon's CLI.
 */
import { fileURLToPath } from "node:url";
import { createServiceCli, type ServiceCli, type ServiceSpec } from "@danypops/vehicle-server/service";
import { readPackageVersion } from "@danypops/vehicle-server/version";
import { TICKETS_DAEMON_NAMES } from "../rpc/ops.js";
import { ticketsPaths } from "./tickets-client.js";

export interface TicketsServiceSpecOptions {
  version?: string;
  /** Overridden in tests. */
  cliEntryPath?: string;
}

/** The daemon is launched as `<bin> <this CLI's entry path> serve`. */
export function ticketsServiceSpec(opts: TicketsServiceSpecOptions = {}): ServiceSpec {
  const cliEntryPath = opts.cliEntryPath ?? fileURLToPath(new URL("./index.js", import.meta.url));
  const version = opts.version ?? readPackageVersion(new URL("../../package.json", import.meta.url), "Tickets");
  return {
    name: TICKETS_DAEMON_NAMES.stateDirectoryName,
    displayName: "Tickets daemon",
    version,
    binPath: process.execPath,
    args: [cliEntryPath, "serve"],
    handlePath: ticketsPaths().handle,
    restartOnFailure: true,
    restartSec: 2,
  };
}

export function ticketsServiceCli(opts: TicketsServiceSpecOptions = {}): ServiceCli {
  return createServiceCli(ticketsServiceSpec(opts));
}
