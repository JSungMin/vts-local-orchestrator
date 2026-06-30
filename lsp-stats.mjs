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

// `definitive` marks a failure where clangd EXPLICITLY reported no usable index (no compile_commands.json) —
// a permanent, non-transient condition (vs a timeout, which could be a slow warm-up). One definitive failure is
// enough to open the circuit; timeouts need ≥minFails. This catches the case clangdIndexState misses: a parent
// projectPath (e.g. a vault/monorepo root) whose C/C++ lives several levels down, so the upfront "none/toobig"
// detection classifies it "na" and never drops the tools — but the runtime truth ("needs compile_commands.json")
// is unambiguous, so we converge on the next run instead of waiting for 3 timeouts.
export function recordLspOutcome(project, tool, ok, ms, definitive = false) {
  if (DISABLED || !project || !LSP_TRACK.has(tool)) return;
  const m = read();
  const e = m[project] || (m[project] = { outcomes: [] });
  e.outcomes.push({ ok: !!ok, ms: Math.round(ms || 0), tool, ts: Date.now(), definitive: !ok && !!definitive });
  if (e.outcomes.length > WINDOW) e.outcomes = e.outcomes.slice(-WINDOW);
  write(m);
}

// Verdict from history. circuitOpen: ZERO successes AND (≥minFails timeouts OR ANY definitive no-index error) →
// drop the index tools. suggestedTimeoutMs: when successes DO exist, p90(success ms)·1.3 (clamped) so a slow
// index gets right-sized time instead of a blanket short timeout.
export function lspVerdict(project, { minFails = 3 } = {}) {
  if (DISABLED || !project) return { circuitOpen: false, suggestedTimeoutMs: null, successes: 0, fails: 0 };
  const e = read()[project];
  const o = (e && Array.isArray(e.outcomes)) ? e.outcomes : [];
  const succ = o.filter((x) => x.ok);
  const fails = o.filter((x) => !x.ok);
  const definitive = fails.some((x) => x.definitive);
  const circuitOpen = succ.length === 0 && (fails.length >= minFails || definitive);
  let suggestedTimeoutMs = null;
  if (succ.length) {
    const ms = succ.map((x) => x.ms).sort((a, b) => a - b);
    const p90 = ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.9))];
    suggestedTimeoutMs = Math.max(2000, Math.min(30000, Math.round(p90 * 1.3)));
  }
  return { circuitOpen, suggestedTimeoutMs, successes: succ.length, fails: fails.length };
}
