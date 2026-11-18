---
name: codex-orchestration
description: How to use Codex, Google Antigravity and ZCode CLIs as parallel sub-agents from Claude Code via the codex-bridge plugin — when to delegate to Codex, how to run several Codex agents at once, how approvals, follow-ups, code review, Codex MCP tools and Computer Use work. Use whenever the user mentions Codex, Antigravity, agy or ZCode, asks for a second model or opinion, wants work parallelized across agents, or needs GUI automation of macOS apps or of the user's Windows PC.
---

# Orchestrating Codex / Antigravity / ZCode sub-agents

The codex-bridge MCP server runs one `codex app-server` process and gives every Codex sub-agent its own thread in it. Antigravity and ZCode each use a child process per turn. All three engines share the parallel queue (8 at a time by default; more are queued).

## The rule: every Codex/Antigravity/ZCode task runs in its matching sub-agent

Launch every Codex/Antigravity/ZCode task only through the Agent tool, with one of the plugin's sub-agent types. The desktop app and the terminal then show each Codex conversation as a native sub-agent: its own row, expandable, with Codex's messages, commands, diffs and approvals. Don't call `codex_spawn`, `codex_run`, `codex_send` or `codex_review` from the main thread. That runs Codex outside any sub-agent, so nothing shows natively.

| Need | Launch with the Agent tool |
|---|---|
| One Codex task | `codex-bridge:codex-worker` (`engine: "codex"`, default) |
| One Antigravity task | `codex-bridge:antigravity-worker` (`engine: "antigravity"`) |
| One ZCode task | `codex-bridge:zcode-worker` (`engine: "zcode"`) |
| Several independent tasks at once | one matching `codex-worker` / `antigravity-worker` / `zcode-worker` per task, **all in one message** |
| GUI or desktop automation (Computer Use) | `codex-bridge:codex-computer-use` (Windows PC: tell it to use `computer_use_target: "windows"`) |
| Second-opinion code review | `codex-bridge:codex-reviewer` |
| A follow-up to a Codex agent that already returned | a new `codex-worker` given the earlier `agent_id` or `thread_id`, told to continue it with `codex_send` or `resume_thread_id` |

Pass the model and effort the user asked for (e.g. `gpt-6.1-sol`, `low`) in the task text. The sub-agent hands them to `codex_spawn`.

### Name the row: task first, then engine and model

The app labels a sub-agent row with the Agent call's `description` and the Claude model that relays it (`sonnet`). The engine's own model never reaches that label. So write `description` as the short task, then `｜`, then the engine with its model and effort:
- `写素数脚本｜Codex gpt-6.1-sol·low`
- `统计行数｜Antigravity gemini-3.8-flash-high`
- `修复测试｜ZCode deepseek-v4-flash`

If the user named no model, use the Codex default from `~/.codex/config.toml`, or write `默认模型` (`…｜ZCode 默认模型`). The `sonnet` badge is only the relay; the work is done by the model named in the title. Each worker sets its engine on `codex_spawn` and follows with `codex_wait`.

Only these may run from the main thread, because they start no Codex conversation:
- `codex_status` and `codex_transcript`: inspect agents.
- `codex_capabilities`: discover models, MCP tools and skills.
- `codex_mcp_call`: one direct call to a Codex MCP tool or connector.
- `codex_computer_use`: on the Mac, inventory only (`listApps`, `getState`); real Mac GUI work goes to `codex-computer-use`. With `target: "windows"` you may drive the Windows PC step by step yourself (no Codex model involved; see below).
- `codex_windows_cu`: status, start or stop the Windows relay.
- `codex_respond`: only when a sub-agent has returned and relayed a pending approval to you.

## Autonomy by default

The bridge adds an "avoid over-defensiveness and over-gating" instruction to every Codex agent it starts (not to Antigravity or ZCode): do routine work without asking, request escalation only after a real sandbox failure, and still stop before destructive, outward-facing or credential steps. Don't repeat it in prompts. Set `CODEX_BRIDGE_AUTONOMY=0` in the plugin's `.mcp.json` env to turn it off.

## Rules for parallel work

- Each parallel task must own disjoint files. Two Codex agents editing the same file will clobber each other.
- Make every prompt self-contained, since Codex cannot see this conversation: give absolute paths, constraints and the definition of done.
- Use `sandbox: "read-only"` for research and analysis tasks.

## Lifecycle

`QUEUED → STARTING → RUNNING ⇄ NEEDS_INPUT → FINISHING (final answer in; Codex post-turn hooks still running) → IDLE`, or `FAILED` / `INTERRUPTED`. `FINISHING` and `IDLE` both mean the result can be used.

- Continue an agent with `codex_send(agent_id, message)`: a new turn resuming context when idle. Only Codex supports steering while running; Antigravity/ZCode return a clear unsupported message. Wait for IDLE before continuing a FINISHING process agent.
- Resume an older Codex thread with `codex_spawn({resume_thread_id})`.
- `codex_respond` answers approvals: accept, accept_for_session, decline or cancel.
- Full logs are at `~/.codex-bridge/logs/<agent_id>.log`.

## Computer Use safety

Codex asks "Allow Computer Use to use <App>?" per app, and that prompt is routed to whoever streams the agent. Grant it only for apps the user's task names. Deleting, sending, submitting, purchasing, changing settings and entering credentials always need the user's explicit confirmation. Never auto-approve them.

## Windows Computer Use

The bridge can operate the user's Windows PC through Codex Desktop's own Computer Use there, reached over SSH (config `~/.codex-bridge/windows-cu.json`; `codex_capabilities` says whether it is configured and running). The first use uploads a small kit and starts a relay in the logged-on Windows desktop session; it exits by itself after 30 idle minutes, or stop it with `codex_windows_cu` `stop`.

Two ways to use it:
- **Direct, from you**: `codex_computer_use` with `target: "windows"` runs your JavaScript on Windows. No model is involved: once connected most actions take 0.1–0.5 s; the first call of a session checks the kit and relay (about 7 s, about 15 s if the relay has to start). Good for scripted checks such as acceptance tests.
- **Codex agent**: `codex-computer-use` with `computer_use_target: "windows"`. Codex plans the steps and sees the Windows tool as MCP server `cua_windows`.

API essentials (Windows differs from the Mac):
- Make `cua.getState()` or `cua.getApp({ windowId })` the first call of a session. `cua.listWindows()` lists windows (id, title, and app as a process path such as `process:C:\…\App.exe`; match by name in app or title); `cua.getApp({ windowId })` binds one window and prints its accessibility tree.
- `app.getScreenshot()` returns several regions ({id, zIndex, width, height}) while a dialog is open. Before a coordinate click take a fresh screenshot, and pass the region: `app.click([x, y], { screenshotId: region.id })`. Element-index clicks are unreliable then.
- `app.typeText("…")` types Unicode text, including Chinese; `app.pressKey("ctrl+a")`, `"Delete"`, `"Return"`.

Approvals: Windows asks "Allow Codex to use <App>?". On the direct path pass `allow_apps` with the exact app names the user authorized; others are declined and the result says which. The bridge never answers "always". The same confirmation rules apply: no deleting, sending, submitting, purchasing, settings changes or credentials without the user's explicit go-ahead. Only one operator should drive the Windows desktop at a time; check with the user that it is free before clicking or typing.

## Engine modes and limitations

- `engine` is accepted on `codex_spawn`, each `tasks` item, and `codex_run`; omitted means Codex. `ag-` and `zc-` IDs work with all common lifecycle tools.
- Antigravity streams NDJSON steps and final results. Read-only uses `--mode plan`; write work uses `--mode accept-edits --dangerously-skip-permissions` because headless mode cannot prompt. Model and effort map to native flags. Bridge instructions prefix each prompt; help exposes no dedicated developer channel.
- ZCode streams live tool and message events using `--output-format stream-json`; default turns resume with `--resume`. Explicit models use a per-turn app-server and `session/resume` / `session/setModel` without changing the workspace default. Model is an installed model ID or providerId/modelId. Effort has no CLI flag and is ignored, explicitly labelled in the header.
- Read-only / workspace-write / danger-full-access map to ZCode plan / edit / yolo. Native permission modes are not an OS filesystem sandbox. Headless interactive requests cannot be relayed as Codex approvals.
- `codex_interrupt` kills Antigravity/ZCode process groups; each idle follow-up enters the same maxParallel queue. `codex_close` retains their native persisted sessions (archive is Codex-only).
- ZCode's bundled entry and provider links are refreshed in `~/.codex-bridge/zcode-shim/`; `ZCODE_ENTRY` / `ZCODE_APP` override discovery; `AGY_BIN` overrides `agy`.
- Codex MCP, Computer Use, review, skill/image attachments, structured output, config and ephemeral settings remain Codex-only. Never silently reinterpret these for another engine.
