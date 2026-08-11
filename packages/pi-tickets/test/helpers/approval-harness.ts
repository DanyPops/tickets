/**
 * Exercises formatApprovalInput/titleForApproval together, in exactly the shape
 * vehicle-client.ts's own `approvalPrompt` option combines them (see its doc comment) --
 * a test asserting against renderApprovalPrompt's output is asserting against the real
 * prompt a human sees, not two functions verified only in isolation from each other.
 */
import { formatApprovalInput, titleForApproval } from "../../src/render.js";

export interface RenderedApproval {
  title: string;
  message: string;
}

export function renderApprovalPrompt(operationName: string, effect: string, input: unknown): RenderedApproval {
  return {
    title: titleForApproval(operationName, input),
    message: `${operationName} (${effect} effect) requests approval before it can run.\n\n${formatApprovalInput(input)}`,
  };
}
