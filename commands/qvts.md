---
description: Delegate a code-location task to the local Qwen (drives vs-search) and use the compact file:line result.
---

Delegate this locator task to the local Qwen agent — it drives vs-token-safer's `vs-search` tools and
returns only a compact answer, so the raw search output never enters my context:

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/qwen-mcp-bridge.mjs" --json "$ARGUMENTS"
```

Then parse the stdout JSON `{task, answer, trace}`:
- Report the `answer`'s file:line findings.
- If I need a declaration's body, read it directly with `read_symbol` / Read.
- If `answer` is empty / "no match" / TOOL ERROR, fall back to the `vs-search` MCP tools myself.
