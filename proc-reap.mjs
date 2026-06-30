/*
 * proc-reap.mjs — find and kill ORPHANED vs-search / clangd processes left behind when a Claude session (and
 * its qvts child) dies WITHOUT a clean teardown. A normal one-shot exit runs client.close(), which ends the
 * spawned vs-search server (and its clangd grandchild). But when the session is SIGKILLed, that teardown never
 * runs: the server + clangd are reparented and keep running — zombie processes pegging CPU/RAM on a big tree.
 *
 * Detection is conservative (so `qvts reap --kill` never kills a LIVE session's server): a vs-search server is
 * an orphan only when its PARENT pid is no longer alive. The daemon and any active one-shot keep their parent
 * alive, so their servers are never targeted. clangd is targeted when its parent is dead OR is an orphan server.
 * Local-only; no network. Best-effort: a scan/kill failure never throws to the caller.
 */
import { execFileSync } from "node:child_process";

const IS_WIN = process.platform === "win32";

// Snapshot running processes as { pid, ppid, name, cmd }. Windows via CIM (needs CommandLine); POSIX via ps.
function snapshot() {
  try {
    if (IS_WIN) {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'node.exe','clangd.exe' } | " +
          "Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
        { encoding: "utf8", timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
      ).trim();
      if (!out) return [];
      const j = JSON.parse(out);
      const arr = Array.isArray(j) ? j : [j];
      return arr.map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: String(p.Name || ""), cmd: String(p.CommandLine || "") }));
    }
    const out = execFileSync("ps", ["-eo", "pid=,ppid=,comm=,args="], { encoding: "utf8", timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
    const rows = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] });
    }
    return rows;
  } catch {
    return [];
  }
}

// Does this command line belong to a spawned vs-search server? Match the resolved server path when known,
// else the generic vs-token-safer server signature. (We only ever match node processes for the server.)
function isVtsServer(cmd, serverPath) {
  if (!cmd) return false;
  if (serverPath) {
    const norm = (s) => s.replace(/\\/g, "/").toLowerCase();
    if (norm(cmd).includes(norm(serverPath))) return true;
  }
  return /vs-token-safer[\\/].*server[\\/]index\.js/i.test(cmd) || /[\\/]server[\\/]index\.js/i.test(cmd) && /vs-token-safer/i.test(cmd);
}
const isClangd = (name, cmd) => /clangd/i.test(name) || /[\\/]clangd(\.exe)?\b/i.test(cmd);

// Find orphaned vs-search servers (parent dead) and orphaned clangd (parent dead, or child of an orphan server).
// serverPath narrows the match; omit to use the generic signature.
export function findOrphanVtsProcs(serverPath) {
  const procs = snapshot();
  if (!procs.length) return { servers: [], clangd: [], all: [] };
  const alive = new Set(procs.map((p) => p.pid));
  const servers = procs.filter((p) => isVtsServer(p.cmd, serverPath) && !alive.has(p.ppid)); // parent gone → orphan
  const serverPids = new Set(servers.map((p) => p.pid));
  const clangd = procs.filter((p) => isClangd(p.name, p.cmd) && (!alive.has(p.ppid) || serverPids.has(p.ppid)));
  const all = [...servers, ...clangd];
  return { servers, clangd, all };
}

// Kill a process and its descendants. Windows: taskkill /T (tree). POSIX: SIGKILL the pid (clangd children are
// handled by the separate clangd sweep in findOrphanVtsProcs). Returns true on a best-effort kill.
export function killTree(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    if (IS_WIN) { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10000 }); return true; }
    process.kill(pid, "SIGKILL"); return true;
  } catch { return false; }
}
