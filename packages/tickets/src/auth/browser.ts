/**
 * Cross-platform "open this URL in the user's browser" helper. Deliberately
 * hand-rolled rather than a dependency: it's a 3-way platform switch behind
 * one array-form spawn call (no shell string interpolation, so no injection
 * surface from an untrusted URL), well under the size where a mature
 * dependency would remove a real bug class.
 */
import { spawn } from "node:child_process";

export type Spawner = (command: string, args: string[]) => void;

const defaultSpawner: Spawner = (command, args) => {
  const child = spawn(command, args, { stdio: "ignore", detached: true });
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
