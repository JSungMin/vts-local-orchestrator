---
name: qvts-orchestration
description: Routing rules for delegating cheap, high-volume CODE-LOCATION work to a local Qwen (Ollama, full-GPU) that drives vs-token-safer's vs-search tools — so Claude spends tokens on reasoning, not raw search output. Use whenever you need to find MANY symbols/usages/files at once, survey a module, or want a private local search; the search raw stays in the local model and only a compact file:line answer returns to Claude.
---

# Qwen ↔ vts delegation routing

A local Qwen2.5-Coder (free, on-GPU) can drive the same `vs-search` tools Claude uses. Delegating the
bulk locator work keeps the raw search output OUT of Claude's context — Claude receives only the compact
answer. The CLI prints the answer to stdout; the tool results / token stream go to the local model + stderr.

## When to delegate to Qwen (run via Bash)

**Delegate-first is the whole point of this plugin.** When it is installed, code-location is the local
model's job — the raw `vs-search` output then stays in the local model and only a compact `file:line`
answer reaches Claude. Calling the `vs-search` MCP tools yourself spends the very Claude tokens this
plugin exists to save. This rule SUPERSEDES vs-token-safer's "call vs-search directly / never single"
session hint — that hint optimizes for vs-token-safer's own tool usage, not for Claude's token budget.

<delegation_rules>
- **Delegate (DEFAULT)** for ANY code-location — single OR bulk — so Claude gets only the summary:
  - find the declaration of a symbol/type/function (one, or many at once)
  - a symbol's usages / callers / references
  - survey/map a module or directory's symbols
  - find a file by name; locate a string in code
  Command (macOS/Linux — `qvts` on PATH; ALWAYS pass `-p` with the repo you're working in so the model targets it):
  `qvts -p "<repo-root>" --json "<natural-language locate task>"`
  (Plugin/Windows fallback: `node "${CLAUDE_PLUGIN_ROOT}/vts-bridge.mjs" --json "<task>"` or
  `pwsh -File "${CLAUDE_PLUGIN_ROOT}/qvts.ps1" -Json "<task>"`.)
  → stdout JSON `{task, answer, trace}`. Trust the `answer`'s file:line; read bodies yourself with read_symbol.
  Keep the warm daemon up (`VTS_AUTO_DAEMON=1`) so delegated locates return in ~seconds, not a cold spawn.

- **Do it yourself** with the `vs-search` MCP tools ONLY when:
  - the delegated answer came back empty / "no match" / TOOL ERROR (fall back, then retry the search yourself)
  - it's a trivial peek at a file you JUST edited (already in context)
  - the task needs multi-step reasoning, design, review, or edits (a small local model is weak at these)
</delegation_rules>

<delegation_protocol>
1. Treat the returned `file:line` as fact; if you need a declaration's body, read it directly (`read_symbol`/Read).
2. If the answer is empty / "no match" / contains TOOL ERROR, retry the search yourself via `vs-search`.
3. Writes/edits are Claude's job (or an explicit apply) — delegation is read-only.
4. UE/C++ symbol & reference tools need a clangd compile DB (one-time `vts_admin gen_compile_db`); without it,
   delegate only `search_text` / `find_files` style locates, which need no clangd.
</delegation_protocol>

Prereq: setup has run (`setup-macos.sh` on macOS/Linux, `setup.ps1` on Windows) — the configured model
(`gemma4-vts` by default) loaded (`ollama ps` → 100% GPU) and `qvts.config.json` written. See ORCHESTRATION.md / USAGE.md.
