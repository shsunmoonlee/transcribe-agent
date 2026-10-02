#!/usr/bin/env node
// Builds the OpenAI Plugins Directory submission ZIP (Codex plugin format) from this repo and
// runs the listing-tier copy scan. The rule list below mirrors the MCP-tier rules in transcribe.so
// app/mcp/catalog.ts but is the stricter listing tier (directory metadata and skills); it is
// duplicated knowingly because this is a separate public repo with no path to that module.
//
// Usage: node scripts/build-openai-plugin.mjs [--video-url <https-url>]   (or env DEMO_RECORDING_URL)
// Output: out/openai-plugin/ (staging) and out/transcribe-so-openai-plugin.zip
// Guidelines: https://developers.openai.com/plugins/plugin-guidelines
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = join(ROOT, "out");
const OUT_DIR = join(OUT_ROOT, "openai-plugin");
const ZIP = join(OUT_ROOT, "transcribe-so-openai-plugin.zip");
const EM_DASH = String.fromCharCode(0x2014);

// Listing tier: everything the directory's metadata and skills check reads, except
// commerce_description, which exists to describe commerce behaviour and gets its own list.
const BANNED = ["pric", "$", "€", "£", "free", "top up", "top-up", "upgrade", "subscri", "promo", "discount",
  "trial", "wallet", "balance", "paid", "pay", "charg", "plan", "credit", "billing", "cost", "dollar", "buy",
  "purchas", "checkout", "coupon", "stripe"];
const BANNED_PATTERNS = [/\d\s*(%|cents?\b|usd\b)/i];
const COMMERCE_BANNED = ["pric", "$", "free", "top up", "top-up", "subscri", "promo", "discount", "trial", "wallet",
  "balance", "credit", "billing", "cost", "dollar", "plan"];
// Field names and the command argument placeholder, not copy: stripped before scanning.
const CODE_TOKENS = ["max_charge_exceeded", "max_charge_usd", "charge_usd", "retail_usd", "commerce_description", "$ARGUMENTS"];
// Every http(s) URL in scanned text must point at one of these hosts.
const ALLOWED_HOSTS = ["transcribe.so", "www.transcribe.so", "github.com"];
// Manifests for the other directories: same version as the Codex manifest, descriptions scanned.
const OTHER_MANIFESTS = [
  [".claude-plugin/plugin.json", (m) => m.version],
  [".claude-plugin/marketplace.json", (m) => m.metadata && m.metadata.version],
  [".cursor-plugin/plugin.json", (m) => m.version],
  [".grok-plugin/plugin.json", (m) => m.version],
  ["gemini-extension.json", (m) => m.version],
];

let cleanOnFail = false;
function fail(lines) {
  for (const l of [].concat(lines)) console.error(l);
  if (cleanOnFail) rmSync(OUT_ROOT, { recursive: true, force: true });
  process.exit(1);
}

function stripTokens(s) {
  let out = s.toLowerCase();
  for (const t of CODE_TOKENS) out = out.split(t.toLowerCase()).join(" ");
  return out;
}

function readText(rel) {
  try { return readFileSync(join(ROOT, rel), "utf8"); } catch (e) { fail(`cannot read ${rel}: ${e.code || e.message}`); }
}

function readJson(rel) {
  const text = readText(rel);
  try { return JSON.parse(text); } catch (e) { fail(`${rel} is not valid JSON: ${e.message}`); }
}

function validateVideoUrl(v, origin) {
  if (!v || v.startsWith("--")) fail(`${origin} needs an https URL value`);
  let u;
  try { u = new URL(v); } catch { fail(`${origin}: not a URL: ${v}`); }
  if (u.protocol !== "https:") fail(`${origin}: must be https, got ${u.protocol}`);
  return v;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let url = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--video-url") { url = validateVideoUrl(argv[++i], "--video-url"); continue; }
    if (a.startsWith("--video-url=")) { url = validateVideoUrl(a.slice("--video-url=".length), "--video-url"); continue; }
    fail(`unknown argument: ${a} (usage: build-openai-plugin.mjs [--video-url <https-url>])`);
  }
  if (!url && process.env.DEMO_RECORDING_URL) url = validateVideoUrl(process.env.DEMO_RECORDING_URL, "DEMO_RECORDING_URL");
  return url;
}

// Strings named "description" anywhere in a manifest.
function descriptionStrings(node, path, out) {
  if (Array.isArray(node)) node.forEach((v, i) => descriptionStrings(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "description" && typeof v === "string") out.push([`${path}.${k}`, v]);
      else descriptionStrings(v, `${path}.${k}`, out);
    }
  }
  return out;
}

function scanText(label, text, banned, patterns, errors) {
  if (text.includes(EM_DASH)) errors.push(`em-dash in ${label}`);
  const stripped = stripTokens(text);
  const hits = banned.filter((w) => stripped.includes(w));
  for (const re of patterns) { const m = stripped.match(re); if (m) hits.push(`"${m[0]}"`); }
  if (hits.length) errors.push(`banned words in ${label}: ${hits.join(", ")}`);
  for (const raw of text.match(/https?:\/\/[^\s"'<>()\[\]`\\]+/gi) || []) {
    let host = null;
    try { host = new URL(raw).hostname.toLowerCase(); } catch { /* reported below */ }
    if (!host || !ALLOWED_HOSTS.includes(host)) errors.push(`URL host not allowed in ${label}: ${raw}`);
  }
}

// Preconditions. A run that gets past them never leaves an older ZIP behind.
const zipProbe = spawnSync("zip", ["-v"], { stdio: "ignore" });
if (zipProbe.error || zipProbe.status !== 0) fail("zip: command not found (the build needs the system zip binary)");
cleanOnFail = true;
rmSync(OUT_ROOT, { recursive: true, force: true });
const videoUrl = parseArgs();
const dirty = spawnSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" });
if (dirty.status === 0 && dirty.stdout.trim()) console.warn("warning: building from a dirty tree");

const manifest = readJson(".codex-plugin/plugin.json");
const iface = manifest.interface;
const review = manifest.extensions && manifest.extensions["com.openai"] && manifest.extensions["com.openai"].review;
if (!iface || typeof iface !== "object") fail(".codex-plugin/plugin.json: missing interface block");
if (!review || typeof review !== "object") fail('.codex-plugin/plugin.json: missing extensions["com.openai"].review');

// Staged file list: explicit, so nothing ships that was not listed and scanned.
// skills/ must hold at least one <skill>/ directory, each with exactly one file, SKILL.md.
// Text entries carry the string that was scanned; that string is what gets written.
const staged = [];   // {rel, text} | {rel, src} (binary) | {rel, manifest: true}
const stageErrors = [];
const skillsDir = join(ROOT, "skills");
if (!existsSync(skillsDir)) fail("missing skills/ directory");
let skillCount = 0;
for (const name of readdirSync(skillsDir).sort()) {
  const rel = `skills/${name}`;
  const st = lstatSync(join(ROOT, rel));
  if (st.isSymbolicLink()) { stageErrors.push(`symlink under skills/: ${rel}`); continue; }
  if (name.startsWith(".")) { stageErrors.push(`dotfile under skills/: ${rel}`); continue; }
  if (!st.isDirectory()) { stageErrors.push(`unexpected file under skills/ (only <skill>/SKILL.md ships): ${rel}`); continue; }
  let hasSkill = false;
  for (const child of readdirSync(join(ROOT, rel)).sort()) {
    const crel = `${rel}/${child}`;
    const cst = lstatSync(join(ROOT, crel));
    if (cst.isSymbolicLink()) stageErrors.push(`symlink under skills/: ${crel}`);
    else if (child.startsWith(".")) stageErrors.push(`dotfile under skills/: ${crel}`);
    else if (child !== "SKILL.md" || !cst.isFile()) stageErrors.push(`unexpected ${cst.isDirectory() ? "directory" : "file"} under skills/ (only <skill>/SKILL.md ships): ${crel}`);
    else hasSkill = true;
  }
  if (!hasSkill) { stageErrors.push(`${rel}/ has no SKILL.md`); continue; }
  skillCount++;
  staged.push({ rel: `${rel}/SKILL.md`, text: readText(`${rel}/SKILL.md`) });
}
if (!stageErrors.length && skillCount === 0) stageErrors.push("skills/ contains no skill");
if (stageErrors.length) fail(["refusing to build:", ...stageErrors.map((e) => "  " + e)]);
staged.unshift({ rel: ".codex-plugin/plugin.json", manifest: true }, { rel: ".mcp.json", text: readText(".mcp.json") });
for (const f of ["logo.png", "logo-400.png"]) {
  if (!existsSync(join(ROOT, "assets", f))) fail(`missing source file: assets/${f}`);
  staged.push({ rel: `assets/${f}`, src: join(ROOT, "assets", f) });
}

// Scan: every text file that ships, commands/*.md, and the other manifests' descriptions.
// The demo URL is injected after the scan.
const errors = [];
for (const key of ["displayName", "shortDescription", "longDescription"]) {
  if (typeof iface[key] !== "string") errors.push(`interface.${key} is missing`);
}
if (!errors.length) {
  for (const key of ["displayName", "shortDescription"]) {
    if (iface[key].length > 30) errors.push(`interface.${key} is ${iface[key].length} chars (max 30)`);
  }
  if (iface.longDescription.length > 4000) errors.push(`interface.longDescription is ${iface.longDescription.length} chars (max 4000)`);
}

const scanManifest = JSON.parse(JSON.stringify(manifest));
const scanReview = scanManifest.extensions["com.openai"].review;
delete scanReview.demo_recording_url;
const commerceText = typeof scanReview.commerce_description === "string" ? scanReview.commerce_description : "";
delete scanReview.commerce_description;

scanText(".codex-plugin/plugin.json (minus commerce_description)", JSON.stringify(scanManifest), BANNED, BANNED_PATTERNS, errors);
scanText("commerce_description", commerceText, COMMERCE_BANNED, [], errors);
for (const s of staged) if (s.text !== undefined) scanText(s.rel, s.text, BANNED, BANNED_PATTERNS, errors);
const commandsDir = join(ROOT, "commands");
if (existsSync(commandsDir)) {
  for (const name of readdirSync(commandsDir).sort()) {
    if (name.endsWith(".md")) scanText(`commands/${name}`, readText(`commands/${name}`), BANNED, BANNED_PATTERNS, errors);
  }
}
for (const [rel, versionOf] of OTHER_MANIFESTS) {
  const m = readJson(rel);
  const v = versionOf(m);
  if (v !== manifest.version) errors.push(`version mismatch: ${rel} has ${v}, .codex-plugin/plugin.json has ${manifest.version}`);
  for (const [path, text] of descriptionStrings(m, rel, [])) scanText(path, text, BANNED, BANNED_PATTERNS, errors);
}
if (errors.length) fail(["listing scan failed:", ...errors.map((e) => "  " + e)]);

// Assemble from the staged list only, writing the strings that were scanned.
if (videoUrl) review.demo_recording_url = videoUrl;
for (const s of staged) {
  const dest = join(OUT_DIR, s.rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (s.manifest) writeFileSync(dest, JSON.stringify(manifest, null, 2) + "\n");
  else if (s.text !== undefined) writeFileSync(dest, s.text);
  else cpSync(s.src, dest);
}

const entries = staged.map((s) => s.rel).sort();
const zipped = spawnSync("zip", ["-X", "-q", ZIP, ...entries], { cwd: OUT_DIR, stdio: "inherit" });
if (zipped.error || zipped.status !== 0) fail(`zip failed (${zipped.error ? zipped.error.message : "exit " + zipped.status})`);

console.log(ZIP);
for (const e of entries) console.log("   " + e);
console.log("demo_recording_url: " + (videoUrl || "MISSING"));
if (!videoUrl) console.warn("WARNING: demo_recording_url is MISSING; re-run with --video-url <https-url> before submitting this ZIP");
