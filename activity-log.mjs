/*
 * activity-log.mjs — a shared, local-only ACTIVITY BUS so the dashboard can show EVERYTHING the local model
 * does, not just tasks typed into the dashboard form. Every qvts entry point (CLI one-shot, --batch, the warm
 * daemon, the Read→digest hook, and the dashboard itself) appends one compact JSON line per completed unit of
 * work to ~/.vts-local/activity.jsonl. The dashboard tails that file and renders a project > kind > run tree.
 *
 * Privacy: 127.0.0.1 / on-disk only, never transmitted (same posture as the rest of the plugin). The file can
 * hold task text, so it is gitignored and lives under the user's home, not the repo.
 *
 * Entry shape (all fields optional except ts/kind):
 *   { ts, project, kind, via, task, result, ms, cached, savings:{...}, tools:[...] }
 *   kind : locate | def_search | digest | digest-dir | triage | web
 *   via  : cli | daemon | dashboard | hook   (how the work was invoked)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ACTIVITY_FILE =
  process.env.QVTS_ACTIVITY_FILE || path.join(os.homedir(), ".vts-local", "activity.jsonl");
const MAX_LINES = Number(process.env.QVTS_ACTIVITY_MAX || 5000); // bound the file; trim oldest past this
const CLIP = (s, n) => (s == null ? "" : String(s).replace(/\s+/g, " ").trim().slice(0, n));

// Off-switch: QVTS_ACTIVITY_LOG=0 disables all writing (reads still work on an existing file).
const DISABLED = /^(0|false|off|no)$/i.test(process.env.QVTS_ACTIVITY_LOG || "");

// Append one activity record. Best-effort: a logging failure must NEVER break a locate/digest.
export function logActivity(entry) {
  if (DISABLED || !entry || !entry.kind) return;
  try {
    const rec = {
      ts: Date.now(),
      project: entry.project || null,
      kind: entry.kind,
      via: entry.via || process.env.QVTS_VIA || (process.env.QVTS_DAEMON_SERVE ? "daemon" : "cli"),
      task: CLIP(entry.task, 300),
      result: CLIP(entry.result, 400),
      ms: entry.ms != null ? Math.round(entry.ms) : null,
      cached: !!entry.cached,
      savings: entry.savings || null,
      tools: Array.isArray(entry.tools) ? entry.tools.slice(0, 24) : null,
    };
    fs.mkdirSync(path.dirname(ACTIVITY_FILE), { recursive: true });
    fs.appendFileSync(ACTIVITY_FILE, JSON.stringify(rec) + "\n");
    maybeTrim();
  } catch {
    /* best-effort */
  }
}

let _writesSinceTrim = 0;
function maybeTrim() {
  // Cheap amortized trim: only every 200 writes, and only if the file actually exceeds the cap.
  if (++_writesSinceTrim < 200) return;
  _writesSinceTrim = 0;
  try {
    const lines = fs.readFileSync(ACTIVITY_FILE, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(ACTIVITY_FILE, lines.slice(lines.length - MAX_LINES).join("\n") + "\n");
    }
  } catch {
    /* ignore */
  }
}

// ---- live progress channel ----------------------------------------------------------------------
// A separate, short-lived channel for IN-FLIGHT progress (tool → result → final) so the dashboard can show
// what the local model is doing RIGHT NOW — across every entry point (CLI, delegation, daemon), not just
// tasks typed into the dashboard form. One JSON line per progress event, keyed by runId. Kept small (it's
// ephemeral; the activity bus is the durable record). Same off-switch as the activity log.
export const LIVE_FILE = process.env.QVTS_LIVE_FILE || path.join(os.homedir(), ".vts-local", "live.jsonl");
const LIVE_MAX = Number(process.env.QVTS_LIVE_MAX || 400);
let _liveWrites = 0;
export function logLive(ev) {
  if (DISABLED || !ev || !ev.kind) return;
  try {
    fs.mkdirSync(path.dirname(LIVE_FILE), { recursive: true });
    fs.appendFileSync(LIVE_FILE, JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
    if (++_liveWrites % 80 === 0) {
      const lines = fs.readFileSync(LIVE_FILE, "utf8").split("\n").filter(Boolean);
      if (lines.length > LIVE_MAX) fs.writeFileSync(LIVE_FILE, lines.slice(lines.length - LIVE_MAX).join("\n") + "\n");
    }
  } catch {
    /* best-effort */
  }
}
export function readLive(limit = 200) {
  try {
    const lines = fs.readFileSync(LIVE_FILE, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const l of lines.slice(Math.max(0, lines.length - limit))) {
      try { out.push(JSON.parse(l)); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

// Read the most recent `limit` activity records (oldest→newest). Bounded read for the dashboard.
export function readActivity(limit = 500) {
  try {
    const lines = fs.readFileSync(ACTIVITY_FILE, "utf8").split("\n").filter(Boolean);
    const slice = lines.slice(Math.max(0, lines.length - limit));
    const out = [];
    for (const l of slice) {
      try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ }
    }
    return out;
  } catch {
    return [];
  }
}
