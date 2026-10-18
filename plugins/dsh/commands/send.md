---
description: Send an interjection to a running DeepSeek Harness session
argument-hint: <session id> <message for DSH>
allowed-tools: mcp__plugin_dsh_dsh__dsh_delegate, mcp__plugin_dsh_dsh__dsh_wait
---

The arguments start with a DSH session id, followed by a message.

Call `dsh_delegate` once with:

- `session_id`: the first token of the arguments
- `task`: the rest of the arguments, as a clear instruction
- `wait`: `false`

Then tell the user the interjection was queued and that DSH will process it after the current turn. Do not call `dsh_wait` unless the user explicitly asks for the result. If the arguments do not start with a session id, ask for one instead of guessing.
