/*
 * lsp-stats.mjs — per-project LSP outcome ledger + verdict (the search_symbol circuit breaker).
 *
 * The index-backed locators (search_symbol / find_references / goto_definition / document_symbols / hover) need
 * a language-server index. On an UNINDEXED tree (e.g. a UE C/C++ source tree with no compile_commands.json)
 * they NEVER succeed — clangd's workspace/symbol just times out — yet each attempt still costs ~10-16s (clangd
 * spawn + crawl) even with a short per-request timeout. The fixed soft fast-fail keeps offering them, so the
 * local model burns that time on every run. Averaging "successful" latencies (the original idea) is moot here:
 * there are no successes to average.
 *
 * So we LEARN per project, across runs:
 *   - record each index-tool attempt as ok(ms) or fail.
 *   - lspVerdict(): if the recent window is all failures (≥ minFails, zero successes) → circuit OPEN → the next
 *     run drops the index tools up front (hard-narrow) instead of wasting seconds rediscovering they don't work.
 *   - if successes DO exist (a real but slow index), suggest a per-request timeout ~p90 of the success latency
 *     so a slow-to-warm index gets enough time instead of a blanket 4s.
 *
 * Local-only JSON at ~/.vts-local/lsp-stats.json. Off-switch QVTS_LSP_STATS=0. Best-effort; never throws.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = process.env.QVTS_LSP_STATS_FILE || path.join(os.homedir(), ".vts-local", "lsp-stats.json");
const DISABLED = /^(0|false|off|no)$/i.test(process.env.QVTS_LSP_STATS || "");
const WINDOW = Number(process.env.QVTS_LSP_STATS_WINDOW || 8); // keep last N outcomes per project

// The index-backed tools this ledger governs (the ones that need a language-server index).
export const LSP_TRACK = new Set(["search_symbol", "find_references", "goto_definition", "document_symbols", "hover"]);

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch { return {}; } };
const write = (m) => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(m)); } catch { /* best effort */ } };

export function recordLspOutcome(project, tool, ok, ms) {
  if (DISABLED || !project || !LSP_TRACK.has(tool)) return;
  const m = read();
  const e = m[project] || (m[project] = { outcomes: [] });
  e.outcomes.push({ ok: !!ok, ms: Math.round(ms || 0), tool, ts: Date.now() });
  if (e.outcomes.length > WINDOW) e.outcomes = e.outcomes.slice(-WINDOW);
  write(m);
}

// Verdict from history. circuitOpen: recent window is ≥minFails failures with ZERO successes → the index is
// provably unusable for this project, so drop the index tools. suggestedTimeoutMs: when successes DO exist,
// p90(success ms)·1.3 (clamped) so a slow index gets right-sized time instead of a blanket short timeout.
export function lspVerdict(project, { minFails = 3 } = {}) {
  if (DISABLED || !project) return { circuitOpen: false, suggestedTimeoutMs: null, successes: 0, fails: 0 };
  const e = read()[project];
  const o = (e && Array.isArray(e.outcomes)) ? e.outcomes : [];
  const succ = o.filter((x) => x.ok);
  const fails = o.filter((x) => !x.ok);
  const circuitOpen = succ.length === 0 && fails.length >= minFails;
  let suggestedTimeoutMs = null;
  if (succ.length) {
    const ms = succ.map((x) => x.ms).sort((a, b) => a - b);
    const p90 = ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.9))];
    suggestedTimeoutMs = Math.max(2000, Math.min(30000, Math.round(p90 * 1.3)));
  }
  return { circuitOpen, suggestedTimeoutMs, successes: succ.length, fails: fails.length };
}
