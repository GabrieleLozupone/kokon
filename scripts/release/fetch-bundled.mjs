// Model files shipped inside the app (Tauri resources, see "bundle.resources" in
// src-tauri/tauri.conf.json): fetched at build time, never committed.
//
//   node scripts/release/fetch-bundled.mjs
//
// Downloads the upscaler of crates/qls-core/src/catalog.rs (`UPSCALER`: our mirror first, then
// the author's release) and the AI watermark models (`TRUSTMARK_P_*`) into src-tauri/resources/ unless it is already there, and checks its
// size and SHA-256 against the catalog. Runs before every `tauri dev` / `tauri build`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const catalog = fs.readFileSync(path.join(root, "crates", "qls-core", "src", "catalog.rs"), "utf8");

/** URL, mirrors, size and hash of a `Download` constant, read from the catalog. */
function entry(name) {
  const block = catalog.match(new RegExp(`pub const ${name}: Download = Download \\{([\\s\\S]*?)\\n\\};`))?.[1];
  if (!block) throw new Error(`${name} not found in catalog.rs`);
  const field = (f) => block.match(new RegExp(`\\n\\s*${f}: ([^\\n]*),`))?.[1];
  const fallbacks = [...(field("fallback_urls") ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return {
    urls: [JSON.parse(field("url")), ...fallbacks],
    size: Number(field("size").replaceAll("_", "")),
    sha256: JSON.parse(field("sha256")),
    file: path.basename(JSON.parse(field("dest"))),
  };
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function fetchBundled(name) {
  const d = entry(name);
  const dest = path.join(root, "src-tauri", "resources", d.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size === d.size && sha256(fs.readFileSync(dest)) === d.sha256) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (const url of d.urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== d.size || sha256(buf) !== d.sha256) throw new Error(`size/checksum mismatch (${buf.length} bytes)`);
      fs.writeFileSync(`${dest}.part`, buf);
      fs.renameSync(`${dest}.part`, dest);
      console.log(`bundled ${d.file} from ${url}`);
      return;
    } catch (e) {
      console.warn(`${url}: ${e.message}`);
    }
  }
  throw new Error(`could not fetch ${d.file}; put it in ${path.dirname(dest)} by hand (sha256 ${d.sha256})`);
}

await fetchBundled("UPSCALER");
// The AI watermark (crates/qls-core/src/watermark): TrustMark P, MIT.
await fetchBundled("TRUSTMARK_P_ENCODER");
await fetchBundled("TRUSTMARK_P_DECODER");
