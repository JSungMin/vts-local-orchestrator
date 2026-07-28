#!/usr/bin/env node
/*
 * selftest-proc-reap.mjs — deterministic guards for proc-reap.mjs classifyOrphans (pure, no process I/O).
 * The regression this file was created for: reap built its "alive" set from the node/clangd candidates ALONE,
 * so a vs-search server whose PARENT is claude.exe (the MCP host — not a node/clangd proc) looked parent-less
 * and got KILLED as a false orphan. classifyOrphans now takes the FULL live-pid set; these guards pin that a
 * live-parented server is spared and only a genuinely parent-less one is reaped.
 */
import { classifyOrphans } from "../proc-reap.mjs";

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) return console.log(`  ok   ${name}`);
  fails++;
  console.log(`  FAIL ${name}${got !== undefined ? `\n       got: ${JSON.stringify(got)}` : ""}`);
};

console.log("proc-reap selftest\n");

const SRV = "C:/plugins/vs-token-safer/server/index.js";
const srv = (pid, ppid, cmd = `node ${SRV}`) => ({ pid, ppid, name: "node.exe", cmd });
const clg = (pid, ppid) => ({ pid, ppid, name: "clangd.exe", cmd: "C:/tools/clangd.exe --background-index" });

// THE REGRESSION: a vs-search server parented by claude.exe (pid 100), which is ALIVE but is NOT in the
// node/clangd candidate list. It must NOT be classified an orphan.
{
  const candidates = [srv(200, 100)];            // server 200, parent = claude.exe 100
  const alive = new Set([100, 200]);             // claude.exe IS alive
  const { servers } = classifyOrphans(candidates, alive, SRV);
  ok("claude.exe-parented live server is NOT an orphan", servers.length === 0, servers.map((s) => s.pid));
}

// A genuinely orphaned server (parent gone) IS reaped.
{
  const candidates = [srv(200, 999)];            // parent 999 not alive
  const alive = new Set([200]);
  const { servers } = classifyOrphans(candidates, alive, SRV);
  ok("parent-less server IS an orphan", servers.length === 1 && servers[0].pid === 200, servers.map((s) => s.pid));
}

// clangd whose parent is an ORPHAN server is swept; clangd under a LIVE server is spared.
{
  const candidates = [srv(200, 999), clg(300, 200), clg(301, 100)];
  const alive = new Set([100, 300, 301]);        // 999 (server's parent) dead → server 200 orphan; 100 alive
  const { servers, clangd } = classifyOrphans(candidates, alive, SRV);
  ok("orphan-server clangd child swept", clangd.some((c) => c.pid === 300), clangd.map((c) => c.pid));
  ok("live-parented clangd spared", !clangd.some((c) => c.pid === 301), clangd.map((c) => c.pid));
  ok("orphan server still detected alongside", servers.length === 1 && servers[0].pid === 200);
}

// A daemon-spawned server (parent = the qvts daemon node, alive) is spared — the warm path must survive reap.
{
  const candidates = [srv(200, 150)];            // parent 150 = the daemon node
  const alive = new Set([150, 200]);
  const { servers } = classifyOrphans(candidates, alive, SRV);
  ok("daemon-parented live server spared", servers.length === 0, servers.map((s) => s.pid));
}

// A node process that is NOT a vs-search server is never touched, even if parent-less.
{
  const candidates = [{ pid: 200, ppid: 999, name: "node.exe", cmd: "node some-other-tool.js" }];
  const { servers, all } = classifyOrphans(candidates, new Set([200]), SRV);
  ok("non-vts node never classified a server", servers.length === 0 && all.length === 0);
}

console.log(fails ? `\nFAILED (${fails})` : "\nPASSED");
process.exit(fails ? 1 : 0);
