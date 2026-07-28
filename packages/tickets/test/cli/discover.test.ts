import { describe, expect, it } from "bun:test";
import { program } from "../../src/cli/index.js";
import { TICKET_OPERATIONS } from "../../src/daemon/ops.js";

/**
 * Structural CLI-parity check for the discovery engine's three new ops:
 * every discover.* operation the daemon serves (ops.ts) must have a real
 * `tickets discover <name>` CLI command, per this environment's
 * daemon-backed-tool CLI-parity requirement.
 */
describe("tickets discover CLI", () => {
  const discoverGroup = program.commands.find((c) => c.name() === "discover");

  it("registers a discover command group", () => {
    expect(discoverGroup).toBeDefined();
  });

  it("has one subcommand per discover.* daemon operation", () => {
    const discoverOps = TICKET_OPERATIONS.filter((op) => op.startsWith("discover."));
    expect(discoverOps).toEqual(["discover.fields", "discover.statuses", "discover.template"]);

    const subcommandNames = (discoverGroup?.commands ?? []).map((c) => c.name());
    for (const op of discoverOps) {
      const short = op.split(".")[1]!;
      expect(subcommandNames).toContain(short);
    }
  });

  it("fields/statuses require --backend; template requires --backend, --project, --issue-type", () => {
    const fields = discoverGroup?.commands.find((c) => c.name() === "fields");
    const statuses = discoverGroup?.commands.find((c) => c.name() === "statuses");
    const template = discoverGroup?.commands.find((c) => c.name() === "template");

    const requiredFlags = (cmd: typeof fields) => (cmd?.options ?? []).filter((o) => o.mandatory).map((o) => o.long);

    expect(requiredFlags(fields)).toEqual(["--backend"]);
    expect(requiredFlags(statuses)).toEqual(["--backend"]);
    expect(requiredFlags(template)).toEqual(expect.arrayContaining(["--backend", "--project", "--issue-type"]));
  });
});
