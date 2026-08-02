import { describe, expect, it } from "bun:test";
import { program } from "../../src/cli/index.js";

/**
 * CLI-parity check: `list()` and `search()` both accept a per-call project
 * override at the port/service/daemon-RPC layer (reaching e.g. ENG or
 * OPS on a Jira backend defaulting to another project) -- the CLI must
 * expose the same `--project` flag, per this environment's
 * daemon-backed-tool CLI-parity requirement.
 */
describe("tickets list/search CLI --project flag", () => {
  const list = program.commands.find((c) => c.name() === "list");
  const search = program.commands.find((c) => c.name() === "search");

  it("list has a --project flag", () => {
    expect((list?.options ?? []).map((o) => o.long)).toContain("--project");
  });

  it("search has a --project flag", () => {
    expect((search?.options ?? []).map((o) => o.long)).toContain("--project");
  });
});
