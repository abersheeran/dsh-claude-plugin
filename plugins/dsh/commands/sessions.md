---
description: List persisted DeepSeek Harness sessions and continue one
argument-hint: [session id to resume]
allowed-tools: mcp__plugin_dsh_dsh__dsh_control, mcp__plugin_dsh_dsh__dsh_delegate, mcp__plugin_dsh_dsh__dsh_wait
---

Call `dsh_control` with `action: "list"` and show the user the persisted DSH sessions: id, status, mode, last activity, title, and working directory. Do not invent sessions or ids.

If the command arguments contain a session id, treat it as the session to continue: call `dsh_delegate` with that `session_id`, `wait: false`, and a short task asking DSH to summarize where it left off. Then call `dsh_wait` and report the answer.

Otherwise, ask the user which session id to resume (or whether to start a new one). Do not resume anything until they choose.
