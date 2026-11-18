---
description: Have a Codex sub-agent operate a macOS app, browser or the Windows PC via Computer Use
argument-hint: <app + what to do>
---
Launch ONE `codex-bridge:codex-computer-use` sub-agent with the Agent tool for this GUI task:

$ARGUMENTS

In the task you pass on, name the computer (this Mac, or the Windows PC when the user says Windows), the app or site, the goal, the visible end state that proves success, and which side-effecting actions the user explicitly authorized above. Nothing else is authorized. Don't do the GUI work yourself with `codex_computer_use`: it belongs to the sub-agent, so it shows as a native sub-agent. If the sub-agent reports steps that need confirmation, ask the user before continuing.

Set the Agent call's `description` to the short task first, then `｜` and the engine with its model (and effort if given): `<task>｜Codex gpt-6.1-sol·low`, `<task>｜Antigravity gemini-3.8-flash-high`, `<task>｜ZCode 默认模型`. The row then names the model that does the work; the `sonnet` badge is only the relaying Claude agent.
