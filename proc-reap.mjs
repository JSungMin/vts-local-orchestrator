/*
 * proc-reap.mjs — find and kill ORPHANED vs-search / clangd processes left behind when a Claude session (and
 * its qvts child) dies WITHOUT a clean teardown. A normal one-shot exit runs client.close(), which ends the
 * spawned vs-search server (and its clangd grandchild). But when the session is SIGKILLed, that teardown never
 * runs: the server + clangd are reparented and keep running — zombie processes pegging CPU/RAM on a big tree.
 *
 * Detection is conservative (so a reap never kills a LIVE session's server): a vs-search server is an orphan
 * ONLY when its PARENT pid is no longer alive. CRITICAL: "alive" must be the set of ALL running pids, not just
 * node/clangd — the vs-search server Claude Code launches directly has `claude.exe` (or the MCP host) as its
 * PARENT, which is NOT a node/clangd process. An earlier version built the alive set from the node/clangd
 * candidate snapshot alone, so every Claude-Code-parented server looked parent-less and got KILLED as a false
 * orphan (live: reap terminated the session's active vs-search MCP server whose claude.exe parent was alive).
 * clangd is targeted when its parent is dead OR is an orphan server. Local-only; no network. Best-effort: a
 * scan/kill failure never throws to the caller.
 */
import { execFileSync } from "node:child_process";

const IS_WIN = process.platform === "win32";

// Snapshot the CANDIDATE processes as { pid, ppid, name, cmd } — only node/clangd carry a vs-search server or
// clangd. Windows via CIM (needs CommandLine); POSIX via ps.
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

// The set of EVERY live pid on the box — the authority for "is this server's parent still alive?". Cheap:
// pid column only. Returns a Set<number>; empty on failure (callers treat an empty alive-set as "unknown" and
// skip killing, so a scan failure never nukes a live server — see findOrphanVtsProcs).
function allLivePids() {
  try {
    if (IS_WIN) {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress"],
        { encoding: "utf8", timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
      ).trim();
      if (!out) return new Set();
      const j = JSON.parse(out);
      const arr = Array.isArray(j) ? j : [j];
      return new Set(arr.map((n) => Number(n)));
    }
    const out = execFileSync("ps", ["-eo", "pid="], { encoding: "utf8", timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
    const s = new Set();
    for (const line of out.split("\n")) { const n = Number(line.trim()); if (Number.isFinite(n) && n > 0) s.add(n); }
    return s;
  } catch {
    return new Set();
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

// PURE classifier (unit-tested): given the node/clangd CANDIDATES and the set of ALL live pids, return the
// orphaned vs-search servers (parent not among the live pids) and orphaned clangd (parent dead OR a child of
// an orphan server). Kept free of any process I/O so selftest-proc-reap.mjs can drive it with canned data.
export function classifyOrphans(candidates, alivePids, serverPath) {
  const servers = candidates.filter((p) => isVtsServer(p.cmd, serverPath) && !alivePids.has(p.ppid));
  const serverPids = new Set(servers.map((p) => p.pid));
  const clangd = candidates.filter((p) => isClangd(p.name, p.cmd) && (!alivePids.has(p.ppid) || serverPids.has(p.ppid)));
  return { servers, clangd, all: [...servers, ...clangd] };
}

// Find orphaned vs-search servers (parent dead) and orphaned clangd (parent dead, or child of an orphan server).
// serverPath narrows the match; omit to use the generic signature. A parent is "alive" iff its pid is in the
// FULL live-pid set (not merely another node/clangd) — so a server whose parent is claude.exe / the MCP host is
// correctly seen as LIVE. If the alive-pid scan fails (empty set) we return NOTHING: better to leave a real
// orphan than to kill a live server on a bad scan.
export function findOrphanVtsProcs(serverPath) {
  const procs = snapshot();
  if (!procs.length) return { servers: [], clangd: [], all: [] };
  const alive = allLivePids();
  if (!alive.size) return { servers: [], clangd: [], all: [] }; // scan failed → never kill on incomplete data
  return classifyOrphans(procs, alive, serverPath);
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
