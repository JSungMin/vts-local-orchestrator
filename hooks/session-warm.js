#!/usr/bin/env node
/*
 * session-warm.js — SessionStart hook (OPT-IN). When VTS_AUTO_DAEMON is set, start the qvts warm daemon
 * for the current project so the FIRST locate of the session skips the cold vs-search spawn/index.
 *
 *   VTS_AUTO_DAEMON unset / "0"  → instant no-op (default — the plugin starts no background process)
 *   VTS_AUTO_DAEMON "1"          → spawn the daemon (detached, non-blocking) for the session's cwd
 *
 * SessionStart only — it never intercepts a tool. The daemon binds 127.0.0.1 and is read-only (see the
 * security model). The daemon's own `daemon start` is idempotent (no-op if one is already up for the repo).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!/^(1|true|on|yes)$/i.test(process.env.VTS_AUTO_DAEMON || "")) process.exit(0); // default: do nothing

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(here, "..", "vts-bridge.mjs");
const env = { ...process.env };
if (!env.VTS_PROJECT) env.VTS_PROJECT = process.cwd(); // warm the repo this session opened
try {
  spawn(process.execPath, [bridge, "daemon", "start"], { detached: true, stdio: "ignore", env }).unref();
} catch {
  /* best-effort — a failed warm must never block session start */
}
process.exit(0);
