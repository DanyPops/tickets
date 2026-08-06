/**
 * Cross-platform "open this URL in the user's browser" helper. Deliberately
 * hand-rolled rather than a dependency: it's a 3-way platform switch behind
 * one array-form spawn call (no shell string interpolation, so no injection
 * surface from an untrusted URL), well under the size where a mature
 * dependency would remove a real bug class.
 */
import { spawn } from "node:child_process";

export type Spawner = (command: string, args: string[]) => void;

// A spawn() failure (e.g. no `xdg-open` on a minimal Linux install) surfaces asynchronously as
// an unlistened "error" event under Node, which is an uncaught exception that kills the whole
// host process -- this runs from inside the long-lived pi-tickets extension host (tui.ts), not
// just the standalone CLI, so that crash is a real live risk, not just a CLI inconvenience.
export const defaultSpawner: Spawner = (command, args) => {
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", (error) => {
    console.error(`failed to open URL via ${command}: ${error instanceof Error ? error.message : String(error)}`);
  });
  child.unref();
};

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Throws on anything that isn't a well-formed http(s) URL — never hands an untrusted string to a shell. */
export function openUrl(url: string, opts: { platform?: NodeJS.Platform; spawner?: Spawner } = {}): void {
  if (!isHttpUrl(url)) throw new Error(`refusing to open non-http(s) URL: ${url}`);
  const platform = opts.platform ?? process.platform;
  const spawner = opts.spawner ?? defaultSpawner;

  if (platform === "darwin") {
    spawner("open", [url]);
    return;
  }
  if (platform === "win32") {
    spawner("cmd", ["/c", "start", '""', url]);
    return;
  }
  spawner("xdg-open", [url]);
}
