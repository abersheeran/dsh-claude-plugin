---
description: Check that the DeepSeek Harness subagent is reachable
allowed-tools: mcp__plugin_dsh_dsh__dsh_delegate
---

Verify the DeepSeek Harness connection by calling the `dsh_delegate` tool once:

- `task`: `Reply with exactly: DSH_OK`
- `mode`: `read-only`
- `timeout_ms`: `120000`

Report one of these outcomes:

- **Working** — the answer contains `DSH_OK`. Tell the user the connection works.
- **Not working** — relay the tool's error message exactly, especially the authentication and `DSH_BIN` guidance, and suggest the fix from the plugin README's troubleshooting section.

Do not retry more than once, and do not try to fix the installation unless the user asks.
