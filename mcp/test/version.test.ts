import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

// kokon-mcp ships with the app (sidecar), on npm and in the MCP Registry under one version.
describe("version", () => {
  it("matches the app and the registry entry", () => {
    const mcp = json("../package.json").version;
    expect(mcp).toBe(json("../../package.json").version);
    const server = json("../server.json");
    expect(server.version).toBe(mcp);
    expect(server.packages[0].version).toBe(mcp);
  });
});
