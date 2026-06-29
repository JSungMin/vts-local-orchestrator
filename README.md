# vts-local-orchestrator

> **Claude + any local LLM + [vs-token-safer](https://github.com/JSungMin/vs-token-safer)**, as one code-navigation pipeline.

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![MCP](https://img.shields.io/badge/MCP-client-1f6feb)](https://modelcontextprotocol.io)
[![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-000000)](https://ollama.com)
[![Local only](https://img.shields.io/badge/local--only-nothing%20uploaded-success)](#status--safety)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> Your coding agent's tokens are expensive. Bulk **code-location** — "find these 20 symbols", "every caller
> of X", "map this module" — is cheap, high-volume, and *exactly* what a free local model can do.
>
> This is a companion to **vs-token-safer**: a local LLM (via Ollama, full-GPU) drives the same `vs-search`
> tools, runs the search-tool loop in its own context, and hands Claude back only the compact `file:line`
> answer. The raw search output never enters Claude's window. **Model-agnostic** — any Ollama model with
> tool-calling works; the default (`gemma4:e4b`) was picked by [benchmark](#model-choice--benchmark), not by name.
>
> Fully local: Ollama + vs-token-safer + the dashboard all run on `127.0.0.1`. **Nothing leaves your machine.**

> **Why the default is `gemma4:e4b` (not a code model).** On a 16 GB Apple M4, it was the *most accurate*
> locator — clean `file:line` in a single tool call, reproducibly — and the fastest of the accurate models.
> The obvious pick, the code-specialized **qwen2.5-coder 7B, reproducibly *fails* declaration search**
> (loops on the wrong tool); 14B is accurate but memory-tight + slow; qwen3 is accurate only in its slow
> "thinking" mode; gemma3:12b can't tool-call at all. It's a measured choice — full A/B table in
> [Model choice & benchmark](#model-choice--benchmark). The pipeline is model-agnostic: swap it in one config line.

```text
        ┌─ Claude (plan · reason · synthesize · edit/review) ──────────────┐
        │   (1) vs-search MCP directly        → a quick single lookup       │
        │   (2) Bash: qvts -p <repo> "<task>" → local LLM ─┐                │
        └──────────────────────────────────────────────────┼──────────────┘
                                                            ▼
                          local LLM (Ollama, GPU)  ──tool calls──▶  vs-search  ──▶  your code
                                   ▲                                 (clangd/tsserver/pyright/…)
                                   └────── compact file:line ────────┘
        Claude receives only the compact file:line answer; the raw search output stays in the local model.
```

```text
# Claude delegates a bulk locate to the local model in one Bash line — and gets back just the answer:
$ qvts -p ./app --json "where is the function loadConfig declared, and every reference to it"
{"task":"…","answer":"config-loader.mjs:40\nagent-core.mjs:14,16\nvts-bridge.mjs:29,31","trace":[…]}
  → ~20 tokens of answer. The model ran search_symbol + find_references itself; Claude never saw the raw output.
```

Rule of thumb: **"find / count / list" → the local model · "judge / design / fix" → Claude.**

## Why

- A coding agent's context is the scarce resource. Running `vs-search` *itself* still spends Claude tokens on
  every (capped) tool result. Delegating the whole locate loop to a free local model spends **zero** Claude
  tokens until the final `file:line` summary comes back.
- Bulk locates are the ideal delegation: high volume, low reasoning. A 7–14B local model is weak at multi-hop
  reasoning but perfectly capable of "drive `search_symbol`, report the `file:line`".
- **Private by construction.** The local model and vs-token-safer both run on `127.0.0.1` — a fully local,
  offline code-navigator. Nothing is transmitted.
- **Model-agnostic, and proven by measurement.** Swapping the model is one config line; the default was chosen
  by a real A/B on this hardware ([Model choice & benchmark](#model-choice--benchmark)), not by reputation.

## Quickstart

**Prerequisites:** [Ollama](https://ollama.com), **Node ≥ 18**, and a clone of
[vs-token-safer](https://github.com/JSungMin/vs-token-safer) next to this repo (the bridge drives its
`server/`).

### macOS / Linux (recommended)

```bash
git clone <this-repo-url> vts-local-orchestrator && cd vts-local-orchestrator
npm install                          # MCP SDK (the bridge is the MCP host)
bash setup-macos.sh                  # picks the model tier by RAM, builds the tuned model, writes qvts.config.json
```

`setup-macos.sh` is re-runnable: it checks Ollama, picks a model by total RAM, pulls + builds a tuned
`-vts` variant (`num_gpu 999`, temperature 0.15), installs the cloned `vs-token-safer/server` deps, and
writes `qvts.config.json` pointing at your target repo (from `~/.vs-token-safer/config.json`). Then the
`qvts` command is yours:

```bash
qvts -p /path/to/repo "find all callers of createSession"        # human-readable answer
qvts -p /path/to/repo --json "where is UserStore declared?"      # {task, answer, trace} for a program
node dashboard.mjs                                                # live web dashboard → http://127.0.0.1:7878
```

> Install `qvts` on your PATH: `ln -sf "$(pwd)/qvts.sh" ~/.local/bin/qvts`.

### Windows

`setup.ps1` (zero-config: GPU tier, Ollama, model build, config) + `pwsh -File qvts.ps1 -Json "<task>"`.
See [DEPLOY.md](DEPLOY.md).

### Let Claude delegate automatically

Paste the block from [`claude-routing.md`](claude-routing.md) into your project's `CLAUDE.md` (or
`~/.claude/CLAUDE.md`). It tells Claude *when* to hand a bulk locate to `qvts` (and to always pass
`-p <repo>` so the local model targets the right project). As a plugin, the bundled `qvts-orchestration`
skill does this automatically.

## How it works

`vs-token-safer` ships no model and transmits nothing — it's a token-capped, language-server-backed
code-search surface for Claude Code. Claude Code can't swap its own model to a local one, so to let a local
LLM use those same tools, the bridge runs a **separate MCP host**: it spawns the `vs-search` server over
stdio (official MCP SDK), hands every locator tool to the Ollama model as a tool, and runs the
call → tool → call loop until the model answers.

| Actor | Role | Cost |
| --- | --- | --- |
| **Claude** (Claude Code) | Orchestrator / reasoner: plan, multi-step reasoning, synthesis, write/review code. | paid (tokens) |
| **Local LLM** (Ollama, full-GPU) | Local worker: drives `vs-search` for `file:line` locates and bulk symbol surveys. | free / local |
| **vs-token-safer** (`vs-search`) | Shared tool surface: both sides use the same language-server index. | — |

**Tools the local model drives** (read-only locators — edits stay with Claude): `search_symbol`,
`find_references`, `goto_definition`, `hover`, `document_symbols`, `read_symbol`, `find_files`,
`search_text`, `concept_search`, `diagnostics`. (The mutating tools `replace_symbol_body` / `insert_symbol`
/ `rename` / `safe_delete` and the heavy `vts_admin` are withheld — a small local model wandering into them
risks accidental edits or multi-minute hangs.)

**Reliability guards in the bridge:** projectPath is auto-injected (the model emits placeholders);
tool-calls are recovered from free text (the qwen/gemma templates often emit the call as content); a
duplicate-call guard and a 4-empty-results guard stop a small model from looping on a misspelled query; and
the system prompt is a strict locator contract (report what the tools find, never overturn a positive
result, terse `file:line` only — see [Output optimization](#output-optimization)).

## Model choice & benchmark

This pipeline is **model-agnostic** — any Ollama model with the `tools` capability can drive `vs-search`.
The model is set in `qvts.config.json` (`model`) and built as a tuned `-vts` variant (temperature 0.15 +
the model's recommended sampler + `num_gpu 999`).

The default isn't picked by reputation. On a **16 GB Apple M4 (Metal GPU)** every candidate was driven
through the real `qvts` bridge on locate tasks with known answers across three real repos (this repo, the
`vs-token-safer` repo, and a TypeScript pnpm monorepo), scored on `file:line` **correctness**, tool-call
reliability, **speed** (warm), and whether it stays **100 % on GPU** within 16 GB.

| Model (tuned `-vts`) | size | symbol-declaration search | other locates | speed (warm) | GPU / memory | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **gemma4:e4b** *(default)* | 8 B | ✅ **8/8**, 1 call each | ✅ | **7–12 s** | 100 % GPU · ~9.6 GB | **best balance** |
| qwen2.5-coder 14B | 14 B | ✅ 4/4 | ✅ | slow 9–43 s | 100 % GPU · ~11 GB (tight) | accurate but slow + heavy |
| qwen3:8b | 8 B | ✅ only with `think` on · ❌ 1/4 with it off | ✅ | very slow 23–89 s | 100 % GPU · ~6.6 GB | bad accuracy↔speed tradeoff |
| qwen2.5-coder 7B | 7.6 B | ❌ **0/6** (loops on the wrong tool) | ✅ files/refs | fast 2–3 s | 100 % GPU · ~5.8 GB | fails a core locator function |
| gemma3:12b | 12 B | — | — | — | — | **disqualified — no `tools` capability** |

**Conclusion:** `gemma4:e4b` is the practical optimum on 16 GB — the most accurate (clean `file:line` in a
single call, reproducibly), the fastest of the *accurate* models, and a comfortable GPU fit. The
code-specialized qwen2.5-coder 7B (an obvious first guess) **reproducibly fails "where is X declared"** — it
reaches for the wrong tool and loops — so it's unsafe as a locator default. Scaling qwen up *does* fix
accuracy (14B = 4/4), but 14B is memory-tight and slow on 16 GB, and qwen3:8b is accurate only with its slow
"thinking" mode on. RAM is the binding limit: there is no larger gemma that fits 16 GB at full GPU.

<details>
<summary><b>Method (reproduce it)</b></summary>

- **Variants:** each model built with `ollama create <name>-vts -f Modelfile.<name>` — `FROM <base>` +
  `temperature 0.15` + the model's recommended sampler (qwen: `top_p 0.8`/`top_k 20`/`repeat_penalty 1.05`;
  gemma: `top_p 0.95`/`top_k 64`) + `num_gpu 999` + `num_ctx 16384` + `num_predict 4096`.
- **Driver:** the real `qvts` bridge (model → MCP → `vs-search`), `--json` captured for `answer` + `trace`.
- **Reasoning control:** the bridge's `QVTS_THINK` env (`0` → `think:false`). qwen3 needs it **on** to be
  accurate (and is then very slow); gemma4 scores best with it **unset** (thinking available) — `8/8` vs
  `3/4` when forced off.
- **Queries (ground truth):** `find_files` (`cli.js`, `turbo.json`), `search_symbol`
  (`loadConfig`→`config-loader.mjs:40`, `createHash`→`scripts/release-bump.mjs:28`), `find_references`
  (`loadConfig` → 3 files). Each repeated to check reproducibility.
- **GPU check:** `ollama ps` — `PROCESSOR` must read `100% GPU` (a 14B at 16 GB CPU-offloads as
  `x%/y% CPU/GPU` **unless** `num_gpu 999` is set, which the tuned variant does).
</details>

<details>
<summary><b>Switching the model</b></summary>

```bash
ollama create my-vts -f Modelfile.my        # FROM <base> + temperature 0.15 + num_gpu 999 + num_ctx
# set "model": "my-vts" in qvts.config.json   (or export QVTS_MODEL=my-vts)
```

The model must have the `tools` capability (`ollama show <model>` → Capabilities). For a "thinking" model,
set `QVTS_THINK=0` to disable reasoning for fast tool-driving — **except** where the model is only accurate
with it on (test both). `gemma4:e4b` here is a locally-imported custom model; substitute any tool-capable
Ollama model that fits your VRAM.
</details>

## Output optimization

A general model wraps answers in prose ("The function `loadConfig` is declared at `/abs/path:40`.") — extra
tokens back to Claude, against the whole point. Two layers keep the answer minimal:

1. **Strict format contract** in the system prompt — *"FINAL ANSWER: only `path:line`, one per line, no
   prose, no closing remarks; `no match` if nothing."*
2. **`relAnswer()`** post-processing in the bridge strips the project-root prefix → repo-relative paths.

Result: `"The function loadConfig is declared at /Users/.../config-loader.mjs:40"` (~110 chars) →
**`config-loader.mjs:40`** (~20) — **~80 % fewer return tokens**, accuracy unchanged (verified 4/4).

## Token savings (the dashboard panel)

`node dashboard.mjs` (→ `http://127.0.0.1:7878`) streams the model's tool-driving live and, per run, shows
three numbers — what Claude would consume under each strategy:

- **A · this method (delegate)** = tokens(final answer) — *the only real cost*; Claude gets just the summary.
- **B · CC + vs-search** = Σ capped tool-result tokens — what Claude eats running vs-search itself.
- **C · CC + grep/raw** = Σ estimated uncapped response (vts's measured raw:out ratio) — the no-tool baseline.

`saved vs VTS = B − A`, `saved vs Grep = C − A`. B and C are **counterfactual baselines** (not executed) —
the cost you *avoided*. Token counts are `≈ chars/4` estimates.

## Token-saving features

Beyond keeping the raw search loop out of Claude's context, the bridge stacks four token-savers:

- **Terse, repo-relative output** — the model's answer is forced to a bare `file:line` list and the
  project-root prefix is stripped (~80 % fewer return tokens; see [Output optimization](#output-optimization)).
- **Persistent savings ledger** — every delegation records what Claude *would* have spent vs what it
  actually received, to `~/.vts-local/savings.json`. Read it with **`qvts --savings`**; each `--json`
  response also carries a per-call `savings` object.
- **Locate cache** — a repeated identical locate returns from `~/.vts-local/cache/` with **zero model
  cost** (~16× faster in practice). Invalidation: a git repo keys on `HEAD` (clean) and **isn't cached
  while dirty**; a non-git target uses a TTL. Bypass with **`--no-cache`**.
- **Batch delegation** — **`qvts --batch '["q1","q2",…]'`** runs many locates over one warm MCP
  connection + warm model and returns a single `{results:[…]}` map (cache + ledger apply per query). The
  payload can be inline JSON, a file path, or `-` for stdin.

```bash
qvts -p ./app --json "where is createSession declared"     # one locate (cached, ledgered)
qvts -p ./app --batch '["find AuthService","callers of login","files named *.test.ts"]'   # many, one session
qvts --savings                                             # cumulative tokens saved
```

## Configuration

`config-loader.mjs` merges, low→high: **built-in defaults < `qvts.config.json` < `VTS_*`/`QVTS_*` env.**
CLI flags: `--json` · `-p/--project <repo>` · `--savings` · `--no-cache` · `--batch <json|file|->`.

| Config key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `model` | `QVTS_MODEL` | `gemma4-vts` | Ollama model the bridge drives (must have `tools`). |
| `numCtx` | `QVTS_NUM_CTX` | `16384` | Context window passed to Ollama. |
| `maxSteps` | `QVTS_MAXSTEPS` | `25` | Tool-call rounds before the bridge gives up. |
| `vtsServer` | `VTS_SERVER` | auto | Path to `vs-token-safer/server/index.js`. |
| `project` | `VTS_PROJECT` | `~/.vs-token-safer` projectPath | Target repo (override per call with `qvts -p <repo>`). |
| — | `QVTS_THINK` | unset | `0` = `think:false` (fast tool-driving); `1` = on; unset = model default. |
| — | `QVTS_TOOLS` | locator set | Comma list to override which `vs-search` tools the model sees. |
| — | `QVTS_CACHE_TTL` | `3600` | Cache TTL (s) for a **non-git** target (git targets key on HEAD). |
| — | `QVTS_CACHE_DIR` / `QVTS_CACHE_MAX` | `~/.vts-local/cache` / `500` | Cache location / max entries (oldest pruned). |
| — | `QVTS_SAVINGS_FILE` | `~/.vts-local/savings.json` | Savings ledger path. |
| — | `VTS_USD_PER_MTOK` | `3` | $/Mtok rate for the `--savings` value line. |
| `ollamaHost` | `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama address. |
| `port` | `PORT` | `7878` | Dashboard port. |

## Files

| file | role |
| --- | --- |
| `setup-macos.sh` | re-runnable macOS/Linux provisioning (RAM tier, model build, config) |
| `setup.ps1` | Windows zero-config provisioning (GPU tier, install, build, config) |
| `qvts.sh` / `qvts.ps1` | thin `qvts` wrapper (`--json`, `-p/--project`) — macOS-Linux / Windows |
| `qvts.config.json` | per-machine settings (generated) — the one file to edit |
| `config-loader.mjs` | merges defaults < config.json < env for every entry point |
| `vts-bridge.mjs` | the bridge CLI: a local LLM drives vs-search (one-shot / REPL / `--json`) |
| `agent-core.mjs` | streaming, event-emitting agent loop (dashboard engine) |
| `dashboard.mjs` / `.cmd` / `.ps1` | live web UI + launchers |
| `Modelfile.*` | tuned `-vts` model definitions (the benchmarked variants) |
| `.claude-plugin/`, `skills/`, `commands/` | Claude Code plugin surface |

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| First query stalls for ~90 s | Cold model load (and clangd cold index on a big tree). One-time; `OLLAMA_KEEP_ALIVE` keeps it warm after. |
| `ollama ps` shows CPU offload (`x%/y% CPU/GPU`) | Model too big for VRAM. Use a smaller model, or rebuild the variant with `num_gpu 999` (forces full GPU); on 16 GB prefer a 7–8B / `gemma4:e4b`. |
| `could not resolve @modelcontextprotocol/sdk` | Run `npm install` in the cloned `vs-token-safer/server/` (its deps power the spawned server). |
| Answer is empty / "no match" on a symbol you know exists | A small model picked the wrong tool, or the symbol is misspelled. Retry, or have Claude run `vs-search` directly. Prefer a benchmark-passing model. |
| Wrong repo searched | `qvts` used the fixed default target — always pass `-p <repo-root>`. |
| Verbose, prose-y answers | The model ignored the format contract; check `QVTS_THINK` and prefer a tuned `-vts` variant. |

## Status & safety

- **Local-only, nothing uploaded.** Ollama, the `vs-search` server, and the dashboard all bind `127.0.0.1`.
  The bridge's only outbound action is the first-run `npm install` of the MCP SDK.
- The local model gets **read-only locator tools**; all edits stay with Claude.
- Benchmarks above are from this machine (Apple M4, 16 GB); your numbers depend on your model and hardware —
  reproduce with the [method](#model-choice--benchmark).

## Related

- **[vs-token-safer](https://github.com/JSungMin/vs-token-safer)** — the code-search/edit layer this drives
  (the `vs-search` MCP server + `vts` CLI). Required.
- `USAGE.md` · `DEPLOY.md` · `ORCHESTRATION.md` · `claude-routing.md` — running the CLI/REPL/dashboard,
  per-machine setup, the Claude↔model↔vts division of labor, and the drop-in `CLAUDE.md` routing block.

## License

MIT © 2026 JSungMin
