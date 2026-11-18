# CliworkerForClaude

English | [简体中文](README.zh-CN.md)

A Claude Code plugin (plugin name `codex-bridge`) that runs Codex, Antigravity and ZCode in parallel from inside Claude Code.

It turns the OpenAI Codex, Google Antigravity and ZCode CLIs into native Claude Code sub-agents (v0.3.0):

- **Real parallelism**: one `codex app-server` process hosts many threads, and each Codex sub-agent owns one thread (up to 8 at once by default; the rest wait in a queue).
- **Native display (convention: always go through a sub-agent)**: every Codex task is launched with the Agent tool as `codex-bridge:codex-worker` (`codex-computer-use` for GUI work, `codex-reviewer` for reviews), so it shows up as a native sub-agent in the desktop app and the terminal. The main conversation never calls `codex_spawn` / `codex_run` / `codex_send` / `codex_review` directly. Expand a sub-agent to watch Codex live: messages, shell commands and output, file changes, MCP calls, plans and approvals.
- **Approval relay**: Codex command, file and permission approvals, Computer Use app permissions, and questions Codex asks are all handed to Claude (`codex_respond`).
- **Bridged features**:
  - Computer Use (`cua_repl`): let a Codex agent operate Mac apps and browsers, or have Claude run JS directly and get screenshots back.
  - Windows Computer Use: use the Computer Use built into Codex Desktop on a Windows PC over SSH. Claude can drive it step by step without a model, or hand it to a Codex agent (see below).
  - Every MCP server and connector configured in Codex (Gmail, Drive, Slack, …) can be called directly: `codex_mcp_call`.
  - Codex's built-in code review: `codex_review`.
  - Codex skills (attached to a task), model and reasoning-effort switching, resuming old threads, structured output.

## Installation

```bash
claude plugin marketplace add SuperWheel/CliworkerForClaude && claude plugin install codex-bridge@leeyl-codex-bridge
```

The plugin loads in the **next new Claude Code session**. In the desktop app you can also click **+** next to the input box → **Plugins** → **Add marketplace**, enter `SuperWheel/CliworkerForClaude`, then add the `codex-bridge` plugin.

### Prerequisites

| Required / optional | Software | How to check |
|---|---|---|
| Required | Node.js ≥ 18 | `node -v` |
| Required | [Codex CLI](https://github.com/openai/codex), logged in | `codex --version`, `codex login status` |
| Optional | Google Antigravity CLI (`agy`), for `/codex-bridge:agy` | `agy --version` |
| Optional | ZCode desktop app (macOS, `/Applications/ZCode.app`), for `/codex-bridge:zcode`; run `zcode login` first to use your account's models such as GLM | Open ZCode and check that it can chat |
| Optional | Computer Use from Codex Desktop (ChatGPT.app), for `/codex-bridge:codex-cu` | `cua_repl` appears in `codex mcp list` |

Missing engines don't affect anything else. `codex_capabilities` lists the engines and models actually available on your machine.

### Let Claude install it

Send this message to Claude Code and it will check your environment, install the plugin and verify it:

```text
Please install the Claude Code plugin CliworkerForClaude (GitHub: SuperWheel/CliworkerForClaude, plugin name codex-bridge).
1. Check the environment first: node -v (needs ≥ 18), codex --version and codex login status (must be logged in). Also check the optional engines: agy --version, and whether /Applications/ZCode.app exists. If anything required is missing, stop and tell me how to install it. Do not log in to any account for me.
2. Install: run claude plugin marketplace add SuperWheel/CliworkerForClaude, then claude plugin install codex-bridge@leeyl-codex-bridge.
3. Tell me the result and which optional engines are available, and remind me to start a new session. In the new session, run /codex-bridge:codex-status to confirm the plugin is loaded.
```

### Update and uninstall

```bash
claude plugin marketplace update leeyl-codex-bridge && claude plugin update codex-bridge@leeyl-codex-bridge
```

```bash
claude plugin uninstall codex-bridge@leeyl-codex-bridge
```

### Local development

Clone the repo and add the local folder as a marketplace. After changing code, bump `version` in `plugins/codex-bridge/.claude-plugin/plugin.json`, then run the update command above:

```bash
claude plugin marketplace add ./CliworkerForClaude && claude plugin install codex-bridge@leeyl-codex-bridge
```

## Usage

| Command | What it does |
|---|---|
| `/codex-bridge:codex <task>` | Hand a task to one Codex sub-agent |
| `/codex-bridge:agy <task>` | Hand a task to one Antigravity sub-agent |
| `/codex-bridge:zcode <task>` | Hand a task to one ZCode sub-agent |
| `/codex-bridge:codex-parallel <goal or task list>` | Split into independent tasks and start several Codex sub-agents at once |
| `/codex-bridge:codex-cu <app + what to do>` | Have Codex operate a Mac app, a browser or the Windows PC via Computer Use |
| `/codex-bridge:codex-review [uncommitted / branch main / commit <sha> / custom instructions]` | Code review by Codex |
| `/codex-bridge:codex-status` | Show the status of all Codex agents |

Plain language works too, e.g. "use 3 Codex agents in parallel to add unit tests to modules a, b and c". Claude starts 3 `codex-worker` sub-agents in a single message.

### Sub-agent types

| Agent | Purpose |
|---|---|
| `codex-bridge:codex-worker` | Start Codex → stream its transcript → handle approvals → return a report |
| `codex-bridge:antigravity-worker` | Start Antigravity → live steps and final answer → return a report |
| `codex-bridge:zcode-worker` | Start ZCode → live tool and text events → return a report |
| `codex-bridge:codex-computer-use` | Computer Use enabled; high-risk UI actions are always declined and handed back to you |
| `codex-bridge:codex-reviewer` | Run a read-only Codex review and summarize the findings |

These relay agents use `sonnet` by default. They only relay and decide approvals; the real work is done by each CLI's own model. To change the relay model, edit `model:` in `plugins/codex-bridge/agents/*.md`.

## MCP tools

| Tool | Description |
|---|---|
| `codex_spawn` | Start one or more (`tasks:[...]`) engine agents in the background. `engine` defaults to codex; antigravity / zcode are also available. Returns the agent_id immediately |
| `codex_wait` | Wait for progress and return the new transcript; returns early when an agent finishes or needs input; sends MCP progress notifications |
| `codex_run` | Blocking: start and run to completion, for small one-off tasks |
| `codex_send` | Follow up: starts a new turn in the same thread when the agent is idle. Steering a running turn is Codex-only; other engines must wait for IDLE |
| `codex_respond` | Answer an approval or question: accept / accept_for_session / decline / cancel |
| `codex_interrupt` / `codex_close` | Interrupt the current turn / close the agent (optionally archiving the thread) |
| `codex_status` / `codex_transcript` | List all agents, or show one agent's full log |
| `codex_review` | Codex's built-in review (read-only) |
| `codex_capabilities` | List available models, Codex MCP servers and tools, skills, and whether Computer Use is available |
| `codex_mcp_call` | Call any MCP tool configured in Codex directly |
| `codex_computer_use` | Run JS directly in Codex's `cua_repl` (screenshots come back as images); `target:"windows"` runs it on the Windows PC, `allow_apps` lists the apps the user has approved |
| `codex_windows_cu` | Windows relay: `status` / `start` (uploads the kit if it changed and starts it in the logged-in desktop session) / `stop` (confirms every process has exited) |

### Agent states

`QUEUED → STARTING → RUNNING ⇄ NEEDS_INPUT → FINISHING → IDLE`, or `FAILED` / `INTERRUPTED` / `CLOSED`

`FINISHING` means the final answer is ready but Codex's Stop hooks (for example a memory-saving hook, up to 120 s) are still running. The result is already usable; you don't need to wait.

Logs are at `~/.codex-bridge/logs/<agent_id>.log`. Threads are persisted by default and appear in Codex history with a `[claude]` prefix.

## ZCode with your account's models (GLM, etc.)

The ZCode CLI can't load the models from your desktop-app account (such as GLM-5.3-Flash) on its own. The plugin starts ZCode the way the desktop app does:
- It reads `~/.zcode/v2/credentials.json` and `setting.json` read-only, and decrypts only the few fields the active personal plan needs.
- The key is passed to ZCode through the child process's stdin, only when ZCode authenticates a request. It is never logged or displayed.
- Everything the plugin writes lives under `~/.codex-bridge`; it never modifies `~/.zcode`.

Run `zcode login` in a terminal first. Only personal plans are supported for now; Start, Team and off-peak plans, and refreshing an expired token, need to be handled in the desktop app. See `tests/zcode-runtime.md` for how it works.

## No over-gating by default

Every Codex sub-agent the plugin starts (not Antigravity or ZCode) gets an instruction to avoid being over-defensive or over-gating:
- Routine engineering work is done without asking first: reading files, running builds and tests, editing files in the workspace, installing project dependencies, using the network.
- Escalation is requested only when the sandbox actually blocks a command.
- It still stops and reports before deleting data outside the workspace, pushing, touching credentials, sending messages, spending money or changing system settings.

To turn this off, set `CODEX_BRIDGE_AUTONOMY=0` in the plugin's `.mcp.json` env.

## Antigravity and ZCode engines

Every task must go through its matching native worker. For parallel work, **call several Agents in the same message**, each worker owning files that don't overlap. The main conversation never fans out `codex_spawn(tasks)` itself.

| Engine | Worker | Agent description example | ID |
|---|---|---|---|
| Codex | codex-worker | `task｜Codex gpt-6.1-sol·low` | cx- |
| Antigravity | antigravity-worker | `task｜Antigravity gemini-3.8-flash-high` | ag- |
| ZCode | zcode-worker | `task｜ZCode default model` | zc- |

Workers call `codex_spawn({engine, prompt, cwd, model, effort, sandbox})` and then `codex_wait` repeatedly. Each `tasks` item and `codex_run` also accept `engine`. All three engines share the `CODEX_BRIDGE_MAX_PARALLEL` queue, status and logs. Existing Codex calls, summaries and behaviour stay compatible.

| sandbox option | Antigravity | ZCode |
|---|---|---|
| read-only | `--mode plan` | `--mode plan` |
| workspace-write (default) | `--mode accept-edits --dangerously-skip-permissions` | `--mode edit` |
| danger-full-access | `--mode accept-edits --dangerously-skip-permissions` | `--mode yolo` |

These map to each CLI's native permission modes; they are not OS-level file sandboxes. Antigravity's headless mode can't show permission prompts, so write tasks must skip interactive approval; plan mode keeps its native restrictions. Task boundaries are stated in the prompt. Bridge instructions and developer_instructions go at the very start of the prompt, since agy's help shows no separate developer-instruction channel.

- **Live progress**: Antigravity's `--output-format stream-json` init, step_update and result events become the same timestamped log; `text_delta` chunks are joined into messages and result.response is marked as the final answer. ZCode was verified to support `--output-format stream-json` (not listed in its help), so tools, text and turn.completed / result are recorded live instead of only start and end.
- **Models**: Antigravity model / effort map to `--model` / `--effort`. ZCode has no `--model` flag; when a model is given, each turn uses its own app-server, resolves modelId or providerId/modelId from the installed model catalog, and sets the session model without changing the workspace default. ZCode ignores effort and says so in the summary title. The Codex default-model env vars apply to Codex only.
- **Follow-ups and interrupts**: when idle, `codex_send` starts a new process and resumes context with agy `--conversation` or ZCode `--resume` (the equivalent `session/resume` when a ZCode model is specified). Steering a running turn isn't supported and returns a clear error. `codex_interrupt` kills the whole process group and sets INTERRUPTED; `codex_close` closes the bridge agent and keeps the CLI's native history (archive is Codex-only).
- **Final states**: FINISHING means the final answer exists, but you must wait for the process to exit (IDLE) before following up; the queue slot is held until then. No result, a non-zero exit or a native error is never treated as success.
- **Automatic shim**: the bridge refreshes two symlinks, `~/.codex-bridge/zcode-shim/zcode.cjs` and `provider/zcode-builtin.json`, to fix the packaged CLI locating its provider via argv[1]. `ZCODE_ENTRY` and `ZCODE_APP` are supported. Nothing in the ZCode install or global config is modified.
- **Limits**: the engines section of `codex_capabilities` lists the local CLI paths, versions and agy models. "Available" means the command starts; it doesn't guarantee capacity for every remote model. Codex MCP / Computer Use / review / skills, image attachments, output_schema, config, ephemeral and the approval relay remain Codex-only; the other engines reject these options.

Real end-to-end checks:

```bash
node plugins/codex-bridge/tests/engines.mjs
node plugins/codex-bridge/tests/smoke.mjs
claude plugin validate plugins/codex-bridge
```

## Computer Use

- Local Computer Use comes from the `cua_repl` MCP server in your Codex config (provided by ChatGPT.app). Use `codex_capabilities` to check whether it's available.
- Codex asks "Allow Computer Use to use X?" for each app. **That permission only applies inside an agent turn**:
  - Codex agent route (`computer_use: true` or the `codex-computer-use` sub-agent): the permission request is handed to Claude as `NEEDS_INPUT`.
  - Calling `codex_computer_use` directly: only for inventory (`cua.listApps()`, `listBrowsers()`, `getState()`) and apps you set to "Always allow" in Codex; for other apps it tells you to use the agent route.
- The relay agent always declines deleting, sending, submitting, paying, changing settings or entering credentials, and hands those back to you.

## Windows Computer Use

Lets Claude on a Mac (or a Codex sub-agent) operate a Windows PC using the Computer Use built into Codex Desktop on that PC. Useful for hands-on acceptance testing of Windows desktop apps, where UI Automation scripts struggle with things like CJK input or folder dialogs.

### Windows setup (one-time, done by you)

- Install Codex Desktop, log in with your ChatGPT account, enable Computer Use and use it at least once (so the plugin and runtime get installed). Whether your account may use Computer Use is decided server-side; the plugin doesn't bypass it.
- Install Node.js and add it to PATH (or set `remoteNode` in the config).
- Enable OpenSSH Server and set up key-based login for this Windows user.
- While in use, the Windows user must be logged in with the desktop unlocked. Requires Windows 10 1809 or later (uses `conhost --headless`).

### Mac configuration

Create `~/.codex-bridge/windows-cu.json` (the env var `CODEX_BRIDGE_WINDOWS_CU_CONFIG` changes the path):

```json
{
  "host": "192.168.1.20",
  "user": "your-windows-user",
  "identity": "~/.ssh/windows_ed25519",
  "knownHosts": "~/.ssh/windows_known_hosts"
}
```

- When both `identity` and `knownHosts` are set, `~/.ssh/config` is ignored and the host key is pinned. When neither is set, your `~/.ssh/config` is used (so `host` can be an alias). `BatchMode=yes` is always on, so there are no password prompts.
- Optional: `port` (SSH port), `remoteDir` (default `%LOCALAPPDATA%\codex-bridge\windows-cu`, no spaces allowed), `remoteNode`, `relayPort` (default 47614), `idleExitSec` (seconds of idle before the relay exits, default 1800).

### Use

- **Claude drives it directly (no model)**: `codex_computer_use` with `target:"windows"`. Measured: once connected, a single action takes about 0.1–0.5 s (binding a window plus a screenshot occasionally ~2 s); the first call in each Claude session checks the kit and relay, ~7 s; a cold relay start is ~15 s. The connection stays open for 10 minutes and variables like `app` persist between calls.
- **Hand it to a Codex agent**: say "on Windows" in `/codex-bridge:codex-cu`, or pass `computer_use_target:"windows"` to `codex_spawn`. Codex sees an MCP server named `cua_windows`.
- The first use uploads the kit and starts the relay automatically, noted at the top of the result. Use `codex_windows_cu` to check status or stop it manually.

The Windows API differs from the Mac one:

```js
// app is a process path such as "process:C:\\…\\DeepSeek Harness.exe"; the permission prompt uses the display name "DeepSeek Harness"
const w = (await cua.listWindows()).find((w) => /DeepSeek Harness/i.test(`${w.app} ${w.title}`));
const app = await cua.getApp({ windowId: w.id });   // the first call in a session must be getState or getApp
const regions = await app.getScreenshot();         // returns several regions {id, zIndex, width, height} when a dialog is open
const top = [...regions].sort((a, b) => b.zIndex - a.zIndex)[0];
await app.click([830, 529], { screenshotId: top.id }); // take a fresh screenshot before coordinate clicks; pass the region id when there are several
await app.typeText("你好 — non-ASCII input works");
await app.pressKey("ctrl+a");
```

### Verification status (2026-10-30)

- Tested live (Windows 11 23H2, real Codex Desktop Computer Use): first use uploads the kit and starts the relay in the desktop session through a one-time scheduled task (no visible window, listens only on 127.0.0.1, scheduled task deleted); listing windows, binding the DeepSeek Harness window, screenshots, reading the accessibility tree; permissions auto-approved per `allow_apps`; after stop, the relay and all its children exit.
- Closing a folder dialog: passed in a pilot with the same relay design; not yet re-run in this plugin.
- Codex agent route (`computer_use_target:"windows"`): passed with a real model (gpt-6.1-sol high), creating a conversation in DeepSeek Harness on Windows, clicking, typing a Chinese message and reading the result. A Codex agent attaches its own sandbox state (`codex/sandbox-state-meta`, containing Mac paths) to every tool call, which makes node_repl on Windows refuse to run; `connect.mjs` strips that one entry before forwarding and keeps the rest of `_meta` unchanged.
- After approving with `persist:"session"`, Windows still asks again for every action (the plugin doesn't inject turn metadata); the plugin answers per `allow_apps`, so this doesn't get in the way.

### Permissions and safety

- Windows asks "Allow Codex to use <App>?". On direct calls, only apps listed in `allow_apps` are approved, for this session only, never "Always allow"; everything else is declined and reported in the result. On the Codex agent route, the prompt goes to the relay agent as `NEEDS_INPUT`.
- The relay is started in your desktop session by a one-time interactive scheduled task, which is deleted right after launch. It listens only on `127.0.0.1` and connections need a random token. The token stays on the Windows machine and is never sent back to the Mac.
- The cua_repl JS kernel still runs inside Codex's own sandbox; the Computer Use helper runs outside the sandbox just as it does for Codex Desktop, and checks the ChatGPT login and account policy itself.
- The plugin never reads or prints credentials; logs record only events, method names, durations and byte counts.
- Only one operator should use a desktop at a time. Before clicking or typing, make sure nobody else is using that computer.

## Configuration (environment variables in the `env` of `plugins/codex-bridge/.mcp.json`)

| Variable | Default | Description |
|---|---|---|
| `CODEX_BRIDGE_MAX_PARALLEL` | 8 | Maximum number of parallel agents |
| `CODEX_BRIDGE_SANDBOX` | workspace-write | Default sandbox |
| `CODEX_BRIDGE_APPROVAL_POLICY` | on-request | When Codex asks for approval |
| `CODEX_BRIDGE_APPROVAL_MODE` | ask | ask = hand to Claude; auto = approve all; deny = decline all |
| `CODEX_BRIDGE_MODEL` / `CODEX_BRIDGE_EFFORT` | Follows Codex config | Default model and reasoning effort (if your Codex config uses a very high effort, medium is a faster choice for relayed tasks) |
| `CODEX_BIN` | codex | Path to the Codex executable |
| `AGY_BIN` | agy | Path to the Antigravity executable |
| `ZCODE_APP` | /Applications/ZCode.app | ZCode app location |
| `ZCODE_ENTRY` | ZCODE_APP/Contents/Resources/glm/zcode.cjs | ZCode entry point override; provider config next to it or inside the app is found automatically |
| `CODEX_BRIDGE_APP_SERVER_ARGS` | empty | Extra arguments for `codex app-server`, e.g. `--disable hooks` |
| `CODEX_BRIDGE_LOG_DIR` | ~/.codex-bridge/logs | Log directory |
| `CODEX_BRIDGE_WINDOWS_CU_CONFIG` | ~/.codex-bridge/windows-cu.json | Windows Computer Use config file |
| `CODEX_BRIDGE_WINDOWS_CU_IDLE_SEC` | 600 | Seconds of idle before the direct-call SSH connection closes |

## Tests

```bash
cd plugins/codex-bridge && node tests/smoke.mjs --cu
```

- `tests/smoke.mjs`: 2 agents in parallel, follow-ups, status; `--cu` adds direct Computer Use calls.
- `tests/engines.mjs`: real Antigravity/ZCode writing files in parallel, ZCode same-session memory on follow-up, Antigravity read-only task in plan mode, rejection of steering while running, log checks. `AGY_TEST_MODEL` sets the test model (default claude-sonnet-4-6); `ZCODE_TEST_MODEL` additionally checks a specific model and app-server follow-ups.
- `tests/features.mjs`: approval relay, code review, capability listing.
- `tests/engine-lifecycle.mjs`: offline regression for the shared queue, follow-up arguments, permission mapping, process-tree interrupts, failure isolation and Codex title compatibility.
- `tests/cu-agent.mjs`: read-only Computer Use through a Codex agent; asks for Finder permission.
- `tests/windows-cu.mjs`: offline regression for the Windows relay (simulated cua_repl and helper): auth, concurrent connections, stop, pipe framing and approval forwarding, stripping the Codex agent's sandbox state, approving only listed apps, config validation.
- `tests/windows-cu-live.mjs`: real read-only Windows check (list windows, bind a window, screenshot); needs a configured Windows PC.

## Architecture

```
Claude main session ──Agent──▶ codex-worker sub-agent (native display)
                                    │ MCP tool calls (codex_spawn / codex_wait / codex_respond …)
                                    ▼
                    codex-bridge MCP server (server/index.mjs, zero dependencies)
                      AgentManager: agent pool for 3 engines, shared queue, event stream, Codex approval routing
                                    │ JSON-RPC (stdio)
                                    ▼
                         codex app-server (one process, many threads in parallel)
                          ├─ thread A ─ Codex agent (shell / file changes / MCP / cua_repl)
                          ├─ thread B ─ …
                          └─ utility thread ─ direct calls from codex_mcp_call / codex_computer_use

Windows Computer Use (server/windows-cu.mjs)
  Mac ── ssh … node connect.mjs ──▶ Windows relay (127.0.0.1, user desktop session)
                                      ├─ cua_repl (one per connection, JS kernel inside the Codex sandbox)
                                      └─ Computer Use named pipe ─▶ codex-computer-use.exe (outside the sandbox)
```

Antigravity / ZCode run as a separate child process per turn via `server/engines.mjs`, feeding events into the same AgentManager; they don't depend on the Codex app-server.

## License

[MIT](LICENSE)
