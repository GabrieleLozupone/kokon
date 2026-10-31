// End-to-end over stdio with the official MCP client. Starts kokon-service on demand
// (no generation, so no GPU work) using an isolated data/config folder and ports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..");
// The app version (kept equal in package.json, Cargo.toml and tauri.conf.json at every release).
const appVersion: string = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const serviceExe = process.platform === "win32" ? "kokon-service.exe" : "kokon-service";
// The most recently built service (debug or release), so a stale build is not tested.
const serviceBuild = ["debug", "release"]
  .map((b) => path.join(root, "target", b, serviceExe))
  .filter((p) => fs.existsSync(p))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qls-mcp-proto-"));
const env = {
  ...process.env,
  QLS_DATA_DIR: path.join(tmp, "data"),
  QLS_CONFIG_DIR: path.join(tmp, "config"),
  QLS_SERVICE_EXE: serviceBuild ?? path.join(root, "target", "debug", serviceExe),
} as Record<string, string>;
delete env.CLAUDE_PROJECT_DIR;
fs.mkdirSync(env.QLS_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(env.QLS_CONFIG_DIR, "config.json"), JSON.stringify({ servicePort: 39181, serverPort: 39180, outputDir: path.join(tmp, "out") }));
const proj = path.join(tmp, "project");
fs.mkdirSync(proj);
// 1x1 PNG
fs.writeFileSync(path.join(proj, "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

let client: Client;

beforeAll(async () => {
  client = new Client({ name: "qls-test", version: "1.0.0" });
  const exe = process.env.QLS_MCP_EXE;
  await client.connect(new StdioClientTransport({ command: exe ?? process.execPath, args: exe ? [] : [path.join(root, "mcp", "build", "kokon-mcp.cjs")], env, cwd: proj, stderr: "pipe" }));
}, 30_000);

afterAll(async () => {
  await client?.close();
  try {
    const info = JSON.parse(fs.readFileSync(path.join(env.QLS_DATA_DIR, "service.json"), "utf8"));
    await fetch(`http://127.0.0.1:${info.port}/api/v1/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${info.token}` } });
  } catch {
    /* not started */
  }
});

describe("MCP protocol", () => {
  it("lists the tools with schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "edit_image",
      "edit_images",
      "generate_image",
      "generate_video",
      "get_generator_status",
      "get_image_info",
      "inpaint_image",
      "outpaint_image",
      "upscale_image",
    ]);
    const gen = tools.find((t) => t.name === "generate_image")!;
    expect(gen.inputSchema.required).toEqual(["prompt"]);
    const vid = tools.find((t) => t.name === "generate_video")!;
    expect(vid.inputSchema.required).toEqual(["prompt"]);
  });

  it("rejects invalid arguments", async () => {
    const r = await client.callTool({ name: "generate_image", arguments: { prompt: "" } }).catch((e) => ({ isError: true, content: [{ type: "text", text: String(e) }] }));
    expect(r.isError).toBe(true);
  });

  it("starts the service on demand and reports status", async () => {
    const r = await client.callTool({ name: "get_generator_status", arguments: {} });
    expect(r.isError).toBe(false);
    const s = r.structuredContent as Record<string, unknown>;
    expect(s).toHaveProperty("server_running");
    expect(s).toHaveProperty("model_loaded");
    expect(s.service_version).toBe(appVersion);
  }, 60_000);

  it("get_image_info reads a project image and blocks paths outside", async () => {
    const ok = await client.callTool({ name: "get_image_info", arguments: { image_path: "dot.png" } });
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent).toMatchObject({ width: 1, height: 1, file_type: "png" });
    const bad = await client.callTool({ name: "get_image_info", arguments: { image_path: path.join(os.tmpdir(), "cmd.png") } });
    expect(bad.isError).toBe(true);
    expect((bad.structuredContent as { error: { code: string } }).error.code).toBe("invalid_path");
  }, 60_000);

  it("edit_image refuses traversal before contacting the generator", async () => {
    const r = await client.callTool({ name: "edit_image", arguments: { image_path: "..\\..\\secret.png", prompt: "x" } });
    expect(r.isError).toBe(true);
  });
});
