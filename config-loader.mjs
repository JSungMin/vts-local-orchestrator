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
    // strip a UTF-8 BOM — PowerShell's Set-Content -Encoding utf8 (Win PS 5.1) writes one, and JSON.parse
    // throws on a leading BOM. setup.ps1 generates this file, so this path is hit on every Windows install.
    try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")); } catch { /* next */ }
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

// GENERAL auto-narrow signal: should the local model be offered clangd symbol/ref tools for this project?
// They only answer FAST on a C/C++ tree that's small enough to index — on a huge UE tree (Engine included),
// even a built index is slow to load/query, so clangd queries dead-end (the model just reports "no match"
// instead of falling back). We mirror vs-token-safer's OWN resource policy: it disables clangd's
// background-index above ~15k TUs. So: narrow C/C++ when there's no compile DB, or the compile DB has more
// TUs than the threshold. tsserver/pyright (JS/TS/Python) need no compile DB and are never narrowed.
// Returns false → caller drops the index-dependent tools. Bounded (reads one JSON; never walks the tree).
// Detailed index state so the caller can distinguish "definitively no index" (no compile DB → symbol tools
// CANNOT work → drop them UP FRONT, don't even probe) from "index might be slow/partial" (huge DB → soft
// fast-fail + let the circuit breaker learn). Returns:
//   "na"     — not a C/C++ project (clangd isn't the backend) → don't narrow.
//   "none"   — C/C++ but NO compile_commands.json anywhere → clangd can't index → drop symbol tools up front.
//   "toobig" — C/C++ with a compile DB above the TU threshold → index is slow/throttled → soft fast-fail.
//   "usable" — C/C++ with a workable compile DB → keep symbol tools.
export function clangdIndexState(project) {
  if (!project) return "na";
  let entries = [];
  try { entries = fs.readdirSync(project, { withFileTypes: true }); } catch { return "na"; }
  let isCpp = entries.some((e) => {
    const n = e.name.toLowerCase();
    return n.endsWith(".uproject") || n.endsWith(".sln") || /\.(c|cc|cpp|cxx|h|hpp|hh|hxx)$/.test(n);
  });
  if (!isCpp) {
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        if (fs.readdirSync(path.join(project, e.name)).some((f) => /\.(cpp|h|hpp|cc|cxx)$/i.test(f))) { isCpp = true; break; }
      } catch { /* ignore */ }
    }
  }
  if (!isCpp) return "na";
  const findCdb = () => {
    const cands = [path.join(project, "compile_commands.json")];
    for (const e of entries) if (e.isDirectory()) cands.push(path.join(project, e.name, "compile_commands.json"));
    try {
      const db = process.env.VTS_DB_DIR || path.join(os.homedir(), ".vs-token-safer", "db");
      const base = path.basename(project).toLowerCase();
      for (const e of (fs.existsSync(db) ? fs.readdirSync(db) : [])) {
        if (e.toLowerCase().startsWith(base)) cands.push(path.join(db, e, "compile_commands.json"));
      }
    } catch { /* ignore */ }
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* next */ } }
    return null;
  };
  const cdb = findCdb();
  if (!cdb) return "none"; // C/C++ with no compile DB → clangd can't index
  const max = Number(process.env.QVTS_NARROW_TU_MAX || 15000);
  try {
    const arr = JSON.parse(fs.readFileSync(cdb, "utf8"));
    if (Array.isArray(arr)) return arr.length <= max ? "usable" : "toobig";
  } catch { /* unreadable → treat as too-risky */ }
  return "toobig";
}

export function clangdIndexUsable(project) {
  if (!project) return true;
  let entries = [];
  try { entries = fs.readdirSync(project, { withFileTypes: true }); } catch { return true; }
  // Is this a C/C++ (clangd) project at all? UE .uproject, a .sln, or C/C++ sources at root / one level down.
  let isCpp = entries.some((e) => {
    const n = e.name.toLowerCase();
    return n.endsWith(".uproject") || n.endsWith(".sln") || /\.(c|cc|cpp|cxx|h|hpp|hh|hxx)$/.test(n);
  });
  if (!isCpp) {
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        if (fs.readdirSync(path.join(project, e.name)).some((f) => /\.(cpp|h|hpp|cc|cxx)$/i.test(f))) { isCpp = true; break; }
      } catch { /* ignore */ }
    }
  }
  if (!isCpp) return true; // not C/C++ → clangd isn't the backend → never narrow

  // C/C++: locate a compile_commands.json (in-tree root/one-level, or the out-of-tree vts db keyed by basename).
  const findCdb = () => {
    const cands = [path.join(project, "compile_commands.json")];
    for (const e of entries) if (e.isDirectory()) cands.push(path.join(project, e.name, "compile_commands.json"));
    try {
      const db = process.env.VTS_DB_DIR || path.join(os.homedir(), ".vs-token-safer", "db");
      const base = path.basename(project).toLowerCase();
      for (const e of (fs.existsSync(db) ? fs.readdirSync(db) : [])) {
        if (e.toLowerCase().startsWith(base)) cands.push(path.join(db, e, "compile_commands.json"));
      }
    } catch { /* ignore */ }
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* next */ } }
    return null;
  };
  const cdb = findCdb();
  if (!cdb) return false; // C/C++ with no compile DB → clangd can't index → narrow

  // Count TUs. Above the threshold the tree is too big for fast symbol search (vts itself throttles/disables
  // clangd's index here) → narrow. Default 15000 mirrors VTS_CLANGD_BG_INDEX_HARD_TUS; override via QVTS_NARROW_TU_MAX.
  const max = Number(process.env.QVTS_NARROW_TU_MAX || 15000);
  try {
    const arr = JSON.parse(fs.readFileSync(cdb, "utf8"));
    if (Array.isArray(arr)) return arr.length <= max; // small enough → keep clangd tools; too big → narrow
  } catch { /* unreadable → fall through */ }
  return false; // C/C++ with an unreadable/huge DB → narrow to be safe
}

export function loadConfig() {
  const f = fromFile();
  const e = process.env;
  const cfg = {
    ollamaHost: (e.OLLAMA_HOST || f.ollamaHost || "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: e.QVTS_MODEL || f.model || "gemma4-vts",
    numCtx: Number(e.QVTS_NUM_CTX || f.numCtx || 32768),
    maxSteps: Number(e.QVTS_MAXSTEPS || f.maxSteps || 25),
    vtsServer: e.VTS_SERVER || f.vtsServer || resolveVtsServer(),
    project: e.VTS_PROJECT || f.project || vtsProjectFromVtsConfig() || null,
    port: Number(e.PORT || f.port || 7878),
    tools: (e.QVTS_TOOLS || f.tools || "").trim(), // comma list; empty = locator default in agent
  };
  // Charter is local-only. The chat body carries repo code (digest/triage) + tool results, so a non-loopback
  // OLLAMA_HOST would send that off-machine — warn loudly (don't silently break "nothing transmitted").
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(cfg.ollamaHost)) {
    process.stderr.write(`WARN: OLLAMA_HOST is not loopback (${cfg.ollamaHost}) — code/text will be sent OFF-MACHINE.\n`);
  }
  return cfg;
}
