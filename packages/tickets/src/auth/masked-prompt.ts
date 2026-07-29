/**
 * Reads a secret from a real TTY with keystrokes masked -- never echoed to
 * the terminal, so it can't land in scrollback or a screen share the way a
 * typed-and-visible value would. Falls back to reading one line from stdin
 * unmasked when stdin isn't a TTY (piped input, e.g. `pass show jira |
 * tickets auth set-token jira`) -- there is nothing to mask once the value
 * never touched an interactive terminal in the first place.
 */
import { createInterface } from "node:readline";

export function promptMaskedSecret(
  promptText: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  const isTTY = (input as NodeJS.ReadStream).isTTY === true;

  if (!isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      input.setEncoding?.("utf8");
      input.on("data", (chunk) => {
        data += chunk;
      });
      input.on("end", () => resolve(data.split("\n")[0]?.trim() ?? ""));
      input.on("error", reject);
    });
  }

  return new Promise((resolve, reject) => {
    const rl = createInterface({ input, output, terminal: true });
    // readline has no public masking option; overriding the internal
    // _writeToOutput hook (long-standing, widely-used pattern for exactly
    // this) is the only way to suppress echoed keystrokes while still
    // letting the prompt text itself render once.
    // biome-ignore lint/suspicious/noExplicitAny: readline's internal _writeToOutput has no public type
    const rlInternal = rl as any;
    const originalWriteToOutput = rlInternal._writeToOutput.bind(rl);
    let promptShown = false;
    rlInternal._writeToOutput = (stringToWrite: string) => {
      if (!promptShown) {
        originalWriteToOutput(stringToWrite);
        if (stringToWrite.includes(promptText)) promptShown = true;
      }
      // Every keystroke after the prompt itself is swallowed -- masked.
    };
    rl.question(promptText, (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer.trim());
    });
    rl.on("error", reject);
  });
}
