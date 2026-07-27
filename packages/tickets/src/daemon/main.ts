#!/usr/bin/env bun
/**
 * The real tickets-daemon binary. Requires Bun (bun:sqlite, Bun.serve via
 * daemon-kit). Everything else in this package (the library, the CLI, the
 * pi-tickets extension) is plain Node-compatible TypeScript and talks to
 * this process only over the loopback HTTP RPC surface — see client.ts.
 */
import { runDaemonProcess } from "@danypops/daemon-kit/daemon";
import { readPackageVersion } from "@danypops/daemon-kit/version";
import { bootstrap } from "./bootstrap.js";

const version = readPackageVersion(new URL("../../package.json", import.meta.url), "Tickets");
const { options } = await bootstrap({ version });

runDaemonProcess({
  ...options,
  onListen: (info) => {
    options.logger?.info("tickets daemon listening", { host: info.host, port: info.port, version });
  },
});
