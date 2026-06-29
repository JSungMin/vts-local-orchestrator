<!--
  DROP-IN: paste this block into a project's CLAUDE.md (or ~/.claude/CLAUDE.md) so Claude
  auto-delegates bulk code-location to the local LLM. macOS/Linux version (uses the `qvts` command).
  On Windows use `pwsh -File qvts.ps1 -Json` instead of `qvts --json`.
-->

## Local LLM delegation routing (Claude + Ollama + vts)

Delegate **bulk, repetitive code-location** to the local LLM instead of spending Claude tokens on it.
The model drives vs-token-safer (`vs-search`) and returns only a compact `file:line` answer — the raw
search output stays in the free local model. Command: `qvts` (installed at `~/.local/bin/qvts`).

<delegation_rules>
- **Delegate to the local LLM** (one Bash line — Claude gets only the summary):
  - declarations of MANY symbols/types/functions at once
  - a symbol whose usages/callers are likely numerous
  - survey/map a module or directory's symbols
  - a private codebase you want searched fully locally
  Command (ALWAYS pass `-p` with the repo you're working in, so the model targets the right project — the
  default target is fixed in `~/.vs-token-safer/config.json` and is otherwise wrong for other repos):
  `qvts -p "<repo-root>" --json "<natural-language locate task>"`
  → stdout JSON `{task, answer, trace}`. Trust the `answer`'s file:line; read bodies yourself with read_symbol.

- **Do it yourself** with the `vs-search` MCP tools:
  - a single "where is X" (one round-trip — delegation overhead isn't worth it)
  - anything needing multi-step reasoning, design, review, or edits (the local model is weak at these)
</delegation_rules>

<delegation_protocol>
1. Treat the returned `file:line` as fact; if you need a declaration's body, read it directly (`read_symbol`/Read).
2. If `answer` is empty / "no match" / contains TOOL ERROR, retry the search yourself via `vs-search`.
3. Writes/edits are Claude's job — delegation is read-only.
4. C/C++ symbol & reference tools need a clangd compile DB; without one, delegate only `search_text` /
   `find_files` style locates (no clangd needed). TS/JS/Python work out of the box.
</delegation_protocol>

Rule of thumb: **"find / count / list" → the local model, "judge / design / fix" → Claude.**

Prereq (this machine): `vts-local-orchestrator/setup-macos.sh` has run and `qvts.config.json` written.
Default model is `gemma4-vts` (benchmarked the most accurate locator on this 16 GB M4; the old 7B
`qwen-coder-vts` reproducibly failed symbol-declaration searches). `ollama ps` → 100% GPU.
See ORCHESTRATION.md / USAGE.md.
