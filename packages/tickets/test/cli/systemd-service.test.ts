import { describe, expect, it } from "bun:test";
import {
  installTicketsService,
  renderSystemdUnit,
  systemctlTickets,
  systemdUnitPath,
} from "../../src/cli/systemd-service.js";

describe("renderSystemdUnit", () => {
  it("points ExecStart at the exact bun binary and daemon entry path given, with an always-restart policy", () => {
    const unit = renderSystemdUnit({ bunBin: "/home/x/.bun/bin/bun", daemonMainPath: "/opt/tickets/src/daemon/main.ts" });
    expect(unit).toContain("ExecStart=/home/x/.bun/bin/bun run /opt/tickets/src/daemon/main.ts");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("systemdUnitPath", () => {
  it("resolves under XDG_CONFIG_HOME/systemd/user/tickets-daemon.service", () => {
    const path = systemdUnitPath({ XDG_CONFIG_HOME: "/home/x/.config" });
    expect(path).toBe("/home/x/.config/systemd/user/tickets-daemon.service");
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const path = systemdUnitPath({ HOME: "/home/x" });
    expect(path).toBe("/home/x/.config/systemd/user/tickets-daemon.service");
  });
});

describe("systemctlTickets", () => {
  it("always runs against the tickets unit name, under --user scope", () => {
    const calls: { command: string; args: string[] }[] = [];
    systemctlTickets("restart", (command, args) => calls.push({ command, args }));
    expect(calls).toEqual([{ command: "systemctl", args: ["--user", "restart", "tickets-daemon.service"] }]);
  });

  it("daemon-reload and enable omit the unit name / take it as documented by systemctl itself", () => {
    const calls: { command: string; args: string[] }[] = [];
    systemctlTickets("daemon-reload", (command, args) => calls.push({ command, args }));
    systemctlTickets("enable", (command, args) => calls.push({ command, args }));
    expect(calls).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "tickets-daemon.service"] },
    ]);
  });
});

describe("installTicketsService", () => {
  it("writes the unit file, then reloads, enables, and restarts it in that order — never starting before the file exists", () => {
    const writes: { path: string; content: string }[] = [];
    const dirsEnsured: string[] = [];
    const systemctlCalls: string[] = [];

    const { unitPath } = installTicketsService({
      bunBin: "/home/x/.bun/bin/bun",
      daemonMainPath: "/opt/tickets/src/daemon/main.ts",
      env: { XDG_CONFIG_HOME: "/home/x/.config" },
      ensureDir: (dir) => dirsEnsured.push(dir),
      writeFile: (path, content) => writes.push({ path, content }),
      runner: (_command, args) => systemctlCalls.push(args.join(" ")),
    });

    expect(unitPath).toBe("/home/x/.config/systemd/user/tickets-daemon.service");
    expect(dirsEnsured).toEqual(["/home/x/.config/systemd/user"]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(unitPath);
    expect(writes[0]?.content).toContain("ExecStart=/home/x/.bun/bin/bun run /opt/tickets/src/daemon/main.ts");
    // Order matters: the unit file must exist on disk before daemon-reload,
    // and the daemon must be reloaded before systemd will accept enable/restart.
    expect(systemctlCalls).toEqual([
      "--user daemon-reload",
      "--user enable tickets-daemon.service",
      "--user restart tickets-daemon.service",
    ]);
  });

  it("defaults bunBin to the current process's own executable and daemonMainPath to the real resolver", () => {
    const writes: { path: string; content: string }[] = [];
    installTicketsService({
      env: { XDG_CONFIG_HOME: "/home/x/.config" },
      ensureDir: () => {},
      writeFile: (path, content) => writes.push({ path, content }),
      runner: () => {},
    });
    expect(writes[0]?.content).toContain(`ExecStart=${process.execPath} run `);
    expect(writes[0]?.content).toContain("src/daemon/main.ts");
  });
});
