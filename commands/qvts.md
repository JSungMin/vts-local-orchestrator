---
description: Delegate a code-location task to the local Qwen (drives vs-search) and use the compact file:line result.
---

Delegate this locator task to the local Qwen agent — it drives vs-token-safer's `vs-search` tools and
returns only a compact answer, so the raw search output never enters my context:

Run (macOS/Linux — `qvts` is on PATH; pass `-p` with the repo I'm working in so Qwen targets it):

```bash
qvts -p "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" --json "$ARGUMENTS"
```

(Plugin/Windows fallback: `node "${CLAUDE_PLUGIN_ROOT}/vts-bridge.mjs" --json "$ARGUMENTS"`, or
`pwsh -File "${CLAUDE_PLUGIN_ROOT}/qvts.ps1" -Json "$ARGUMENTS"`.)

Then parse the stdout JSON `{task, answer, trace}`:
- Report the `answer`'s file:line findings.
- If I need a declaration's body, read it directly with `read_symbol` / Read.
- If `answer` is empty / "no match" / TOOL ERROR, fall back to the `vs-search` MCP tools myself.
