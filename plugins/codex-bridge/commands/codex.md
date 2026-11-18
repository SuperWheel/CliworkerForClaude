---
description: Delegate a task to a Codex CLI sub-agent (shown as a native Claude sub-agent)
argument-hint: <task description>
---
Delegate the following task to OpenAI Codex by launching ONE `codex-bridge:codex-worker` sub-agent with the Agent tool. Pass the task through faithfully, with any context from this conversation that Codex needs (absolute paths, constraints, definition of done).

Task: $ARGUMENTS

Always go through the sub-agent: never call `codex_spawn`, `codex_run` or `codex_send` yourself from the main thread, so the Codex conversation shows as a native sub-agent. If the user named a model or effort (e.g. gpt-6.1-sol low), include it in the task you pass on.

When the sub-agent returns, give the user a short summary of what Codex did, and check the claimed file changes if they matter.

Set the Agent call's `description` to the short task first, then `｜` and the engine with its model (and effort if given): `<task>｜Codex gpt-6.1-sol·low`, `<task>｜Antigravity gemini-3.8-flash-high`, `<task>｜ZCode 默认模型`. The row then names the model that does the work; the `sonnet` badge is only the relaying Claude agent.
