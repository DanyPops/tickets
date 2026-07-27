import { describe, expect, it } from "bun:test";
import { openUrl } from "../../src/auth/browser.js";

describe("openUrl", () => {
  it("refuses non-http(s) URLs without ever invoking the spawner", () => {
    let called = false;
    expect(() =>
      openUrl("javascript:alert(1)", {
        spawner: () => {
          called = true;
        },
      }),
    ).toThrow();
    expect(called).toBe(false);
  });

  it("picks `open` on darwin, `xdg-open` on linux, and `cmd` on win32", () => {
    const seen: { command: string; args: string[] }[] = [];
    const spawner = (command: string, args: string[]) => {
      seen.push({ command, args });
    };

    openUrl("https://example.com", { platform: "darwin", spawner });
    openUrl("https://example.com", { platform: "linux", spawner });
    openUrl("https://example.com", { platform: "win32", spawner });

    expect(seen[0]?.command).toBe("open");
    expect(seen[1]?.command).toBe("xdg-open");
    expect(seen[2]?.command).toBe("cmd");
    expect(seen.every((s) => s.args.includes("https://example.com"))).toBe(true);
  });
});
