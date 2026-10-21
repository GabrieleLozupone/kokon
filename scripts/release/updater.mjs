// Update manifest for the in-app updater (Tauri), built from releases made on two machines.
//
//   node scripts/release/updater.mjs fragment <platform> <signed bundle>
//       platform: windows-x86_64, darwin-aarch64, linux-x86_64-deb or linux-x86_64-rpm (the
//       Linux updater picks the entry of the package type it was installed from).
//       Copies the bundle into dist-release/ under a stable, versioned name and writes
//       dist-release/updater-<platform>.json (file name + signature from <bundle>.sig).
//   node scripts/release/updater.mjs manifest [--notes "What's new"]
//       Merges every dist-release/updater-*.json into dist-release/latest.json, with download
//       URLs of the GitHub release v<version>. Upload latest.json with the other files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, "dist-release");
const REPO = "GabrieleLozupone/kokon";
const version = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const [cmd, ...args] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });

if (cmd === "fragment") {
  const [platform, bundle] = args;
  const names = {
    "windows-x86_64": `Kokon_${version}_x64-setup.exe`,
    "darwin-aarch64": `Kokon_${version}_aarch64.app.tar.gz`,
    "linux-x86_64-deb": `Kokon_${version}_amd64.deb`,
    "linux-x86_64-rpm": `Kokon-${version}-1.x86_64.rpm`,
  };
  if (!names[platform] || !bundle) throw new Error(`usage: fragment <${Object.keys(names).join("|")}> <bundle>`);
  const sig = fs.readFileSync(`${bundle}.sig`, "utf8").trim();
  // GitHub turns spaces in asset names into dots: keep names space-free and versioned.
  const name = names[platform];
  fs.copyFileSync(bundle, path.join(out, name));
  fs.writeFileSync(path.join(out, `updater-${platform}.json`), JSON.stringify({ version, platform, file: name, signature: sig }, null, 2));
  console.log(`updater entry: ${platform} -> ${name}`);
} else if (cmd === "manifest") {
  const i = args.indexOf("--notes");
  const notes = i >= 0 ? args[i + 1] : `Kokon ${version}`;
  const platforms = {};
  for (const f of fs.readdirSync(out).filter((f) => /^updater-.+\.json$/.test(f))) {
    const e = JSON.parse(fs.readFileSync(path.join(out, f), "utf8"));
    if (e.version !== version) throw new Error(`${f} is for ${e.version}, but the app version is ${version}: rebuild it.`);
    platforms[e.platform] = { signature: e.signature, url: `https://github.com/${REPO}/releases/download/v${version}/${e.file}` };
  }
  if (!Object.keys(platforms).length) throw new Error("No updater-*.json in dist-release: run a release build first.");
  const manifest = { version, notes, pub_date: new Date().toISOString(), platforms };
  fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(manifest, null, 2));
  console.log(`dist-release/latest.json: ${version} for ${Object.keys(platforms).join(", ")}`);
} else {
  throw new Error("usage: updater.mjs fragment <platform> <bundle> | manifest [--notes text]");
}
