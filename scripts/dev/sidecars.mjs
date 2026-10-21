// `npx tauri dev` (beforeDevCommand): builds kokon-service and puts it where Tauri takes its
// sidecars from (src-tauri/binaries/<name>-<target triple>). Tauri copies that file next to the
// dev shell, over the fresh cargo build, so a copy from an older checkout would run an old
// service. Also writes a dev stand-in for kokon-mcp on macOS/Linux when there is none (the
// Windows one is built by mcp/scripts/build-exe.mjs).
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)/m)[1];
const ext = process.platform === "win32" ? ".exe" : "";
const bin = join(root, "src-tauri", "binaries");

execFileSync("cargo", ["build", "-p", "qls-service"], { cwd: root, stdio: "inherit" });
mkdirSync(bin, { recursive: true });
copyFileSync(join(root, "target", "debug", `kokon-service${ext}`), join(bin, `kokon-service-${triple}${ext}`));
console.log(`kokon-service -> src-tauri/binaries/kokon-service-${triple}${ext}`);

const mcp = join(bin, `kokon-mcp-${triple}${ext}`);
if (!existsSync(mcp)) {
  if (ext) {
    console.warn(`missing ${mcp}: run  cd mcp && npm run build:exe  (only needed for the MCP server)`);
  } else {
    writeFileSync(mcp, `#!/bin/sh\nexec node "${join(root, "mcp", "build", "kokon-mcp.cjs")}" "$@"\n`);
    chmodSync(mcp, 0o755);
    console.log(`kokon-mcp dev stand-in -> ${mcp}`);
  }
}
