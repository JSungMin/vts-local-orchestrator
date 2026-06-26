---
description: Launch the Qwen↔vts live web dashboard (token stream, tool calls, 3-way token-savings panel).
---

Launch the Qwen↔vts dashboard so the user can watch the local model drive vs-search in real time:

```bash
pwsh -File "${CLAUDE_PLUGIN_ROOT}/dashboard.ps1"
```

This opens http://127.0.0.1:7878 in the browser. The page streams model tokens, tool calls, results, and a
live token-savings panel (this method vs CC-using-vts vs CC-using-grep). Pass `-Project <repo>` to retarget,
`-Port <n>` to change the port. Stop with `pwsh -File "${CLAUDE_PLUGIN_ROOT}/stop-dashboard.ps1"`.

If `$ARGUMENTS` names a repo path, pass it as `-Project $ARGUMENTS`.
