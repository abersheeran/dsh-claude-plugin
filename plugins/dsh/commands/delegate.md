---
description: Delegate a task to a DeepSeek Harness subagent
argument-hint: <complete task brief for DSH>
allowed-tools: mcp__plugin_dsh_dsh__dsh_delegate
---

Use the `dsh_delegate` tool exactly once to delegate this task to a DeepSeek Harness subagent:

$ARGUMENTS

Before calling the tool, turn the request into a complete, standalone brief:

- State the goal, constraints, and the exact deliverable or answer format.
- Include absolute paths for every relevant file or directory.
- Add any context from this conversation the subagent needs, because it cannot see the conversation.
- Prefer `mode: read-only` for analysis or review; otherwise leave the default `workspace-write`.

When the tool returns, present its answer to the user. Do not implement the task yourself, and do not claim the subagent did something the tool result does not show.
