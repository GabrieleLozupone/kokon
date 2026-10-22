import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { helpText } from "../src/help.js";

const bundle = path.resolve(__dirname, "..", "build", "kokon-mcp.cjs");

describe("helpText", () => {
  const text = helpText("1.2.3");

  it("says what the program is and how to register it", () => {
    expect(text).toContain("kokon-mcp 1.2.3");
    expect(text).toContain("stdio");
    expect(text).toContain("claude mcp add --scope user kokon -- npx -y kokon-mcp");
  });

  it("lists every environment variable the server reads", () => {
    for (const name of ["QLS_MCP_ALLOWED_DIRS", "QLS_SERVICE_EXE", "QLS_DATA_DIR", "CLAUDE_PROJECT_DIR"]) {
      expect(text).toContain(name);
    }
  });
});

// Needs `npm run build` first, like the protocol test; skipped when the bundle is missing.
describe.skipIf(!existsSync(bundle))("built bundle", () => {
  for (const flag of ["--help", "-h"]) {
    it(`${flag} prints usage and exits 0 without starting the server`, () => {
      // execFileSync throws on a non-zero exit and the timeout fails the test if the server starts.
      const out = execFileSync(process.execPath, [bundle, flag], { encoding: "utf8", timeout: 10_000 });
      expect(out).toContain("Usage:");
      expect(out).toContain("QLS_MCP_ALLOWED_DIRS");
    });
  }
});
