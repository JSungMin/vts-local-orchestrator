/*
 * config-loader.mjs — single source of per-machine config for the bridge, agent-core, and dashboard.
 * Precedence (low→high): built-in defaults  <  qvts.config.json (written by setup.ps1)  <  process.env.
 * Keeps every entry point reading the SAME resolved settings so a teammate only edits one file (or none —
 * setup.ps1 generates it from their hardware).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fromFile() {
  // qvts.config.json next to this module, or under ~/.vts-local/ (a global install).
  for (const p of [path.join(HERE, "qvts.config.json"), path.join(os.homedir(), ".vts-local", "config.json")]) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* next */ }
  }
  return {};
}

function vtsProjectFromVtsConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".vs-token-safer", "config.json"), "utf8"));
    return c.projectPath || null;
  } catch { return null; }
}

// Best-effort locate the vs-token-safer MCP server across common install locations. setup.ps1 normally
// writes the resolved path into qvts.config.json; this is the fallback when neither config nor env is set.
function resolveVtsServer() {
  const cands = [
    path.join(os.homedir(), ".claude", "plugins", "vs-token-safer", "server", "index.js"),
    path.join(HERE, "..", "vs-token-safer", "server", "index.js"),
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch { /* next */ } }
  return ""; // empty -> entry points raise a clear "run setup.ps1 / set VTS_SERVER" error
}

export function loadConfig() {
  const f = fromFile();
  const e = process.env;
  const cfg = {
    ollamaHost: (e.OLLAMA_HOST || f.ollamaHost || "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: e.QVTS_MODEL || f.model || "qwen-coder-vts",
    numCtx: Number(e.QVTS_NUM_CTX || f.numCtx || 32768),
    maxSteps: Number(e.QVTS_MAXSTEPS || f.maxSteps || 25),
    vtsServer: e.VTS_SERVER || f.vtsServer || resolveVtsServer(),
    project: e.VTS_PROJECT || f.project || vtsProjectFromVtsConfig() || null,
    port: Number(e.PORT || f.port || 7878),
    tools: (e.QVTS_TOOLS || f.tools || "").trim(), // comma list; empty = locator default in agent
  };
  return cfg;
}
