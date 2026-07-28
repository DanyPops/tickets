/**
 * Per-backend manifests — YAML files mapping semantic names to backend-specific
 * values (e.g. Jira's "Target Version" -> "customfield_10855", or a Jira status
 * name -> a domain Status). Ported from emcee's internal/manifest package
 * (~/Workspace/emcee), same file layout and workflow:
 *
 *   1. Run discovery once per backend (adapter-specific: field/status listing).
 *   2. The manifest is loaded from disk (no network) on subsequent reads.
 *   3. Config-file entries override individual mappings.
 *
 * File location: $XDG_CONFIG_HOME/tickets/<kind>/<backend>.yaml (default
 * ~/.config/tickets/<kind>/<backend>.yaml) -- kind is "fields" or "statuses".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface Manifest {
  backend: string;
  /** ISO timestamp of the last successful discovery run. */
  discoveredAt?: string;
  mappings: Record<string, string>;
}

export function get(manifest: Manifest | undefined, key: string): string | undefined {
  return manifest?.mappings[key];
}

/** Returns a new Manifest with overrides applied on top; does not mutate manifest. */
export function merge(manifest: Manifest, overrides: Record<string, string>): Manifest {
  return { ...manifest, mappings: { ...manifest.mappings, ...overrides } };
}

/** Builds a fresh Manifest from already-mapped semantic-name -> value pairs. */
export function discover(backend: string, mappings: Record<string, string>): Manifest {
  return { backend, discoveredAt: new Date().toISOString(), mappings: { ...mappings } };
}

export function defaultPath(kind: string, backend: string, configDir: string): string {
  return join(configDir, kind, `${backend}.yaml`);
}

/** Reads a backend's manifest; returns an empty one (not an error) if the file doesn't exist yet. */
export function load(kind: string, backend: string, configDir: string): Manifest {
  const path = defaultPath(kind, backend, configDir);
  if (!existsSync(path)) return { backend, mappings: {} };
  const data = readFileSync(path, "utf8");
  const parsed = parseYaml(data) as Partial<Manifest> | undefined;
  return { backend, discoveredAt: parsed?.discoveredAt, mappings: parsed?.mappings ?? {} };
}

/** Writes a backend's manifest, creating the <kind> subdirectory if needed. Overwrites any existing file. */
export function save(kind: string, backend: string, configDir: string, manifest: Manifest): void {
  const dir = join(configDir, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const header =
    `# Tickets ${kind} manifest — ${backend}\n` +
    `# Run \`tickets discover ${kind === "fields" ? "fields" : "statuses"} --backend ${backend}\` to regenerate.\n` +
    "# Entries in config.yaml override individual mappings.\n\n";
  const body = stringifyYaml({ backend, discoveredAt: manifest.discoveredAt, mappings: manifest.mappings });
  writeFileSync(defaultPath(kind, backend, configDir), header + body, { mode: 0o600 });
}
