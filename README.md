# qwen-vts-orchestrator

**Claude + local Qwen + vs-token-safer**, as one code-navigation pipeline.

A local **Qwen2.5-Coder** (Ollama, full-GPU) drives vs-token-safer's `vs-search` tools. Claude delegates
cheap, high-volume **code-location** to it — so the raw search output stays in the free local model and
Claude spends its tokens on reasoning. Ships a **CLI**, a **live web dashboard** with a 3-way
token-savings panel, and an auto-loading **delegation-routing skill** for Claude Code.

```
        ┌─ Claude (plan · reason · synthesize · edit/review) ─┐
        │   │ (1) vs-search MCP directly  → quick single lookup │
        │   │ (2) Bash: qvts "<locate>"   → local Qwen ─────────┼─▶ vs-search ─▶ your code
        │                                    (bulk locate, free, private)        (clangd/tsserver/…)
        └─────────────────────────────────────────────────────┘
   Claude receives only the compact file:line answer; the raw search output never enters its context.
```

Rule of thumb: **"찾기/세기/나열" → Qwen, "판단/설계/고치기" → Claude.**

---

## Install

Two paths (hybrid). Both share the same engine and `setup.ps1`.

### A. As a Claude Code plugin (recommended for the team)
```
/plugin marketplace add <this-repo-url>     # or a local path
/plugin install qwen-vts-orchestrator
# then provision the local model + config:
powershell -ExecutionPolicy Bypass -File "<plugin-dir>/setup.ps1"
```
Gives Claude the `/qvts`, `/qvts-dashboard` commands and the `qvts-orchestration` skill (auto-routes
delegation). The skill tells Claude *when* to hand bulk locates to Qwen.

### B. Standalone repo (CLI + dashboard, no plugin)
```
git clone <this-repo-url> qwen-vts && cd qwen-vts
npm install
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

`setup.ps1` is **zero-config**: detects the GPU, picks a model tier, installs Ollama + the model, sets the
full-GPU env, auto-resolves vs-token-safer + clangd, and writes `qvts.config.json`.

---

## Use

```powershell
.\dashboard.cmd                                  # watch it live (browser)
node qwen-mcp-bridge.mjs "where is X declared?"   # one-shot CLI
node qwen-mcp-bridge.mjs                           # REPL
```

In Claude Code (plugin): `/qvts find all callers of TakeDamage` · `/qvts-dashboard`.

---

## VRAM tiers (auto-selected by setup.ps1)

| VRAM | model | num_ctx | KV |
|---|---|---|---|
| ≥14 GB | Qwen2.5-Coder-14B Q4_K_M | 32768 | q8_0 |
| 10–14 GB | 14B Q4_K_M | 16384 | q8_0 |
| 6.5–10 GB | 7B Q4_K_M | 32768 | q8_0 |
| <6.5 GB | 7B Q4_K_M | 8192 | q8_0 |

All tiers force `num_gpu 999` (full GPU) + flash-attention + q8 KV cache + `OLLAMA_NUM_PARALLEL=1`.

---

## Token savings (the dashboard panel)

For each run the dashboard shows three numbers — what Claude would consume under each strategy:

- **A · this method (delegate)** = tokens(final answer) — *the only real cost*; Claude gets just the summary.
- **B · CC + vs-search** = Σ capped tool-result tokens — what Claude eats if it runs vs-search itself.
- **C · CC + grep/raw** = Σ estimated uncapped response (vts's measured raw:out ratio) — the no-tool baseline.

`saved vs VTS = B − A`, `saved vs Grep = C − A`. B and C are **counterfactual baselines** (not executed) —
they show the cost you *avoided*, not tokens spent. Token counts are `≈ chars/4` estimates.

---

## Docs

- `USAGE.md` — running the CLI / REPL / dashboard, query tips, troubleshooting
- `DEPLOY.md` — per-machine setup, VRAM sizing, path overrides, removal
- `ORCHESTRATION.md` — the Claude↔Qwen↔vts division of labor + when to delegate
- `claude-routing.md` — drop-in CLAUDE.md block (non-plugin installs)

## Files

| file | role |
|---|---|
| `setup.ps1` | zero-config provisioning (GPU tier, install, build, config) |
| `qvts.config.json` | per-machine settings (generated) — the one file to edit |
| `config-loader.mjs` | merges defaults < config.json < env for every entry point |
| `qwen-mcp-bridge.mjs` | CLI: Qwen drives vs-search (one-shot / REPL / `--json`) |
| `agent-core.mjs` | streaming, event-emitting agent loop (dashboard engine) |
| `dashboard.mjs` / `.cmd` / `.ps1` | live web UI + launchers |
| `.claude-plugin/`, `skills/`, `commands/` | Claude Code plugin surface |

## Notes / limits

- A 14B local model is weaker than Claude at multi-hop reasoning — delegate concrete locates, not analysis.
- UE/C++ symbol & reference tools need a clangd compile DB (`vts_admin gen_compile_db`); without it use
  `search_text` / `find_files`, which need no clangd.
- First query after idle pays a ~90s cold model load (then `KEEP_ALIVE` keeps it warm).
- Fully local: nothing is transmitted off-machine (Ollama + vts + dashboard all on 127.0.0.1).
