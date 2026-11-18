---
description: Split work into independent tasks and run several Codex sub-agents in parallel
argument-hint: <overall goal, or a list of tasks>
---
Run the following work on several OpenAI Codex sub-agents at the same time.

Work: $ARGUMENTS

1. Split it into independent tasks: none needs another's output, and no two tasks edit the same files. If parts depend on each other, run them in sequence instead, and say so.
2. In a SINGLE message, launch one `codex-bridge:codex-worker` sub-agent per task with the Agent tool (several Agent calls in the same message run in parallel). Give each one a self-contained task description with the exact files or areas it owns.
   Never fan out with `codex_spawn` `tasks:[…]` from the main thread: each Codex agent must be its own `codex-worker` so it shows as a native sub-agent.
3. When all of them return, merge the results: what each agent changed, any conflicts or failures, and what remains. Spot-check the claimed changes.

Set the Agent call's `description` to the short task first, then `｜` and the engine with its model (and effort if given): `<task>｜Codex gpt-6.1-sol·low`, `<task>｜Antigravity gemini-3.8-flash-high`, `<task>｜ZCode 默认模型`. The row then names the model that does the work; the `sonnet` badge is only the relaying Claude agent.
