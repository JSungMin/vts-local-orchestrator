#!/usr/bin/env node
/*
 * steer-distill.js — a PreToolUse hook that steers a LARGE-file Read toward `qvts digest`, so the local
 * model distills the artifact and Claude ingests a compact brief instead of the whole file.
 *
 * NOT auto-registered by the plugin — wiring a hook to EVERY Read has real costs, so this is a manual
 * OPT-IN. To enable, add it to your ~/.claude/settings.json yourself, e.g.:
 *   "hooks": { "PreToolUse": [ { "matcher": "Read",
 *     "hooks": [ { "type": "command", "command": "node <abs>/hooks/steer-distill.js" } ] } ] }
 * and set VTS_AUTO_DISTILL. Then this nudges a large-file Read toward `qvts digest`:
 *   VTS_AUTO_DISTILL unset / "0"   → silent no-op
 *   VTS_AUTO_DISTILL "1" / "warn"  → inject a non-blocking suggestion (RECOMMENDED — the Read still runs)
 *   VTS_AUTO_DISTILL "block"       → block the Read (exit 2). ⚠ RISKY: Claude must Read a file before it
 *                                    can Edit it, and a digest is lossy — blocking a large non-code Read
 *                                    can break the read-before-edit flow. Prefer "warn".
 *
 * Scope: the Read tool on a file larger than QVTS_DISTILL_MIN bytes (default 51200 = 50 KB). Code files are
 * left to vs-token-safer's read_symbol steer; this targets big artifacts a digest fits (diffs, logs, JSON,
 * build/test output, long prose). Bash output size can't be known before execution, so Bash is not covered.
 */
import fs from "node:fs";

const MODE = (process.env.VTS_AUTO_DISTILL || "").toLowerCase();
if (!MODE || MODE === "0" || MODE === "off" || MODE === "false") process.exit(0); // default: do nothing

const MIN = Number(process.env.QVTS_DISTILL_MIN || 51200);
// Extensions vs-token-safer already covers well via read_symbol / document_symbols — don't double-steer.
const CODE = /\.(c|cc|cpp|cxx|h|hpp|cs|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|go|rs|java|rb|php|swift|kt)$/i;

let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
} catch {
  process.exit(0);
}
let ev;
try {
  ev = JSON.parse(raw);
} catch {
  process.exit(0);
}

if (ev.tool_name !== "Read") process.exit(0);
const file = ev.tool_input?.file_path;
if (!file || CODE.test(file)) process.exit(0);

let size = 0;
try {
  size = fs.statSync(file).size;
} catch {
  process.exit(0);
}
if (size < MIN) process.exit(0);

const kb = Math.round(size / 1024);
const msg =
  `This file is ~${kb} KB. Instead of reading it whole, delegate it to the local model: ` +
  `\`qvts digest "${file}" --focus "<what you need>"\` returns a compact brief (≈80% fewer tokens) — ` +
  `Claude never ingests the raw file. (set VTS_AUTO_DISTILL=0 to silence)`;

if (MODE === "block") {
  process.stderr.write(`[vts-local] large-file Read blocked → ${msg}\n`);
  process.exit(2); // model re-issues as qvts digest
}
// warn: non-blocking, model-visible context; the Read still proceeds.
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: msg } }) + "\n",
);
process.exit(0);
