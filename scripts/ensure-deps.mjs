#!/usr/bin/env node
/*
 * ensure-deps.mjs — make the bridge self-heal its one runtime dependency (@modelcontextprotocol/sdk).
 *
 * The plugin ships WITHOUT node_modules (a Claude Code plugin install copies files only — no npm install,
 * and bundling node_modules would bloat the repo). On a machine where setup.ps1 / `npm link` ran, the global
 * `qvts` resolves the SDK from the dev checkout. But a pure `/plugin install` (no setup) leaves the plugin
 * copy with no SDK, so `node <plugin>/vts-bridge.mjs` would crash with ERR_MODULE_NOT_FOUND before any code
 * runs. This module installs the dep on first run (idempotent, fast no-op once present).
 *
 * The bridge/agent-core call ensureDeps() and then DYNAMICALLY import the SDK — never as a top-level static
 * import — so the install happens before the first resolve. Also runnable directly:
 *   node scripts/ensure-deps.mjs           # install if missing, report
 *   node scripts/ensure-deps.mjs --check   # report only, never install (exit 1 if missing)
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, ".."); // repo / plugin root (scripts/..)
const SDK = "@modelcontextprotocol/sdk";

// Resolve the SDK from ROOT's node_modules. True = present and loadable.
export function depsPresent(root = ROOT) {
  try {
    createRequire(path.join(root, "package.json")).resolve(`${SDK}/package.json`);
    return true;
  } catch {
    return false;
  }
}

// Install the dep into ROOT if missing. Returns true when deps are present afterwards.
export async function ensureDeps(root = ROOT) {
  if (depsPresent(root)) return true;
  if (!fs.existsSync(path.join(root, "package.json"))) {
    process.stderr.write(`[vts-local] cannot install deps: no package.json in ${root}\n`);
    return false;
  }
  process.stderr.write("[vts-local] first run: installing the MCP SDK dependency (one-time, ~a few seconds)…\n");
  try {
    execSync("npm install --omit=dev --no-audit --no-fund --no-save --silent", {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
      timeout: Number(process.env.QVTS_DEP_INSTALL_TIMEOUT_MS || 300000),
    });
  } catch (e) {
    process.stderr.write(
      `[vts-local] dep install failed: ${e.message}\n` +
        `  Fix manually: run \`npm install\` in ${root} (or \`node scripts/ensure-deps.mjs\`).\n`,
    );
    return false;
  }
  return depsPresent(root);
}

// CLI entry (when run directly, not imported).
const invokedDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirect) {
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const ok = depsPresent();
    process.stdout.write(ok ? `vts-local deps OK (${ROOT})\n` : `vts-local deps MISSING (${ROOT})\n`);
    process.exit(ok ? 0 : 1);
  }
  const ok = await ensureDeps();
  process.stdout.write(ok ? `vts-local deps OK (${ROOT})\n` : `vts-local deps MISSING (${ROOT})\n`);
  process.exit(ok ? 0 : 1);
}
