---
description: Install/verify the vts-local-orchestrator runtime dependency (MCP SDK) so the qvts bridge + dashboard run from a fresh plugin install (no setup needed).
---

Ensure the local orchestrator's one runtime dependency (`@modelcontextprotocol/sdk`) is present for the
installed plugin copy. The bridge also self-heals on first run, but this command does it explicitly (e.g.
right after `/plugin install`, or to pre-warm before the first delegation).

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.mjs"
```

Verify only (never installs; exit 1 if missing):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.mjs" --check
```

Report the result. On failure, run `npm install --omit=dev` inside `${CLAUDE_PLUGIN_ROOT}` manually.
