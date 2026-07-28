import { describe, expect, it } from "bun:test";
import { buildTemplateBody, extractTemplateSections } from "../../src/domain/template.js";

/**
 * Test cases ported 1:1 from emcee's internal/domain/template_test.go
 * (~/Workspace/emcee) -- same heuristic, same expected output.
 */
describe("extractTemplateSections", () => {
  it("finds every section present in all samples (OCPBUGS Bug template)", () => {
    const descs = [
      "Description of problem: VFs not configured\n\nVersion-Release number of selected component (if applicable): 4.22\n\nHow reproducible: 100%\n\nSteps to Reproduce:\n1. Create an altname\n2. Create policy\n\nActual results: Node enters boot loop\n\nExpected results: VFs configured\n\nAdditional info: none",
      "Description of problem: PTP DPLL issue\n\nVersion-Release number of selected component (if applicable): 4.22\n\nHow reproducible: intermittent\n\nSteps to Reproduce:\n1. Deploy T-BC\n2. Update PtpConfig\n\nActual results: FREERUN\n\nExpected results: HOLDOVER\n\nAdditional info:",
    ];
    const want = [
      "Description of problem:",
      "Version-Release number of selected component (if applicable):",
      "How reproducible:",
      "Steps to Reproduce:",
      "Actual results:",
      "Expected results:",
      "Additional info:",
    ];
    expect(extractTemplateSections(descs)).toEqual(want);
    expect(buildTemplateBody(extractTemplateSections(descs))).toBe(want.join("\n\n"));
  });

  it("keeps only sections common to every sample (partial overlap)", () => {
    const descs = ["Summary:\n\nSteps:\n1. Do X\n\nResult:\n\nNotes:", "Summary:\n\nSteps:\n1. Do Y\n\nResult:"];
    expect(extractTemplateSections(descs)).toEqual(["Summary:", "Steps:", "Result:"]);
  });

  it("returns the single sample's own sections when given only one", () => {
    const descs = ["Problem:\n\nImpact:\n\nWorkaround:"];
    expect(extractTemplateSections(descs)).toEqual(["Problem:", "Impact:", "Workaround:"]);
  });

  it("returns undefined for empty input", () => {
    expect(extractTemplateSections([])).toBeUndefined();
  });

  it("returns undefined when every description is blank", () => {
    expect(extractTemplateSections(["", "  ", "\n"])).toBeUndefined();
  });

  it("returns undefined when there are no common sections", () => {
    const descs = ["This is a plain text bug report with no sections.", "Another unstructured report about a different thing."];
    expect(extractTemplateSections(descs)).toBeUndefined();
  });

  it("strips Jira {code} wrappers before extracting sections", () => {
    const descs = [
      "{code:java}Description of problem:\n\nVersion-Release number of selected component (if applicable):\n\nHow reproducible:\n\nSteps to Reproduce:\n\nActual results:\n\nExpected results:\n\nAdditional info:{code}",
      "{code:none}\nDescription of problem:\n\nVersion-Release number of selected component (if applicable):\n\nHow reproducible:\n\nSteps to Reproduce:\n\nActual results:\n\nExpected results:\n\nAdditional info:\n{code}",
    ];
    expect(extractTemplateSections(descs)).toEqual([
      "Description of problem:",
      "Version-Release number of selected component (if applicable):",
      "How reproducible:",
      "Steps to Reproduce:",
      "Actual results:",
      "Expected results:",
      "Additional info:",
    ]);
  });
});

describe("buildTemplateBody", () => {
  it("returns an empty string for undefined/empty sections", () => {
    expect(buildTemplateBody(undefined)).toBe("");
    expect(buildTemplateBody([])).toBe("");
  });
});
