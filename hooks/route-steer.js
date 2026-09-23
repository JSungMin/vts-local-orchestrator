#!/usr/bin/env node
/*
 * route-steer.js — SessionStart hook. Injects token-saving routing guidance that makes Claude DELEGATE
 * code-location to the local LLM (via `qvts`) FIRST, instead of calling vs-token-safer's vs-search MCP
 * tools directly. This is the whole point of the plugin: the raw search output stays in the local model
 * and only a compact file:line answer reaches Claude.
 *
 * It originally existed to win a routing fight with vs-token-safer's SessionStart hint; vts now detects
 * qvts itself and says "delegate", and its enforcement hooks hand back the qvts command at the moment a
 * locate is attempted. So this carries only what vts cannot: the qvts command shapes and two footguns.
 *
 *   VTS_ROUTE_STEER unset / "1"  → inject the delegate-first directive (default ON)
 *   VTS_ROUTE_STEER "0"/"off"    → no-op (let vs-token-safer's direct-call hint win)
 *
 * SessionStart only — never intercepts a tool.
 */
if (/^(0|false|off|no)$/i.test(process.env.VTS_ROUTE_STEER || "")) process.exit(0);

const root = process.env.CLAUDE_PLUGIN_ROOT || "";
const bridge = root ? `node "${root}/vts-bridge.mjs"` : 'node "<plugin>/vts-bridge.mjs"';

// KEEP THIS SHORT. It is injected into EVERY session and re-billed as cached prefix on EVERY turn: measured on
// real sessions, cache reads were 69% of weighted cost at ~850 turns/session, so each line here costs ~1,800
// cache-read tokens per session per 20 tokens of text. The previous ~690-token version mostly (1) fought a
// vs-token-safer hint that vts has since reversed (its own digest now says "qvts detected → delegate"), and
// (2) pre-explained what the enforcement hooks already hand back at the moment of need — and pre-explaining
// measurably does not convert (2 of 1,680 warned calls switched tools). What remains are the facts only this
// plugin knows: the command shapes and the two footguns.
const context = [
  "[vts-local-orchestrator] Delegate code locates and big-file reads to the local model; only a compact answer returns.",
  `  qvts -p "<repo-root>" --json "<ONE locate task>"      (fallback: ${bridge} …)`,
  `  qvts digest "<file>" --focus "<q>" · qvts digest-dir "<dir>" · qvts triage-diff [--staged] · qvts vcs <git|p4> <read-only cmd>`,
  "Always pass -p — without it qvts reuses the last configured project, often a different repo.",
  "One locate per call (it is a single-locate driver): split \"A, B and C\" into three calls and combine yourself.",
].join("\n");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
}));
process.exit(0);
