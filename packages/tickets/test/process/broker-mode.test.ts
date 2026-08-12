/**
 * Vehicle Shell broker mode's daemon-side half: tickets' own bootstrap() must wire
 * vehicleName/tokenPath into the StartDaemonOptions it hands to vehicle-server's startDaemon,
 * so this daemon's own entry lands in the shared, cross-package Vehicle Handle Directory
 * (see @danypops/vehicle-server's resolveSharedVehicleHandlePath) alongside its existing
 * private handle file -- the seam a broker-mode tools_list/tools_man discovery scan (in
 * another live Vehicle-backed extension, e.g. Papyrus or Pipes) reads without needing to
 * already know tickets' own state-directory convention in advance. Mirrors papyrus/pipes/
 * web-spider/packed's own already-shipped implementations of the same rollout task.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { startDaemon } from "@danypops/vehicle-server/daemon";
import { readDaemonHandle, resolveSharedVehicleHandlePath } from "@danypops/vehicle-server/paths";
import { bootstrap } from "../../src/process/bootstrap.js";
import { TICKETS_VEHICLE_NAME } from "../../src/rpc/ops.js";

let daemon: RunningDaemon | undefined;
let tmpRoot: string | undefined;

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});

describe("tickets daemon Vehicle Shell broker mode", () => {
  it('writes an entry into the shared Vehicle Handle Directory under "tickets", carrying a real tokenPath', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tickets-daemon-broker-"));
    const env = { XDG_DATA_HOME: tmpRoot, XDG_STATE_HOME: tmpRoot, XDG_RUNTIME_DIR: tmpRoot, XDG_CONFIG_HOME: tmpRoot };
    const pathEnv = { env };

    const { options, db } = await bootstrap({ pathEnv, repos: {}, version: "0.0.0-skeleton" });
    daemon = await startDaemon(options);

    const sharedPath = resolveSharedVehicleHandlePath(TICKETS_VEHICLE_NAME, { env });
    const sharedHandle = readDaemonHandle(sharedPath);
    expect(sharedHandle?.port).toBe(daemon.port);
    expect(sharedHandle?.tokenPath).toBe(options.tokenPath);

    // The private handle (options.handlePath) is unaffected -- tokenPath is a
    // shared-directory-only concern, matching vehicle-server's own contract.
    expect(readDaemonHandle(options.handlePath)?.tokenPath).toBeUndefined();

    db.close();
  });

  it("clears the shared entry on stop, same as the private handle", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tickets-daemon-broker-stop-"));
    const env = { XDG_DATA_HOME: tmpRoot, XDG_STATE_HOME: tmpRoot, XDG_RUNTIME_DIR: tmpRoot, XDG_CONFIG_HOME: tmpRoot };
    const pathEnv = { env };

    const { options, db } = await bootstrap({ pathEnv, repos: {}, version: "0.0.0-skeleton" });
    daemon = await startDaemon(options);
    const sharedPath = resolveSharedVehicleHandlePath(TICKETS_VEHICLE_NAME, { env });
    expect(readDaemonHandle(sharedPath)).not.toBeNull();

    await daemon.stop();
    daemon = undefined;

    expect(readDaemonHandle(sharedPath)).toBeNull();
    db.close();
  });
});
