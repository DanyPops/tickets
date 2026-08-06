/**
 * ticketsServiceSpec()'s own values feed vehicle-server's shared
 * createServiceCli, which owns install/uninstall/systemctl wiring and unit
 * naming (armada-<name>.service) -- covered by vehicle-server's own test
 * suite. This only proves the spec itself is right, plus that
 * ticketsServiceCli() actually wires createServiceCli up.
 */
import { describe, expect, it } from "bun:test";
import { armadaUnitName, generateSystemdUnit } from "@danypops/vehicle-server/service";
import { ticketsServiceCli, ticketsServiceSpec } from "../../src/cli/systemd-service.js";

describe("ticketsServiceSpec", () => {
  it("runs `<cli entry> serve` with no extra args", () => {
    const spec = ticketsServiceSpec();
    expect(spec.args).toEqual([expect.stringContaining("index"), "serve"]);
  });

  it("declares restartOnFailure -- Armada's systemd projection is the only crash-recovery path for a service-launched daemon", () => {
    const unit = generateSystemdUnit(ticketsServiceSpec());
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=2");
  });

  it("names the service after tickets, with a real handlePath for Armada's own readiness check", () => {
    const spec = ticketsServiceSpec();
    expect(spec.name).toBe("tickets");
    expect(spec.handlePath).toContain("tickets");
    expect(spec.version).toBeTruthy();
  });

  it("accepts an injected version/cliEntryPath for tests instead of resolving this install's own paths", () => {
    const spec = ticketsServiceSpec({ version: "9.9.9", cliEntryPath: "/opt/tickets/cli/index.js" });
    expect(spec.version).toBe("9.9.9");
    expect(spec.args).toEqual(["/opt/tickets/cli/index.js", "serve"]);
  });
});

describe("ticketsServiceCli", () => {
  it("targets the real Armada-generated unit name", () => {
    expect(ticketsServiceCli().unitName).toBe(armadaUnitName("tickets"));
    expect(ticketsServiceCli().unitName).toBe("armada-tickets.service");
  });
});

describe("tickets service (real subprocess): usage", () => {
  it("exits non-zero for an unrecognized service action", async () => {
    const cliPath = new URL("../../src/cli/index.ts", import.meta.url).pathname;
    const proc = Bun.spawn(["bun", cliPath, "service", "bogus"], { stdout: "pipe", stderr: "pipe" });
    const [, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
  });
});
