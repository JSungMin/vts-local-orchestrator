---
name: qvts-orchestration
description: Routing rules for delegating cheap, high-volume CODE-LOCATION work to a local Qwen (Ollama, full-GPU) that drives vs-token-safer's vs-search tools — so Claude spends tokens on reasoning, not raw search output. Use whenever you need to find MANY symbols/usages/files at once, survey a module, or want a private local search; the search raw stays in the local model and only a compact file:line answer returns to Claude.
---

# Qwen ↔ vts delegation routing

A local Qwen2.5-Coder (free, on-GPU) can drive the same `vs-search` tools Claude uses. Delegating the
bulk locator work keeps the raw search output OUT of Claude's context — Claude receives only the compact
answer. The CLI prints the answer to stdout; the tool results / token stream go to the local model + stderr.

## When to delegate to Qwen (run via Bash)

<delegation_rules>
- **Delegate** (cheap, frugal — Claude gets only the summary):
  - find the declaration of MANY symbols/types/functions at once
  - a symbol whose usages/callers are likely numerous
  - survey/map a module or directory's symbols
  - a private codebase where you want a fully local search
  Command:
  `node "${CLAUDE_PLUGIN_ROOT}/qwen-mcp-bridge.mjs" --json "<natural-language locate task>"`
  (or `pwsh -File "${CLAUDE_PLUGIN_ROOT}/qvts.ps1" -Json "<task>"`)
  → stdout JSON `{task, answer, trace}`. Trust the `answer`'s file:line; read bodies yourself with read_symbol.

- **Do it yourself** with the `vs-search` MCP tools:
  - a single "where is X" (one round-trip — delegation overhead isn't worth it)
  - anything needing multi-step reasoning, design, review, or edits (a 14B local model is weak at these)
</delegation_rules>

<delegation_protocol>
1. Treat the returned `file:line` as fact; if you need a declaration's body, read it directly (`read_symbol`/Read).
2. If the answer is empty / "no match" / contains TOOL ERROR, retry the search yourself via `vs-search`.
3. Writes/edits are Claude's job (or an explicit apply) — delegation is read-only.
4. UE/C++ symbol & reference tools need a clangd compile DB (one-time `vts_admin gen_compile_db`); without it,
   delegate only `search_text` / `find_files` style locates, which need no clangd.
</delegation_protocol>

Prereq: `setup.ps1` has run (model `qwen-coder-vts` loaded 100% GPU) and `qvts.config.json` points at the
target repo. See ORCHESTRATION.md / DEPLOY.md in the plugin root.
