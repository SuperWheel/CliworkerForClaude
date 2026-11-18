---
description: Delegate a task to a Antigravity CLI sub-agent shown as a native Claude sub-agent
argument-hint: <task description>
---

Delegate this task to ONE `codex-bridge:antigravity-worker` using the Agent tool. Pass the prompt faithfully, with absolute paths, constraints, requested model/effort and definition of done.

Task: $ARGUMENTS

Every Codex/Antigravity/ZCode task must go through its matching codex-worker / antigravity-worker / zcode-worker. Never call `codex_spawn`, `codex_run` or `codex_send` from the main thread. The worker must set `engine: "antigravity"` on `codex_spawn` and follow with `codex_wait`.

For independent parallel tasks, launch several matching worker Agent calls in ONE message, each owning disjoint files. Do not fan out with `tasks` from the main thread.

Set the Agent call's `description` to the short task first, then `｜` and the engine with its model (and effort if given): `<task>｜Codex gpt-6.1-sol·low`, `<task>｜Antigravity gemini-3.8-flash-high`, `<task>｜ZCode 默认模型`. The row then names the model that does the work; the `sonnet` badge is only the relaying Claude agent.

When the worker returns, summarize actual changes and test results, and spot-check material file changes. Running steering is unsupported; continue the same session with `codex_send` only once IDLE.
