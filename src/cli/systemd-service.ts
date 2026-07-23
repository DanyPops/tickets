/**
 * Deploys the tickets daemon as a persistent systemd --user service, so it
 * survives logout/reboot instead of only existing for as long as some CLI
 * command's on-demand auto-spawn keeps it alive. Mirrors papyrus's own
 * `papyrus service <install|start|stop|restart|status>` pattern exactly
 * (see ~/Projects/papyrus/src/cli.ts) -- same shape, same systemctl --user
 * verbs, same install order (write unit -> daemon-reload -> enable ->
 * restart). Every side effect (file write, directory creation, systemctl
 * invocation) is injectable so this is fully testable without touching a
 * real filesystem or spawning a real systemctl process.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDaemonEntryPath } from "../client/tickets-client.js";
import { TICKETS_DAEMON_NAMES } from "../daemon/ops.js";

export interface SystemdUnitOptions {
  bunBin: string;
  daemonMainPath: string;
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
  return `[Unit]
Description=Tickets daemon -- unified GitHub/GitLab/Jira issue tracking
After=default.target

[Service]
Type=simple
ExecStart=${options.bunBin} run ${options.daemonMainPath}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** XDG_CONFIG_HOME/systemd/user/tickets-daemon.service, falling back to ~/.config like systemd itself does. */
export function systemdUnitPath(env: Record<string, string | undefined> = process.env): string {
  const configHome = env.XDG_CONFIG_HOME ?? join(env.HOME ?? "", ".config");
  return join(configHome, "systemd", "user", TICKETS_DAEMON_NAMES.systemdUnitName);
}

export type CommandRunner = (command: string, args: string[]) => void;

const defaultRunner: CommandRunner = (command, args) => {
  try {
    execFileSync(command, args, { stdio: "inherit" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${command} ${args.join(" ")} failed (is systemd --user available? this feature is Linux-only): ${message}`);
  }
};

export type SystemctlAction = "start" | "stop" | "restart" | "status" | "enable" | "daemon-reload";

/** Always targets the tickets unit name under --user scope; daemon-reload takes no unit argument. */
export function systemctlTickets(action: SystemctlAction, runner: CommandRunner = defaultRunner): void {
  const args = action === "daemon-reload" ? ["--user", "daemon-reload"] : ["--user", action, TICKETS_DAEMON_NAMES.systemdUnitName];
  runner("systemctl", args);
}

export interface InstallOptions {
  bunBin?: string;
  daemonMainPath?: string;
  env?: Record<string, string | undefined>;
  runner?: CommandRunner;
  writeFile?: (path: string, content: string) => void;
  ensureDir?: (path: string) => void;
}

/**
 * Writes the unit file, then daemon-reload -> enable -> restart, in that
 * order -- systemd must see the file before enable/restart can act on it,
 * and restart (not start) so re-running install after an upgrade picks up
 * a changed ExecStart path immediately rather than requiring a manual stop.
 */
export function installTicketsService(opts: InstallOptions = {}): { unitPath: string } {
  const unitPath = systemdUnitPath(opts.env);
  const ensureDir = opts.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const writeFile = opts.writeFile ?? writeFileSync;
  const runner = opts.runner ?? defaultRunner;

  ensureDir(dirname(unitPath));
  writeFile(
    unitPath,
    renderSystemdUnit({
      bunBin: opts.bunBin ?? process.execPath,
      daemonMainPath: opts.daemonMainPath ?? resolveDaemonEntryPath(),
    }),
  );
  systemctlTickets("daemon-reload", runner);
  systemctlTickets("enable", runner);
  systemctlTickets("restart", runner);
  return { unitPath };
}
