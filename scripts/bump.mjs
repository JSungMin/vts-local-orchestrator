#!/usr/bin/env node
/*
 * bump.mjs — bump the plugin version in BOTH manifests in lockstep so they never disagree
 * (claude plugin validate requires marketplace plugins[].version === plugin.json version).
 *
 *   node scripts/bump.mjs [major|minor|patch]   (default: patch)
 *
 * Prints the new version to stdout. Used by the version-bump GitHub Action on every merge to main,
 * and runnable by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PJ = path.join(ROOT, ".claude-plugin", "plugin.json");
const MP = path.join(ROOT, ".claude-plugin", "marketplace.json");

const level = (process.argv[2] || "patch").toLowerCase();
if (!["major", "minor", "patch"].includes(level)) {
  process.stderr.write(`bump: unknown level "${level}" (use major|minor|patch)\n`);
  process.exit(2);
}

const pj = JSON.parse(fs.readFileSync(PJ, "utf8"));
const m = String(pj.version || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
if (!m) {
  process.stderr.write(`bump: plugin.json version "${pj.version}" is not semver\n`);
  process.exit(2);
}
let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
if (level === "major") (maj++, (min = 0), (pat = 0));
else if (level === "minor") (min++, (pat = 0));
else pat++;
const next = `${maj}.${min}.${pat}`;

pj.version = next;
fs.writeFileSync(PJ, JSON.stringify(pj, null, 2) + "\n");

const mp = JSON.parse(fs.readFileSync(MP, "utf8"));
for (const p of mp.plugins || []) if (p && p.version) p.version = next;
fs.writeFileSync(MP, JSON.stringify(mp, null, 2) + "\n");

process.stdout.write(next + "\n");
