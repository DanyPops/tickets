import { describe, expect, it } from "bun:test";
import { program } from "../../src/cli/index.js";
import { TICKET_OPERATIONS } from "../../src/rpc/ops.js";

/**
 * Structural CLI-parity check for the staging engine's six new ops: every
 * stage.* operation the daemon serves (ops.ts) must have a real `tickets
 * stage <name>` CLI command, per this environment's daemon-backed-tool
 * CLI-parity requirement.
 */
describe("tickets stage CLI", () => {
  const stageGroup = program.commands.find((c) => c.name() === "stage");

  it("registers a stage command group", () => {
    expect(stageGroup).toBeDefined();
  });

  it("has one subcommand per stage.* daemon operation", () => {
    const stageOps = TICKET_OPERATIONS.filter((op) => op.startsWith("stage."));
    expect(stageOps).toEqual(["stage.add", "stage.list", "stage.show", "stage.patch", "stage.drop", "stage.push"]);

    const subcommandNames = (stageGroup?.commands ?? []).map((c) => c.name());
    for (const op of stageOps) {
      const short = op.split(".")[1]!;
      expect(subcommandNames).toContain(short);
    }
  });

  it("show/patch/drop/push all take an <id> argument", () => {
    for (const name of ["show", "patch", "drop", "push"]) {
      const cmd = stageGroup?.commands.find((c) => c.name() === name);
      expect(cmd?.registeredArguments.map((a) => a.name())).toContain("id");
    }
  });
});
