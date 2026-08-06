#!/usr/bin/env bun
/**
 * The real tickets-daemon binary. Requires Bun (bun:sqlite, Bun.serve via
 * vehicle-server). Everything else in this package talks to this process
 * only over the loopback HTTP RPC surface — see client.ts.
 *
 * serveMain() is also what `tickets serve` (cli/index.ts) runs directly --
 * that's the command Armada's ServiceSpec launches.
 */
import { runDaemonProcess } from "@danypops/vehicle-server/daemon";
import { readPackageVersion } from "@danypops/vehicle-server/version";
import { bootstrap } from "./bootstrap.js";

export async function serveMain(): Promise<void> {
  const version = readPackageVersion(new URL("../../package.json", import.meta.url), "Tickets");
  const { options } = await bootstrap({ version });

  runDaemonProcess({
    ...options,
    onListen: (info) => {
      options.logger?.info("tickets daemon listening", { host: info.host, port: info.port, version });
    },
  });
}

if (import.meta.main) {
  await serveMain();
}
