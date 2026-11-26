// Checks the UI texts: every key the code uses exists in src/locales/en.json (plurals as <key>_one /
// <key>_other), and lists keys nobody uses. Extra JSON files given with --with are read as if they
// were part of en.json (used while texts are being moved).
//
//   node scripts/dev/i18n-check.mjs                       # whole src/
//   node scripts/dev/i18n-check.mjs --with part.json src/components/Stage.tsx
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const args = process.argv.slice(2);
const extra = [];
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--with") extra.push(args[++i]);
  else files.push(args[i]);
}

const keys = new Set(Object.keys(JSON.parse(readFileSync(join(root, "src/locales/en.json"), "utf8"))));
for (const f of extra) for (const k of Object.keys(JSON.parse(readFileSync(f, "utf8")))) keys.add(k);

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
const scan = files.length ? files.map((f) => join(root, f)) : walk(join(root, "src"));
const whole = files.length === 0;

const used = new Set();
const problems = [];
const callRe = /\bt\(\s*(["'`])([^"'`]+)\1/g;
const transRe = /<Trans\b[^>]*\bk=(["'])([^"']+)\1/g;
for (const f of scan) {
  // Comment lines are skipped (they show examples of keys).
  const src = readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const rel = relative(root, f).replaceAll("\\", "/");
  for (const m of src.matchAll(callRe)) {
    if (m[1] === "`" && m[2].includes("${")) {
      problems.push(`${rel}: dynamic key t(\`${m[2]}\`), use a map of whole keys instead`);
      continue;
    }
    // Plural call: `count` in the variables that follow, read without consuming them, so a t()
    // nested in the variables is found too.
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
    check(rel, m[2], /^\s*,\s*\{[^}]*\bcount\b/.test(after));
  }
  for (const m of src.matchAll(transRe)) check(rel, m[2], /vars=\{\{[^}]*\bcount\b/.test(src.slice(m.index, m.index + 300)));
}

function check(rel, k, plural) {
  used.add(k);
  const has = keys.has(k) || keys.has(`${k}_other`);
  if (!has) problems.push(`${rel}: missing key "${k}"`);
  else if (plural && !keys.has(k) && !keys.has(`${k}_one`)) problems.push(`${rel}: "${k}" has _other but no _one`);
}

if (whole) {
  const base = (k) => k.replace(/_(one|other|many)$/, "");
  const unused = [...keys].filter((k) => !used.has(k) && !used.has(base(k)));
  if (unused.length) console.log(`Unused keys (${unused.length}):\n  ${unused.join("\n  ")}`);
}
if (problems.length) {
  console.log(problems.join("\n"));
  process.exit(1);
}
console.log(`OK: ${used.size} keys used in ${scan.length} files.`);
