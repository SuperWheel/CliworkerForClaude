#!/usr/bin/env node
// codex-bridge MCP server: exposes Codex, Antigravity and ZCode CLIs to Claude Code
// as a pool of parallel sub-agents, plus direct bridges to Codex's MCP tools and Computer Use.
// Zero dependencies: speaks MCP JSON-RPC over stdio directly.
import readline from 'node:readline';
import { AgentManager } from './agent-manager.mjs';
import { clip } from './format.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const log = (...a) => process.stderr.write(`[codex-bridge] ${a.join(' ')}\n`);
const mgr = new AgentManager({ log });

// ---------------- tool definitions ----------------

const spawnProps = {
  engine: { type: 'string', enum: ['codex', 'antigravity', 'zcode'], default: 'codex', description: 'Coding engine; defaults to codex. Launch through the matching codex-worker, antigravity-worker or zcode-worker native sub-agent.' },
  prompt: { type: 'string', description: 'Task for the selected coding engine sub-agent. Be specific and self-contained: goal, relevant files, constraints, definition of done.' },
  name: { type: 'string', description: 'Short label shown in status/digests.' },
  cwd: { type: 'string', description: 'Working directory (defaults to the Claude Code project dir).' },
  model: { type: 'string', description: 'Engine model override (see codex_capabilities). Antigravity uses --model; ZCode resolves an installed model ID or providerId/modelId via app-server.' },
  effort: { type: 'string', description: 'Reasoning effort, e.g. low | medium | high | xhigh. Antigravity also accepts max. ZCode ignores effort and labels it in the header.' },
  sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Default workspace-write. Antigravity: read-only = plan; writes = accept-edits + skip permissions. ZCode: plan / edit / yolo. These are native permission modes, not OS sandbox guarantees.' },
  approval_policy: { type: 'string', enum: ['untrusted', 'on-request', 'never'], description: 'When Codex asks for approval. Default on-request.' },
  approval_mode: { type: 'string', enum: ['ask', 'auto', 'deny'], description: 'How approvals are answered: ask = surface to you (codex_respond), auto = accept all, deny = decline all. Default ask.' },
  computer_use: { type: 'boolean', description: 'Enable Codex Computer Use (operate Mac apps/browsers via cua_repl).' },
  computer_use_target: { type: 'string', enum: ['mac', 'windows'], description: 'windows = operate the configured Windows PC instead (Codex Desktop Computer Use there, reached over SSH as MCP server cua_windows); implies computer_use.' },
  skills: { type: 'array', items: { type: 'string' }, description: 'Codex skill names to attach (see codex_capabilities).' },
  images: { type: 'array', items: { type: 'string' }, description: 'Image paths or URLs to attach.' },
  output_schema: { type: 'object', description: 'JSON Schema constraining the final answer.' },
  developer_instructions: { type: 'string', description: 'Extra developer instructions for this agent.' },
  resume_thread_id: { type: 'string', description: 'Continue an existing engine conversation/session ID instead of starting fresh.' },
  ephemeral: { type: 'boolean', description: 'Do not persist the Codex session to disk.' },
  config: { type: 'object', description: 'Raw Codex config overrides (dotted keys → values).' },
};

const TOOLS = [
  {
    name: 'codex_spawn',
    description: 'For matching codex-worker / antigravity-worker / zcode-worker sub-agents; from the main conversation launch those via Agent instead. Start one or more Codex, Antigravity or ZCode CLI sub-agents in the background (non-blocking) and return their agent_ids. Use `tasks` to launch several in parallel. Follow with codex_wait to stream their progress.',
    inputSchema: {
      type: 'object',
      properties: {
        ...spawnProps,
        tasks: { type: 'array', description: 'Spawn several agents at once; each item takes the same fields as a single spawn (prompt required).', items: { type: 'object', properties: spawnProps, required: ['prompt'] } },
      },
    },
  },
  {
    name: 'codex_wait',
    description: 'Block until Codex/Antigravity/ZCode agents make progress, then return each agent\'s new transcript events (messages, commands, file edits, tool calls, approvals). Returns early when an agent finishes or needs input. Call repeatedly until agents are IDLE/FAILED.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_ids: { type: 'array', items: { type: 'string' }, description: 'Agents to wait on (default: all active).' },
        timeout_sec: { type: 'number', description: 'Max seconds to block (default 90, max 3600).' },
        until: { type: 'string', enum: ['any', 'all'], description: 'Return when any agent settles (default) or only when all have.' },
      },
    },
  },
  {
    name: 'codex_run',
    description: 'For matching engine-worker sub-agents; from the main conversation launch codex-worker, antigravity-worker or zcode-worker via Agent instead. Run a selected-engine sub-agent to completion in one blocking call (spawn + wait). Returns the full transcript and final answer, or returns early if Codex needs approval/input.',
    inputSchema: {
      type: 'object',
      properties: { ...spawnProps, timeout_sec: { type: 'number', description: 'Max seconds to block (default 1800).' } },
      required: ['prompt'],
    },
  },
  {
    name: 'codex_send',
    description: 'Send a follow-up to any engine agent. Idle starts a new turn resuming its thread/conversation/session. Running steering is Codex-only; Antigravity/ZCode return a clear error until idle or interrupted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        message: { type: 'string' },
        mode: { type: 'string', enum: ['auto', 'steer', 'new_turn'], description: 'auto (default): steer if running, else new turn.' },
        images: { type: 'array', items: { type: 'string' } },
        skills: { type: 'array', items: { type: 'string' } },
        effort: { type: 'string' },
        model: { type: 'string' },
        wait_sec: { type: 'number', description: 'Optionally wait this many seconds and include the resulting events.' },
      },
      required: ['agent_id', 'message'],
    },
  },
  {
    name: 'codex_respond',
    description: 'Answer a pending Codex approval or question (shown as ⏳ NEEDS INPUT with a request_id).',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        request_id: { type: 'string' },
        decision: { type: 'string', enum: ['accept', 'accept_for_session', 'decline', 'cancel'] },
        answers: { type: 'object', description: 'For questions: map of question id → answer string (or array of strings).' },
        content: { type: 'object', description: 'For MCP form elicitations: the form content to submit.' },
        message: { type: 'string', description: 'Optional free-text reason / fallback answer.' },
      },
      required: ['agent_id', 'request_id', 'decision'],
    },
  },
  {
    name: 'codex_interrupt',
    description: 'Interrupt the running turn of any engine agent (Antigravity/ZCode kill the process tree) (it becomes INTERRUPTED and can be continued with codex_send).',
    inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] },
  },
  {
    name: 'codex_status',
    description: 'List all engine agents with status, engine and model, or show one agent\'s header, pending requests and last events.',
    inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } } },
  },
  {
    name: 'codex_transcript',
    description: 'Return the full (or last N events of the) transcript of any engine agent, without consuming the unread cursor.',
    inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, last: { type: 'number', description: 'Only the last N events.' } }, required: ['agent_id'] },
  },
  {
    name: 'codex_close',
    description: 'Close any engine agent (interrupts if running). Archiving is Codex-only; other engine sessions remain persisted by their CLI.',
    inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, archive: { type: 'boolean' } }, required: ['agent_id'] },
  },
  {
    name: 'codex_review',
    description: 'Start Codex\'s built-in code reviewer as a background agent (read-only). Use codex_wait to get the review.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        target: { type: 'string', enum: ['uncommitted', 'base_branch', 'commit', 'custom'], description: 'Default uncommitted.' },
        branch: { type: 'string', description: 'For base_branch.' },
        sha: { type: 'string', description: 'For commit.' },
        instructions: { type: 'string', description: 'For custom.' },
        model: { type: 'string' },
        effort: { type: 'string', description: 'Reasoning effort for the reviewer, e.g. medium.' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'codex_capabilities',
    description: 'Discover available engines, CLI paths and versions, Antigravity models, plus Codex models, MCP tools, computer use and skills.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } },
  },
  {
    name: 'codex_mcp_call',
    description: 'Directly call any MCP tool configured in Codex (bridges Codex\'s connectors/plugins into Claude). See codex_capabilities for servers/tools.',
    inputSchema: {
      type: 'object',
      properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } },
      required: ['server', 'tool'],
    },
  },
  {
    name: 'codex_computer_use',
    description: 'Directly drive Codex Computer Use by running JavaScript in a persistent cua_repl. Globals: `cua` and `nodeRepl.write()`. Screenshots come back as images. The first call returns the full API docs. target "mac" (default): Codex on this Mac (getApp("Notes"), listApps, listBrowsers, createBrowserTab…). target "windows": Codex Desktop on the configured Windows PC over SSH, no model involved (listWindows, getApp({windowId}), getScreenshot, click([x,y],{screenshotId}), typeText, pressKey); its "Allow Codex to use <App>?" approvals are accepted for the session only for apps listed in allow_apps and declined otherwise. Never perform destructive/sending/purchasing actions without explicit user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript to execute, e.g. `const app = await cua.getApp("Notes"); await app.getAXState();`' },
        reset: { type: 'boolean', description: 'Reset the REPL state before running.' },
        target: { type: 'string', enum: ['mac', 'windows'], description: 'Which computer to operate; default mac.' },
        allow_apps: { type: 'array', items: { type: 'string' }, description: 'Windows only: exact app names (as in "Allow Codex to use <App>?") the user authorized for this task.' },
        timeout_sec: { type: 'number', description: 'Windows only: max seconds for this call (default 180).' },
      },
      required: ['code'],
    },
  },
  {
    name: 'codex_windows_cu',
    description: 'Manage the Windows Computer Use relay configured in ~/.codex-bridge/windows-cu.json. status: kit and relay state. start: upload the kit if it changed and start the relay in the logged-on Windows desktop session (codex_computer_use target "windows" does this on first use). stop: shut the relay down and confirm its processes exited.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'start', 'stop'] } }, required: ['action'] },
  },
];

// ---------------- helpers ----------------

const text = (t) => ({ content: [{ type: 'text', text: t }] });

function makeProgress(sendNote, token) {
  if (token === undefined) return undefined;
  let n = 0;
  return (a, ev) => {
    n++;
    sendNote('notifications/progress', { progressToken: token, progress: n, message: `[${a.id}] ${clip(ev.text.split('\n')[0], 160)}` });
  };
}

function convertContent(items) {
  const out = [];
  for (const c of items || []) {
    if (c?.type === 'text') out.push({ type: 'text', text: c.text });
    else if (c?.type === 'image' && c.data) out.push({ type: 'image', data: c.data, mimeType: c.mimeType || 'image/png' });
    else if (c) out.push({ type: 'text', text: clip(JSON.stringify(c), 4000) });
  }
  return out.length ? out : [{ type: 'text', text: '(no output)' }];
}

const cuaDocShown = { mac: false, windows: false };

function windowsApprovalNotes(approvals) {
  if (!approvals?.length) return [];
  // Windows asks again for each action, so identical answers are listed once.
  const lines = [...new Set(approvals.map((a) => `- ${a.accepted ? `accepted for ${a.persist ?? 'this request'}` : 'declined'}: ${a.message}`))];
  const declined = approvals.filter((a) => !a.accepted);
  if (declined.length) lines.push(`Declined apps were not in allow_apps. Ask the user; if they agree, re-run with allow_apps including ${declined.filter((a) => a.app).map((a) => JSON.stringify(a.app)).join(', ') || 'the app name'}.`);
  return [{ type: 'text', text: `Windows app approvals:\n${lines.join('\n')}` }];
}

// ---------------- tool handlers ----------------

async function callTool(name, args, ctx) {
  switch (name) {
    case 'codex_spawn': {
      const list = args.tasks?.length ? args.tasks.map((t) => ({ ...args, tasks: undefined, ...t })) : [args];
      const agents = list.map((o) => mgr.spawn(o));
      // Give them a moment to start so the first digest has the thread id.
      await mgr.wait(agents.map((a) => a.id), { timeoutSec: 3 });
      return text(
        `Spawned ${agents.length} ${agents.every((a) => a.engine === 'codex') ? 'Codex' : 'coding'} agent(s):\n` +
        agents.map((a) => mgr.statusLine(a)).join('\n') +
        `\n\nNext: codex_wait with agent_ids ${JSON.stringify(agents.map((a) => a.id))} to stream their progress.`,
      );
    }
    case 'codex_wait': {
      const targets = await mgr.wait(args.agent_ids, {
        timeoutSec: args.timeout_sec ?? 90,
        until: args.until || 'any',
        onEvent: makeProgress(ctx.notify, ctx.progressToken),
      });
      if (!targets.length) return text('No active Codex agents. Use codex_status to list all agents.');
      return text(targets.map((a) => mgr.digest(a)).join('\n\n'));
    }
    case 'codex_run': {
      const a = mgr.spawn(args);
      const deadline = Date.now() + (args.timeout_sec ?? 1800) * 1000;
      const onEvent = makeProgress(ctx.notify, ctx.progressToken);
      while (!mgr.isSettled(a) && Date.now() < deadline) {
        await mgr.wait([a.id], { timeoutSec: Math.min(300, Math.max(1, (deadline - Date.now()) / 1000)), until: 'all', onEvent });
      }
      return text(mgr.digest(a, { from: 0, maxChars: 30000 }) + (a.finalMessage ? `\n\n=== FINAL ANSWER [${a.id}] ===\n${a.finalMessage}` : ''));
    }
    case 'codex_send': {
      const r = await mgr.send(args.agent_id, args.message, args);
      let out = `Sent to ${args.agent_id} (${r.mode}).`;
      if (args.wait_sec) {
        const [a] = await mgr.wait([args.agent_id], { timeoutSec: args.wait_sec, onEvent: makeProgress(ctx.notify, ctx.progressToken) });
        out += '\n\n' + mgr.digest(a);
      }
      return text(out);
    }
    case 'codex_respond': {
      mgr.respond(args.agent_id, args.request_id, args.decision, args);
      return text(`Answered ${args.request_id} on ${args.agent_id} with "${args.decision}". Call codex_wait to continue streaming.`);
    }
    case 'codex_interrupt':
      await mgr.interrupt(args.agent_id);
      return text(`Interrupt sent to ${args.agent_id}.`);
    case 'codex_status': {
      if (args.agent_id) {
        const a = mgr.get(args.agent_id);
        return text(mgr.digest(a, { advance: false, from: Math.max(0, a.events.length - 15) }) + `\nlog file: ${a.logFile}`);
      }
      const all = [...mgr.agents.values()];
      if (!all.length) return text('No Codex agents yet. Start one with codex_spawn or codex_run.');
      return text(`${all.every((a) => a.engine === 'codex') ? 'Codex' : 'Coding'} agents (${all.length}):\n` + all.map((a) => mgr.statusLine(a)).join('\n'));
    }
    case 'codex_transcript': {
      const a = mgr.get(args.agent_id);
      const from = args.last ? Math.max(0, a.events.length - args.last) : 0;
      return text(mgr.digest(a, { advance: false, from, maxChars: 60000 }));
    }
    case 'codex_close':
      await mgr.close(args.agent_id, args);
      return text(`Closed ${args.agent_id}.`);
    case 'codex_review': {
      const a = mgr.review(args);
      await mgr.wait([a.id], { timeoutSec: 3 });
      return text(`Started Codex review agent:\n${mgr.statusLine(a)}\n\nNext: codex_wait with agent_ids ["${a.id}"].`);
    }
    case 'codex_capabilities':
      return text(await mgr.capabilities(args.cwd));
    case 'codex_mcp_call': {
      const r = await mgr.mcpCall(args.server, args.tool, args.arguments || {});
      const content = convertContent(r.content);
      if (r.structuredContent) content.push({ type: 'text', text: `structuredContent: ${clip(JSON.stringify(r.structuredContent), 8000)}` });
      return { content, isError: !!r.isError };
    }
    case 'codex_computer_use': {
      if (args.target === 'windows') {
        const { result, approvals, started } = await mgr.windows.run(args.code, {
          allowApps: args.allow_apps || [],
          reset: !!args.reset,
          timeoutMs: args.timeout_sec ? args.timeout_sec * 1000 : undefined,
        });
        let content = convertContent(result.content);
        if (cuaDocShown.windows) content = content.filter((c) => !(c.type === 'text' && c.text.startsWith('## Computer Use')));
        cuaDocShown.windows = true;
        if (started && (started.started || started.uploaded?.length)) {
          content.unshift({ type: 'text', text: `Windows relay ${started.started ? `started (pid ${started.relay?.pid}, session ${started.relay?.session})` : 'already running'}${started.uploaded?.length ? `; uploaded ${started.uploaded.join(', ')}` : ''}.` });
        }
        content.push(...windowsApprovalNotes(approvals));
        if (!content.length) content = [{ type: 'text', text: '(ok, no output)' }];
        return { content, isError: !!result.isError };
      }
      if (args.reset) await mgr.mcpCall('cua_repl', 'js_reset', {});
      const r = await mgr.mcpCall('cua_repl', 'js', { code: args.code });
      let content = convertContent(r.content);
      const notApproved = content.find((c) => c.type === 'text' && /was not approved to use/i.test(c.text));
      if (notApproved) {
        content.push({ type: 'text', text: 'Hint: Codex only grants per-app Computer Use access inside an agent turn. Ask the user, then run the UI task through a Codex agent with computer_use:true (e.g. the codex-computer-use sub-agent); its "Allow Computer Use to use …?" prompt will appear as ⏳ NEEDS INPUT for codex_respond. Direct calls work for inventory (cua.listApps/listBrowsers/getState) and for apps the user has set to "always allow" in Codex.' });
      }
      // The first call prints a long API doc; keep it once, then strip it from later results.
      if (cuaDocShown.mac) content = content.filter((c) => !(c.type === 'text' && c.text.startsWith('## Computer Use')));
      cuaDocShown.mac = true;
      if (!content.length) content = [{ type: 'text', text: '(ok, no output)' }];
      return { content, isError: !!r.isError };
    }
    case 'codex_windows_cu': {
      const action = args.action;
      if (!['status', 'start', 'stop'].includes(action)) throw new Error('action must be status, start or stop');
      const r = await mgr.windows[action]();
      return text(`Windows Computer Use ${action}:\n${JSON.stringify(r, null, 2)}`);
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// ---------------- MCP stdio transport ----------------

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (method === undefined) return; // response to something we never send
  try {
    switch (method) {
      case 'initialize':
        return write({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'codex-bridge', version: '0.3.0' },
            instructions: 'Bridge to Codex, Google Antigravity and ZCode coding CLIs. RULE: launch every Codex/Antigravity/ZCode task through the matching native Agent sub-agent: codex-bridge:codex-worker / codex-bridge:antigravity-worker / codex-bridge:zcode-worker (Codex GUI: codex-computer-use; Codex review: codex-reviewer). Parallel work = several matching Agent calls in one message. Write each Agent description as the short task, then ｜ and the engine + model + optional effort, e.g. task｜Codex gpt-6.1-sol·low, task｜Antigravity gemini-3.8-flash-high, task｜ZCode 默认模型. The sonnet badge is the relay only. Do not call codex_spawn, codex_run, codex_send or codex_review from the main conversation. Workers use codex_spawn(engine) + codex_wait. All lifecycle tools accept every engine ID. Running steering, approval relay, MCP, Computer Use and review are Codex-only. Computer Use can also target the configured Windows PC (codex-computer-use with computer_use_target "windows", or codex_computer_use target "windows"). Antigravity/ZCode resume idle agents with codex_send, kill process trees on interrupt, and share the parallel queue. codex_capabilities lists available engines, models and Codex tools.',
          },
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return write({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const ctx = { notify, progressToken: params._meta?.progressToken };
        try {
          const result = await callTool(params.name, params.arguments || {}, ctx);
          return write({ jsonrpc: '2.0', id, result });
        } catch (e) {
          return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
        }
      }
      default:
        if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg);
});
process.stdin.on('end', () => { mgr.shutdown(); process.exit(0); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { mgr.shutdown(); process.exit(0); });
