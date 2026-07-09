#!/usr/bin/env node
/*
 * route-steer.js — SessionStart hook. Injects token-saving routing guidance that makes Claude DELEGATE
 * code-location to the local LLM (via `qvts`) FIRST, instead of calling vs-token-safer's vs-search MCP
 * tools directly. This is the whole point of the plugin: the raw search output stays in the local model
 * and only a compact file:line answer reaches Claude.
 *
 * It exists to WIN the routing fight against vs-token-safer's own SessionStart hook, which injects a
 * "call vs-search directly / never single" hint (that hint optimizes for vts's tool adoption, not for
 * Claude's token budget). We emit a higher-authority, explicit-override directive.
 *
 *   VTS_ROUTE_STEER unset / "1"  → inject the delegate-first directive (default ON)
 *   VTS_ROUTE_STEER "0"/"off"    → no-op (let vs-token-safer's direct-call hint win)
 *
 * SessionStart only — never intercepts a tool.
 */
if (/^(0|false|off|no)$/i.test(process.env.VTS_ROUTE_STEER || "")) process.exit(0);

const root = process.env.CLAUDE_PLUGIN_ROOT || "";
const bridge = root ? `node "${root}/vts-bridge.mjs"` : 'node "<plugin>/vts-bridge.mjs"';

const context = [
  "[vts-local-orchestrator] Token-saving routing — OVERRIDES vs-token-safer's \"call vs-search directly / never single\" hint.",
  "This plugin is installed specifically to keep raw code-search output OUT of Claude's context.",
  "",
  "For ANY code-location task — find a symbol/type/function decl, its refs/callers, a file by name,",
  "or a string in code (single OR bulk) — DELEGATE FIRST via Bash:",
  `  qvts -p "<repo-root>" --json "<locate task>"   (PATH)`,
  `  ${bridge} -p "<repo-root>" --json "<locate task>"   (fallback)`,
  "Always pass -p \"<repo-root>\" explicitly — omitting it does NOT fall back to your cwd, it silently",
  "reuses whatever project was last configured via setup, which is often a DIFFERENT repo.",
  "It drives vs-search locally and returns ONLY a compact file:line answer on stdout {task,answer,trace}.",
  "",
  "Do NOT call mcp__plugin_vs-token-safer_vs-search__* directly for locates — that spends the Claude tokens",
  "this plugin exists to save. Call vs-search directly ONLY when (a) the delegated answer is empty/no-match/error,",
  "(b) it's a trivial peek at a file you just edited, or (c) the task needs reasoning/review/edits.",
  "Writes/edits remain Claude's job.",
  "",
  "ONE locate per call — qvts's local model is a SINGLE-locate driver, NOT an analyst. Do NOT send a multi-part",
  "query (\"list line numbers of A, B, C, D + the body range of E + whether F is applied + where relative to G\") —",
  "the small model runs one tool then rambles a prose note or returns nothing. SPLIT it into one",
  "`where is X` / `find X in <file>` / `what calls X` per concept, then combine the results yourself. (qvts also",
  "auto-detects an obvious multi-part query and returns a decomposition hint instead of burning a model run.)",
  "",
  "READING, not just locating — same rule for INGESTING text. To survey a module or summarize/assess a big",
  "file (e.g. \"which handlers spew large output\", \"what does this file do\"), do NOT Read the whole file",
  "into your context — delegate the READ so only a compact brief comes back:",
  `  qvts digest "<file>" --focus "<question>"     → a brief (local model reads the file; you get the brief)`,
  `  qvts digest-dir "<dir>" --focus "<question>"  → per-file briefs + an overview for a whole module`,
  `  qvts triage-diff [--staged]                   → a git diff → {summary,hotspots,open}; open only flagged files`,
  `  qvts vcs <p4|git> <read-only sub> --focus "…" → run a big p4/git query (p4 opened, git status/log/diff…)`,
  `                                                  and get back a short summary, not the raw dump`,
  "Read a file directly only when you need its exact bytes to EDIT it, or for a small/just-edited file.",
  "Don't run `p4 opened` / `git status` / `git log` in Bash just to read them — that dumps the whole list into",
  "context; route them through `qvts vcs …` so only the summary returns.",
].join("\n");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
}));
process.exit(0);
