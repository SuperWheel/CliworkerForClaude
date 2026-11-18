# CliworkerForClaude

[English](README.md) | 简体中文

在 Claude Code 里并行调度 Codex、Antigravity、ZCode 的插件（插件名 `codex-bridge`）。

把 Codex、Google Antigravity 和 ZCode CLI 变成 Claude Code 的原生子 agent（v0.3.0）：

- **并行执行**：一个 `codex app-server` 进程承载多个 thread，每个 Codex 子 agent 独占一个 thread，真正并行（默认最多 8 个，超出的排队）
- **原生展示（约定：一律走子 agent）**：每个 Codex 任务都通过 Agent 工具启动 `codex-bridge:codex-worker`（GUI 用 `codex-computer-use`，审查用 `codex-reviewer`），在桌面 app 和终端里以原生子 agent 的形式出现。主会话不直接调用 `codex_spawn` / `codex_run` / `codex_send` / `codex_review`；展开即可看到 Codex 的实时对话：消息、shell 命令与输出、文件改动、MCP 调用、计划、审批
- **审批中继**：Codex 的命令、文件、权限审批，Computer Use 的应用授权，以及 Codex 提出的问题，都会转给 Claude 处理（`codex_respond`）
- **功能桥接**：
  - Computer Use（`cua_repl`）：可以让 Codex agent 去操作 Mac 应用和浏览器，也可以由 Claude 直接执行 JS 并拿回截图
  - Windows Computer Use：经 SSH 使用 Windows 电脑上 Codex Desktop 自带的 Computer Use，Claude 可以不经模型直接逐步操作，也可以交给 Codex agent（见下文）
  - Codex 中配置的所有 MCP 服务和 connector（Gmail、Drive、Slack 等）都能直接调用：`codex_mcp_call`
  - Codex 内置代码审查：`codex_review`
  - Codex skills（附加到任务上）、模型和推理强度切换、恢复旧 thread、结构化输出

## 安装

```bash
claude plugin marketplace add SuperWheel/CliworkerForClaude && claude plugin install codex-bridge@leeyl-codex-bridge
```

装好后**新开一个 Claude Code 会话**才会加载。桌面 app 里也可以这样装：点输入框旁的 **+** → **Plugins** → **Add marketplace**，填 `SuperWheel/CliworkerForClaude`，再添加 `codex-bridge` 插件。

### 前置条件

| 必需 / 可选 | 软件 | 检查方式 |
|---|---|---|
| 必需 | Node.js ≥ 18 | `node -v` |
| 必需 | [Codex CLI](https://github.com/openai/codex)，已登录 | `codex --version`、`codex login status` |
| 可选 | Google Antigravity CLI（`agy`），用 `/codex-bridge:agy` 时需要 | `agy --version` |
| 可选 | ZCode 桌面版（macOS，`/Applications/ZCode.app`），用 `/codex-bridge:zcode` 时需要；要用账号里的 GLM 等模型，先运行 `zcode login` | 打开 ZCode 看能否正常对话 |
| 可选 | Codex Desktop（ChatGPT.app）自带的 Computer Use，用 `/codex-bridge:codex-cu` 时需要 | `codex mcp list` 里有 `cua_repl` |

没装的引擎不影响其他功能，`codex_capabilities` 会列出本机实际可用的引擎和模型。

### 交给 Claude 安装

把下面这段话直接发给 Claude Code，它会替你检查环境、安装并验证：

```text
请帮我安装 Claude Code 插件 CliworkerForClaude（GitHub：SuperWheel/CliworkerForClaude，插件名 codex-bridge）。
1. 先检查环境：node -v（需要 ≥ 18）、codex --version 和 codex login status（需要已登录）。可选引擎也看一下：agy --version、/Applications/ZCode.app 是否存在。缺了必需项就停下来告诉我怎么装，不要替我登录任何账号。
2. 安装：运行 claude plugin marketplace add SuperWheel/CliworkerForClaude，再运行 claude plugin install codex-bridge@leeyl-codex-bridge。
3. 告诉我安装结果、哪些可选引擎可用，并提醒我新开一个会话。新会话里用 /codex-bridge:codex-status 验证插件已加载。
```

### 更新与卸载

```bash
claude plugin marketplace update leeyl-codex-bridge && claude plugin update codex-bridge@leeyl-codex-bridge
```

```bash
claude plugin uninstall codex-bridge@leeyl-codex-bridge
```

### 本地开发

克隆仓库后，把本地目录加成插件市场，改完代码后把 `plugins/codex-bridge/.claude-plugin/plugin.json` 的 `version` 加 1，再执行上面的更新命令：

```bash
claude plugin marketplace add ./CliworkerForClaude && claude plugin install codex-bridge@leeyl-codex-bridge
```

## 用法

| 命令 | 作用 |
|---|---|
| `/codex-bridge:codex <任务>` | 交给 1 个 Codex 子 agent |
| `/codex-bridge:agy <任务>` | 交给 1 个 Antigravity 子 agent |
| `/codex-bridge:zcode <任务>` | 交给 1 个 ZCode 子 agent |
| `/codex-bridge:codex-parallel <总体目标或任务列表>` | 拆成互不依赖的任务，同时启动多个 Codex 子 agent |
| `/codex-bridge:codex-cu <应用 + 要做的事>` | 由 Codex 通过 Computer Use 操作 Mac 应用、浏览器或 Windows 电脑 |
| `/codex-bridge:codex-review [uncommitted / branch main / commit <sha> / 自定义说明]` | 用 Codex 做代码审查 |
| `/codex-bridge:codex-status` | 查看所有 Codex agent 的状态 |

也可以直接用自然语言，例如「用 3 个 codex 并行分别给 a、b、c 模块补单测」，Claude 会在同一条消息里启动 3 个 `codex-worker`。

### 子 agent 类型

| agent | 用途 |
|---|---|
| `codex-bridge:codex-worker` | 启动 Codex → 流式转发 → 处理审批 → 返回报告 |
| `codex-bridge:antigravity-worker` | 启动 Antigravity → 实时步骤与最终答案 → 返回报告 |
| `codex-bridge:zcode-worker` | 启动 ZCode → 实时工具与文本事件 → 返回报告 |
| `codex-bridge:codex-computer-use` | 开启 Computer Use；高风险 UI 操作一律拒绝并交回给你确认 |
| `codex-bridge:codex-reviewer` | 只读运行 Codex 审查并整理发现的问题 |

以上中继 agent 默认用 `sonnet`，只负责转发和审批判断，实际工作由各自的 CLI 模型完成。想换模型，改 `plugins/codex-bridge/agents/*.md` 里的 `model:`。

## MCP 工具一览

| 工具 | 说明 |
|---|---|
| `codex_spawn` | 后台启动 1 个或多个（`tasks:[...]`）引擎 agent，`engine` 默认 codex，可选 antigravity / zcode，立即返回 agent_id |
| `codex_wait` | 等待进展，返回新增的 transcript；有 agent 完成或需要输入时提前返回；带 MCP progress 通知 |
| `codex_run` | 阻塞式：启动并跑完，适合一次性小任务 |
| `codex_send` | 追问：agent 空闲时在同一 thread 开新一轮，运行中 steer 仅 Codex 支持，其他引擎需等待 IDLE |
| `codex_respond` | 处理审批或问题：accept / accept_for_session / decline / cancel |
| `codex_interrupt` / `codex_close` | 中断当前轮次 / 关闭（可选择归档 thread） |
| `codex_status` / `codex_transcript` | 列出全部 agent，或查看某个 agent 的完整日志 |
| `codex_review` | Codex 内置审查（只读） |
| `codex_capabilities` | 列出可用模型、Codex 的 MCP 服务和工具、skills，以及 Computer Use 是否可用 |
| `codex_mcp_call` | 直接调用 Codex 中配置的任意 MCP 工具 |
| `codex_computer_use` | 直接在 Codex 的 `cua_repl` 里执行 JS（截图以图片形式返回）；`target:"windows"` 改在 Windows 电脑上执行，`allow_apps` 列出用户已同意的应用 |
| `codex_windows_cu` | Windows 中继：`status` / `start`（套件有变化时上传，在已登录的桌面会话里启动）/ `stop`（确认进程全部退出） |

### Agent 状态

`QUEUED → STARTING → RUNNING ⇄ NEEDS_INPUT → FINISHING → IDLE`，或 `FAILED` / `INTERRUPTED` / `CLOSED`

`FINISHING` 表示最终答案已经产出，但 Codex 的 Stop hook（比如本机的 Nowledge Mem 保存，最长 120 秒）还在运行。此时结果已经可以使用，不必等待。

日志在 `~/.codex-bridge/logs/<agent_id>.log`。thread 默认会持久化，也会出现在 Codex 历史里，名称带 `[claude]` 前缀。

## ZCode 使用账号内置模型（GLM 等）

ZCode 命令行自己加载不到桌面 app 账号里的模型（如 GLM-5.3-Flash）。插件按桌面 app 的方式启动 ZCode：
- 只读读取 `~/.zcode/v2/credentials.json` 和 `setting.json`，只解密当前生效的个人套餐所需的几项；
- 密钥只在 ZCode 请求鉴权时，通过子进程的标准输入交给 ZCode，不写日志、不显示；
- 插件写入的文件只放在 `~/.codex-bridge` 下，不改 `~/.zcode`。

前提是先在终端运行 `zcode login`。目前只支持个人套餐；Start、Team、闲时套餐，以及令牌过期后的刷新，需要回到桌面 app 处理。原理见 `tests/zcode-runtime.md`。

## 默认不过度门禁

插件每启动一个 Codex 子 agent（不包括 Antigravity 和 ZCode），都会自动附上「避免过度防御和过度门禁」的指令：
- 常规工程操作直接做，不先请示：读文件、跑构建和测试、改工作区内的文件、装项目依赖、联网；
- 只有命令真的被沙箱挡住才申请提权；
- 删除工作区外的数据、推送、碰凭据、发消息、花钱、改系统设置仍会停下来报告。

想关掉的话，在插件的 `.mcp.json` 环境变量里设 `CODEX_BRIDGE_AUTONOMY=0`。

## Antigravity 与 ZCode 引擎

所有任务都必须用匹配的原生 worker；并行时在**同一条消息里调用多个 Agent**，每个 worker 负责互不冲突的文件。主会话不直接 fan-out `codex_spawn(tasks)`。

| 引擎 | worker | Agent description 示例 | ID |
|---|---|---|---|
| Codex | codex-worker | `任务｜Codex gpt-6.1-sol·low` | cx- |
| Antigravity | antigravity-worker | `任务｜Antigravity gemini-3.8-flash-high` | ag- |
| ZCode | zcode-worker | `任务｜ZCode 默认模型` | zc- |

worker 使用 `codex_spawn({engine, prompt, cwd, model, effort, sandbox})`，然后反复 `codex_wait`。`tasks` 每项和 `codex_run` 也支持 engine。三种引擎共用 `CODEX_BRIDGE_MAX_PARALLEL` 队列、状态与日志。Codex 的既有调用、摘要和运行方式保持兼容。

| sandbox 选项 | Antigravity | ZCode |
|---|---|---|
| read-only | `--mode plan` | `--mode plan` |
| workspace-write（默认） | `--mode accept-edits --dangerously-skip-permissions` | `--mode edit` |
| danger-full-access | `--mode accept-edits --dangerously-skip-permissions` | `--mode yolo` |

这些映射是 CLI 的原生权限模式，不等于操作系统级文件沙箱。Antigravity 无头模式不能弹出权限询问，写入任务必须跳过交互审批；plan 模式保留原生限制。任务边界由提示词明确传达。桥接指令和 developer_instructions 放在提示词最前面；agy 帮助未提供单独的 developer 指令通道。

- **实时进度**：Antigravity `--output-format stream-json` 的 init、step_update、result 被转成同样的时间戳日志；`text_delta` 拼成消息，result.response 标记为最终答案。ZCode 已实测支持帮助页未列出的 `--output-format stream-json`，实时记录工具、文本与 turn.completed / result；无需退回仅显示起止。
- **模型**：Antigravity model / effort 对应 `--model` / `--effort`。ZCode 没有 `--model` 标志；显式指定 model 时使用每轮独立的 app-server，通过已安装模型目录解析 modelId 或 providerId/modelId，再设置会话模型，不修改工作区默认模型。ZCode effort 忽略并在摘要标题注明；Codex 默认模型环境变量仅作用于 Codex。
- **续聊与中断**：空闲时 `codex_send` 创建新进程，使用 agy `--conversation`、ZCode `--resume` 恢复上下文；指定 ZCode 模型时使用等价的 `session/resume`。运行中不支持 steering，会返回明确错误。`codex_interrupt` 终止整个进程组，状态为 INTERRUPTED；`codex_close` 关闭桥接 agent，保留 CLI 原生历史（archive 仅 Codex 支持）。
- **最终状态**：FINISHING 表示已有最终答案，仍需等待进程退出后到 IDLE 才能续聊；进程退出前保留队列名额。无结果、非零退出、原生错误不会被当作成功。
- **自动 shim**：桥接会刷新 `~/.codex-bridge/zcode-shim/zcode.cjs` 和 `provider/zcode-builtin.json` 两个符号链接，修复打包 CLI 按 argv[1] 定位 provider 的问题；支持 `ZCODE_ENTRY`、`ZCODE_APP`。无需修改 ZCode 安装内容或全局配置。
- **能力边界**：`codex_capabilities` 的 engines 区列出本机可用 CLI 路径、版本与 agy 模型。可用表示命令可启动，不保证每个远程模型都有容量。Codex MCP / Computer Use / review / skills、图片附件、output_schema、config、ephemeral 与审批中继仍为 Codex 专属；新引擎不接受这些桥接选项。

真实验收：

```bash
node plugins/codex-bridge/tests/engines.mjs
node plugins/codex-bridge/tests/smoke.mjs
claude plugin validate plugins/codex-bridge
```

## Computer Use 说明

- 本机的 Computer Use 来自 Codex config 中的 `cua_repl` MCP（由 ChatGPT.app 提供）。可以用 `codex_capabilities` 确认是否可用
- Codex 对每个应用都会弹出「Allow Computer Use to use X?」。**这个授权只在 agent 轮次内生效**：
  - Codex agent 路线（`computer_use: true` 或 `codex-computer-use` 子 agent）：授权请求以 `NEEDS_INPUT` 的形式交给 Claude
  - 直接调用 `codex_computer_use`：只能用于清点（`cua.listApps()`、`listBrowsers()`、`getState()`），以及你在 Codex 里设为「始终允许」的应用；其他应用会提示改走 agent 路线
- 删除、发送、提交、付款、改设置、输入凭据这类操作，中继 agent 一律拒绝，并交回给你确认

## Windows Computer Use

让 Mac 上的 Claude（或 Codex 子 agent）操作一台 Windows 电脑，用的是那台电脑上 Codex Desktop 自带的 Computer Use。适合 Windows 桌面应用的实机验收：中文输入、文件夹对话框这类 UI Automation 脚本不好处理的场景。

### Windows 端准备（一次性，由你亲自完成）

- 安装 Codex Desktop，用 ChatGPT 账号登录，开启 Computer Use 并至少用过一次（这样插件和运行时才会装好）。账号是否允许使用 Computer Use 由服务端决定，插件不会绕过
- 安装 Node.js 并加入 PATH（或在配置里写 `remoteNode`）
- 开启 OpenSSH Server，给这个 Windows 用户配好密钥登录
- 使用时 Windows 用户必须已登录、桌面未锁屏。需要 Windows 10 1809 及以上（用到 `conhost --headless`）

### Mac 端配置

新建 `~/.codex-bridge/windows-cu.json`（可用环境变量 `CODEX_BRIDGE_WINDOWS_CU_CONFIG` 换路径）：

```json
{
  "host": "192.168.1.20",
  "user": "your-windows-user",
  "identity": "~/.ssh/windows_ed25519",
  "knownHosts": "~/.ssh/windows_known_hosts"
}
```

- 同时写了 `identity` 和 `knownHosts` 时不读 `~/.ssh/config`，并固定主机密钥；两个都不写则沿用你的 `~/.ssh/config`（`host` 可以写成别名）。始终 `BatchMode=yes`，不会弹出密码提示
- 可选：`port`（SSH 端口）、`remoteDir`（默认 `%LOCALAPPDATA%\codex-bridge\windows-cu`，路径不能有空格）、`remoteNode`、`relayPort`（默认 47614）、`idleExitSec`（中继空闲多少秒后自动退出，默认 1800）

### 使用

- **Claude 直接操作（不经模型）**：`codex_computer_use` 加 `target:"windows"`。实测：连上之后单个动作约 0.1–0.5 秒（绑定窗口加截图偶尔到 2 秒左右）；每个 Claude 会话的第一次调用要检查套件和中继，约 7 秒；中继冷启动约 15 秒。连接保留 10 分钟，`app` 等变量在多次调用之间保留
- **交给 Codex agent**：`/codex-bridge:codex-cu` 里写明「在 Windows 上」，或 `codex_spawn` 加 `computer_use_target:"windows"`。Codex 看到的是 MCP 服务 `cua_windows`
- 第一次使用会自动上传套件、启动中继，之后在结果开头注明。用 `codex_windows_cu` 可以查看状态或手动停止

Windows 版 API 与 Mac 不同：

```js
// app 是进程路径，如 "process:C:\\…\\DeepSeek Harness.exe"；授权询问里用的是显示名 "DeepSeek Harness"
const w = (await cua.listWindows()).find((w) => /DeepSeek Harness/i.test(`${w.app} ${w.title}`));
const app = await cua.getApp({ windowId: w.id });   // 会话里第一个调用必须是 getState 或 getApp
const regions = await app.getScreenshot();         // 有对话框时返回多个区域 {id, zIndex, width, height}
const top = [...regions].sort((a, b) => b.zIndex - a.zIndex)[0];
await app.click([830, 529], { screenshotId: top.id }); // 坐标点击前先截新图，多区域时带上区域 id
await app.typeText("中文输入没问题");
await app.pressKey("ctrl+a");
```

### 验证情况（2026-10-30）

- 已实测（Windows 11 23H2，真实 Codex Desktop Computer Use）：首次使用自动上传套件、经一次性计划任务在桌面会话启动中继（进程无可见窗口、只监听 127.0.0.1、计划任务已删除）；列出窗口、绑定 DeepSeek Harness 窗口、截图、读取无障碍树；授权按 `allow_apps` 自动同意；停止后中继及其子进程全部退出
- 关闭文件夹对话框：在同一中继设计的试点中实测通过，本插件尚未重跑
- Codex agent 路线（`computer_use_target:"windows"`）：已用真实模型（gpt-6.1-sol high）跑通，在 Windows DeepSeek Harness 里新建对话、点击、输入中文消息并读取结果。Codex agent 会给每次工具调用附带自己的沙箱状态（`codex/sandbox-state-meta`，里面是 Mac 路径），Windows 上的 node_repl 会因此拒绝执行；`connect.mjs` 转发前去掉这一项，其余 `_meta` 原样保留
- 带 `persist:"session"` 同意后，Windows 仍会对每个动作再次询问（插件不注入轮次元数据）；插件按 `allow_apps` 自动应答，不影响使用

### 授权与安全

- Windows 会询问「Allow Codex to use <App>?」。直接调用时只有 `allow_apps` 里写明的应用会被同意，范围是本次会话，从不选「始终允许」；其他一律拒绝，并在结果里说明。走 Codex agent 时，这个询问以 `NEEDS_INPUT` 交给中继 agent
- 中继由一次性的交互式计划任务启动在你的桌面会话里，启动后计划任务立即删除；只监听 `127.0.0.1`，连接需要随机令牌。令牌生成后只存在 Windows 本机，不回传 Mac
- cua_repl 的 JS 内核仍在 Codex 自己的沙箱里；Computer Use 助手程序和 Codex Desktop 一样运行在沙箱外，并由它自己检查 ChatGPT 登录与账号策略
- 插件不读取、不打印任何凭据；日志只记录事件、方法名、耗时和字节数
- 同一个桌面同一时间只应有一个操作方。开始点击或输入前，先确认没有人在用那台电脑

## 配置（环境变量，写在 `plugins/codex-bridge/.mcp.json` 的 `env` 中）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODEX_BRIDGE_MAX_PARALLEL` | 8 | 最大并行 agent 数 |
| `CODEX_BRIDGE_SANDBOX` | workspace-write | 默认沙箱 |
| `CODEX_BRIDGE_APPROVAL_POLICY` | on-request | Codex 何时请求审批 |
| `CODEX_BRIDGE_APPROVAL_MODE` | ask | ask = 交给 Claude；auto = 全部同意；deny = 全部拒绝 |
| `CODEX_BRIDGE_MODEL` / `CODEX_BRIDGE_EFFORT` | 跟随 Codex config | 默认模型和推理强度（本机 config 是 max，速度较慢；中继任务建议设为 medium） |
| `CODEX_BIN` | codex | Codex 可执行文件路径 |
| `AGY_BIN` | agy | Antigravity 可执行文件路径 |
| `ZCODE_APP` | /Applications/ZCode.app | ZCode 应用位置 |
| `ZCODE_ENTRY` | ZCODE_APP/Contents/Resources/glm/zcode.cjs | 优先指定 ZCode 入口；自动查找相邻或应用内 provider 配置 |
| `CODEX_BRIDGE_APP_SERVER_ARGS` | 空 | 追加给 `codex app-server` 的参数，比如 `--disable hooks` |
| `CODEX_BRIDGE_LOG_DIR` | ~/.codex-bridge/logs | 日志目录 |
| `CODEX_BRIDGE_WINDOWS_CU_CONFIG` | ~/.codex-bridge/windows-cu.json | Windows Computer Use 配置文件 |
| `CODEX_BRIDGE_WINDOWS_CU_IDLE_SEC` | 600 | 直接调用的 SSH 连接空闲多少秒后关闭 |

## 测试

```bash
cd plugins/codex-bridge && node tests/smoke.mjs --cu
```

- `tests/smoke.mjs`：2 个 agent 并行、追问、状态查询，`--cu` 再加上 Computer Use 直接调用
- `tests/engines.mjs`：真实 Antigravity/ZCode 并行写文件、ZCode 同会话记忆续聊、Antigravity plan 模式只读任务、运行中 steering 拒绝、日志检查；`AGY_TEST_MODEL` 可指定测试模型（默认 claude-sonnet-4-6），`ZCODE_TEST_MODEL` 可额外验收指定模型及 app-server 续聊
- `tests/features.mjs`：审批中继、代码审查、能力清单
- `tests/engine-lifecycle.mjs`：离线回归共享队列、续聊参数、权限映射、进程树中断、失败隔离和 Codex 标题兼容
- `tests/cu-agent.mjs`：通过 Codex agent 只读地使用 Computer Use，会请求 Finder 授权
- `tests/windows-cu.mjs`：离线回归 Windows 中继（模拟 cua_repl 与助手程序）：认证、并发连接、停止、管道帧与审批转发、去掉 Codex agent 的沙箱状态、只同意指定应用、配置校验
- `tests/windows-cu-live.mjs`：真实 Windows 只读验收（列出窗口、绑定窗口、截图），需要已配置的 Windows 电脑

## 架构

```
Claude 主会话 ──Agent──▶ codex-worker 子 agent（原生展示）
                              │ MCP 工具调用（codex_spawn / codex_wait / codex_respond …）
                              ▼
                 codex-bridge MCP 服务（server/index.mjs，零依赖）
                   AgentManager：三引擎 agent 池、共享队列、事件流、Codex 审批路由
                              │ JSON-RPC (stdio)
                              ▼
                    codex app-server（单进程，多 thread 并行）
                     ├─ thread A ─ Codex agent（shell / 文件改动 / MCP / cua_repl）
                     ├─ thread B ─ …
                     └─ utility thread ─ codex_mcp_call / codex_computer_use 的直连调用

Windows Computer Use（server/windows-cu.mjs）
  Mac ── ssh … node connect.mjs ──▶ Windows 中继（127.0.0.1，用户桌面会话）
                                      ├─ cua_repl（每个连接一个，JS 内核在 Codex 沙箱内）
                                      └─ Computer Use 命名管道 ─▶ codex-computer-use.exe（沙箱外）
```

Antigravity / ZCode 由 `server/engines.mjs` 每轮启动独立子进程，事件进入同一个 AgentManager；不依赖 Codex app-server 运行。

## 许可证

[MIT](LICENSE)
