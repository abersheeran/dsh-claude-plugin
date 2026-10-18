---
description: Delegate a task to a DeepSeek Harness subagent
argument-hint: <complete task brief for DSH>
allowed-tools: mcp__plugin_dsh_dsh__dsh_delegate, mcp__plugin_dsh_dsh__dsh_wait, mcp__plugin_dsh_dsh__dsh_control
---

Use the `dsh_delegate` tool exactly once to delegate this task to a DeepSeek Harness subagent:

$ARGUMENTS

Before calling the tool, turn the request into a complete, standalone brief:

- State the goal, constraints, and the exact deliverable or answer format.
- Include absolute paths for every relevant file or directory.
- Add any context from this conversation the subagent needs, because it cannot see the conversation.
- Prefer `mode: read-only` for analysis or review; otherwise leave the default `workspace-write`.

If the user supplied a DSH session id in the arguments, pass it as `session_id` to continue that conversation.

When the tool returns, present its answer to the user. Do not implement the task yourself. The result may end with a `[dsh session: ...]` footer: keep the id for follow-ups, but do not show the footer unless the user asks for it.
