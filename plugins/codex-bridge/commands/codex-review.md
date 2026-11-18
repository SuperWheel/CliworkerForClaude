---
description: Get a Codex code review (uncommitted changes, branch, commit, or custom)
argument-hint: [uncommitted | branch <name> | commit <sha> | custom instructions]
---
Launch ONE `codex-bridge:codex-reviewer` sub-agent with the Agent tool to run Codex's reviewer.

Review target: $ARGUMENTS. If no target is given, review uncommitted changes. "branch X" means target base_branch with branch X. "commit S" means target commit with sha S. Any other text means target custom, with that text as the instructions.

Don't call `codex_review` yourself from the main thread: the reviewer runs inside the sub-agent so it shows as a native sub-agent.

Present the findings to the user ordered by severity, and say which ones you agree with after looking at the code.

Set the Agent call's `description` to the short task first, then `｜` and the engine with its model (and effort if given): `<task>｜Codex gpt-6.1-sol·low`, `<task>｜Antigravity gemini-3.8-flash-high`, `<task>｜ZCode 默认模型`. The row then names the model that does the work; the `sonnet` badge is only the relaying Claude agent.
