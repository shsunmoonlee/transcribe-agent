#!/usr/bin/env node
// Checks the plugin version. Two rules:
//   1. Every plugin manifest carries the same version.
//   2. When a plugin-facing file changed against the base ref, that version is strictly greater
//      than the base's .claude-plugin/plugin.json version. The Claude directory picks up every
//      merge to main, and its docs say to raise plugin.json's version with every release.
// package.json is the CLI package with its own 0.x version, so it is not a plugin manifest here.
//
// Usage: node scripts/check-version.mjs [base-ref]   (or env BASE_REF; default origin/main)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_REF = process.argv[2] || process.env.BASE_REF || "origin/main";
const SOURCE_OF_TRUTH = ".claude-plugin/plugin.json";

const MANIFESTS = [
  ["plugin.json", (m) => m.version],
  [".claude-plugin/plugin.json", (m) => m.version],
  [".claude-plugin/marketplace.json", (m) => m.metadata && m.metadata.version],
  [".codex-plugin/plugin.json", (m) => m.version],
  [".cursor-plugin/plugin.json", (m) => m.version],
  [".grok-plugin/plugin.json", (m) => m.version],
  ["gemini-extension.json", (m) => m.version],
];

const PLUGIN_DIRS = ["skills/", "commands/", "assets/", ".claude-plugin/", ".codex-plugin/", ".cursor-plugin/",
  ".grok-plugin/", ".agents/"];
const PLUGIN_FILES = ["plugin.json", "mcp_config.json", ".mcp.json", "gemini-extension.json", "SKILL.md", "README.md"];

function fail(lines) {
  for (const l of [].concat(lines)) console.error(l);
  process.exit(1);
}

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

function parseJson(text, origin) {
  try { return JSON.parse(text); } catch (e) { fail(`${origin} is not valid JSON: ${e.message}`); }
}

function parseSemver(v, origin) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v));
  if (!m) fail(`${origin}: "${v}" is not a semver version`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function isPluginFile(path) {
  return PLUGIN_FILES.includes(path) || PLUGIN_DIRS.some((d) => path.startsWith(d)) || /^\.[^/]+-plugin\//.test(path) || path.endsWith("/plugin.json");
}

const versions = MANIFESTS.map(([rel, pick]) => {
  let text;
  try { text = readFileSync(join(ROOT, rel), "utf8"); } catch (e) { fail(`cannot read ${rel}: ${e.code || e.message}`); }
  const v = pick(parseJson(text, rel));
  if (!v) fail(`${rel} has no plugin version`);
  return [rel, v];
});

const distinct = [...new Set(versions.map(([, v]) => v))];
if (distinct.length !== 1) {
  fail(["Plugin manifests disagree on the version:", ...versions.map(([rel, v]) => `  ${v}  ${rel}`),
    "Set the same version in every plugin manifest."]);
}
const version = distinct[0];
const head = parseSemver(version, SOURCE_OF_TRUTH);

const mergeBase = git(["merge-base", BASE_REF, "HEAD"]).trim();
const changed = git(["diff", "--name-only", "--no-renames", mergeBase]).split("\n").filter(Boolean);
const pluginChanged = changed.filter(isPluginFile);

if (!pluginChanged.length) {
  console.log(`Plugin version ${version} is consistent; no plugin-facing files changed against ${BASE_REF}.`);
  process.exit(0);
}

const baseVersion = parseJson(git(["show", `${BASE_REF}:${SOURCE_OF_TRUTH}`]), `${BASE_REF}:${SOURCE_OF_TRUTH}`).version;
const base = parseSemver(baseVersion, `${BASE_REF}:${SOURCE_OF_TRUTH}`);

if (compareSemver(head, base) <= 0) {
  fail([`Plugin-facing files changed against ${BASE_REF}, but the plugin version was not raised.`,
    `  ${BASE_REF}: ${baseVersion}`, `  this branch: ${version}`, "Changed plugin files:",
    ...pluginChanged.map((p) => `  ${p}`),
    `Bump the version in every plugin manifest (${MANIFESTS.map(([rel]) => rel).join(", ")}) above ${baseVersion}.`]);
}

console.log(`Plugin version ${version} > ${baseVersion} (${BASE_REF}); ${pluginChanged.length} plugin file(s) changed.`);
