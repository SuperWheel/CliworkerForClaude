// Shared agent pool: Codex app-server threads and per-turn Antigravity/ZCode processes.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ENGINES, startProcessTurn, killTree, engineCapabilities } from './engines.mjs';
import { AppServerClient } from './app-server-client.mjs';
import { WindowsComputerUse, MCP_SERVER_NAME as WINDOWS_CU_SERVER } from './windows-cu.mjs';
import { describeItem, describeRequest, clip, fmtTime, fmtDuration } from './format.mjs';

// 'finishing' = final answer delivered while post-turn hooks still run; safe to read results.
const SETTLED = new Set(['finishing', 'idle', 'needs_input', 'failed', 'interrupted', 'closed']);
const LOG_DIR = process.env.CODEX_BRIDGE_LOG_DIR || path.join(os.homedir(), '.codex-bridge', 'logs');

const BRIDGE_INSTRUCTIONS = `You are running as a sub-agent dispatched by Claude Code (the orchestrator), not talking to a human directly.
- Work autonomously to finish the assigned task end-to-end; do not stop to ask unless genuinely blocked.
- Your final message is relayed verbatim to the orchestrator. Make it a self-contained report: what you did, files changed, commands/tests run and their results, and anything left open or risky.
- If you need a decision you cannot make, say exactly what you need in the final message.`;

// Sent to Codex agents only, not Antigravity or ZCode (set CODEX_BRIDGE_AUTONOMY=0 to leave it out).
const AUTONOMY_INSTRUCTIONS = `Avoid over-defensiveness and over-gating:
- The orchestrator has already scoped and authorized this task. Do not re-litigate it, hedge, or add disclaimers.
- Do routine engineering work without asking first: reading any file, running builds, tests, linters and the project's CLIs, editing files inside the workspace, installing the project's own dependencies, network access the task needs.
- Do not refuse or stop over hypothetical risks. Pick a sensible default, state the assumption in your final report, and keep going.
- Request an approval or sandbox escalation only when a command actually failed because of the sandbox, not pre-emptively.
- Still stop and report instead of acting when a step would delete data outside the workspace, push/force-push, touch credentials or secrets, send messages, spend money, or change system settings, unless the task explicitly authorizes that exact action.`;

const COMPUTER_USE_INSTRUCTIONS = `Computer Use is enabled for this task. Operate the user's Mac UI through the \`cua_repl\` MCP tool (JavaScript REPL; globals \`cua\` and \`nodeRepl\`).
- Bind an app: \`const app = await cua.getApp("Safari")\` (name, path or bundle id); it prints the accessibility (AX) tree with element indices.
- Act, then re-read state in the same call: \`await app.click(42); await app.typeText("hi"); await app.pressKey("Return"); await app.getAXState();\`
- Use \`app.getScreenshot()\` when the AX tree is insufficient; prefer element indices over coordinates.
- Browsers: \`cua.listBrowsers()\`, \`cua.createBrowserTab(browserId, url)\`, \`cua.getTab(...)\`.
- Follow the Computer Use confirmation policy: never delete data, send messages, submit forms, purchase, or change security settings unless the task explicitly authorizes that specific action; otherwise stop and describe what needs confirmation in your final message.
- Verify the requested end state is visibly present before finishing.`;

const WINDOWS_COMPUTER_USE_INSTRUCTIONS = `Computer Use is enabled for this task on the user's Windows PC, not this Mac. Operate Windows only through the \`${WINDOWS_CU_SERVER}\` MCP tool \`js\` (a persistent JavaScript REPL running on Windows; globals \`cua\` and \`nodeRepl\`). Do not use \`cua_repl\` or local shell commands for the Windows UI.
- Make \`await cua.getState()\` or \`await cua.getApp({ windowId })\` your first Computer Use call. Find windows with \`await cua.listWindows()\` (each has id, title and app, where app is a process path such as "process:C:\\…\\App.exe"; approvals name the app by its display name).
- \`const app = await cua.getApp({ windowId })\` binds one window and prints its accessibility tree; re-read it with \`await app.getAXState()\`.
- \`await app.getScreenshot()\` returns one screenshot, or several regions ({id, zIndex, width, height}) while a dialog or popup is open. Take a fresh screenshot right before clicking by coordinates, and with several regions pass the region: \`await app.click([x, y], { screenshotId: region.id })\`. Element-index clicks are unreliable while several regions are open.
- Type with \`await app.typeText("…")\` (Chinese and other Unicode text work); keys with \`await app.pressKey("ctrl+a")\`, \`"Delete"\`, \`"Return"\`.
- "Allow Codex to use <App>?" approvals are relayed to the orchestrator; wait for the answer.
- Follow the Computer Use confirmation policy: never delete data, send messages, submit forms, purchase, or change security settings unless the task explicitly authorizes that specific action; otherwise stop and describe what needs confirmation in your final message.
- Verify the requested end state is visibly present (screenshot or accessibility tree) before finishing.`;

const computerUseTarget = (o) => o.computer_use_target || (o.computer_use ? 'mac' : null);

function shortId() {
  return 'cx-' + crypto.randomBytes(3).toString('hex');
}

export class AgentManager extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.maxParallel = Number(process.env.CODEX_BRIDGE_MAX_PARALLEL || 8);
    this.defaults = {
      model: process.env.CODEX_BRIDGE_MODEL || null,
      effort: process.env.CODEX_BRIDGE_EFFORT || null,
      sandbox: process.env.CODEX_BRIDGE_SANDBOX || 'workspace-write',
      approvalPolicy: process.env.CODEX_BRIDGE_APPROVAL_POLICY || 'on-request',
      approvalMode: process.env.CODEX_BRIDGE_APPROVAL_MODE || 'ask',
    };
    const extraArgs = (process.env.CODEX_BRIDGE_APP_SERVER_ARGS || '').split(' ').filter(Boolean);
    this.client = new AppServerClient({ bin: process.env.CODEX_BIN || 'codex', args: extraArgs, log });
    this.windows = new WindowsComputerUse({ log });
    this.generation = 0;
    this.agents = new Map();
    this.byThread = new Map();
    this.queue = [];
    this.utilThread = null;
    this.skillCache = null;
    this.nextReq = 1;
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

    this.client.on('notification', (m, p) => this.#onNotification(m, p));
    this.client.on('serverRequest', (r) => this.#onServerRequest(r));
    this.client.on('exit', () => this.#onClientExit());
  }

  // ---------- lifecycle ----------

  async ensureClient() {
    const wasAlive = this.client.alive;
    await this.client.ensureStarted();
    if (!wasAlive) {
      this.generation++;
      this.utilThread = null;
    }
  }

  #onClientExit() {
    if (this.shuttingDown) return;
    const tailErr = this.client.stderrTail.join('').replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /error|fatal|panic/i.test(l)).slice(-2).join(' | ');
    for (const a of this.agents.values()) {
      if (a.engine === 'codex' && ['running', 'starting', 'needs_input', 'finishing'].includes(a.status)) {
        a.pending.clear();
        this.#setStatus(a, 'failed', `codex app-server exited${tailErr ? `: ${clip(tailErr, 300)}` : ''}`);
      }
    }
    this.#pump();
  }

  shutdown() {
    this.shuttingDown = true;
    this.client.stop();
    this.windows.close();
    for (const a of this.agents.values()) if (a.child) killTree(a.child, 'SIGKILL');
  }

  // ---------- agent bookkeeping ----------

  #newAgent(o, kind) {
    const engine = o.engine || 'codex';
    if (!ENGINES.includes(engine)) throw new Error(`unknown engine ${engine}; choose ${ENGINES.join(', ')}`);
    const makeId = () => shortId().replace('cx-', { codex: 'cx-', antigravity: 'ag-', zcode: 'zc-' }[engine]);
    let id = makeId();
    while (this.agents.has(id)) id = makeId();
    const a = {
      id,
      engine,
      kind,
      name: o.name || clip((o.prompt || o.instructions || kind).split('\n')[0], 60),
      opts: o,
      status: 'queued',
      threadId: null,
      generation: 0,
      currentTurnId: null,
      turnCount: 0,
      createdAt: Date.now(),
      turnStartedAt: null,
      events: [],
      cursor: 0,
      pending: new Map(),
      lastAgentMessage: null,
      finalMessage: null,
      error: null,
      usage: null,
      lastPlan: '',
      logFile: path.join(LOG_DIR, `${id}.log`),
    };
    this.agents.set(id, a);
    return a;
  }

  get(id) {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent_id "${id}". Use codex_status to list agents.`);
    return a;
  }

  #push(a, kind, text) {
    const ev = { seq: a.events.length, ts: Date.now(), kind, text };
    a.events.push(ev);
    try { fs.appendFileSync(a.logFile, `[${fmtTime(ev.ts)}] ${text}\n`); } catch {}
    this.emit('event', a, ev);
    this.emit('change', a);
  }

  #setStatus(a, status, error) {
    a.status = status;
    if (error) {
      a.error = error;
      this.#push(a, 'error', `⚠ ${error}`);
    }
    this.emit('change', a);
    if (SETTLED.has(status) || status === 'queued') this.#pump();
  }

  #runningCount() {
    let n = 0;
    for (const a of this.agents.values()) if (a.status === 'running' || a.status === 'starting' || a.child) n++;
    return n;
  }

  #pump() {
    while (this.queue.length && this.#runningCount() < this.maxParallel) {
      const { agent, start } = this.queue.shift();
      if (agent.status !== 'queued') continue;
      agent.status = 'starting';
      start().catch((e) => this.#setStatus(agent, 'failed', e.message));
    }
  }

  #enqueue(agent, start) {
    this.queue.push({ agent, start });
    if (this.#runningCount() >= this.maxParallel) {
      this.#push(agent, 'info', `⏸ queued (max ${this.maxParallel} parallel ${agent.engine === 'codex' ? 'Codex' : 'coding'} agents; set CODEX_BRIDGE_MAX_PARALLEL to change)`);
    }
    this.#pump();
  }

  // ---------- input building ----------

  async #skills(cwd) {
    if (!this.skillCache || this.skillCache.cwd !== cwd || Date.now() - this.skillCache.at > 60_000) {
      const r = await this.client.request('skills/list', { cwds: [cwd] });
      this.skillCache = { cwd, at: Date.now(), list: (r.data || []).flatMap((d) => d.skills || []) };
    }
    return this.skillCache.list;
  }

  async #buildInput(a, text, { images = [], skills = [] } = {}) {
    const input = [];
    if (skills.length) {
      const all = await this.#skills(a.cwd);
      for (const s of skills) {
        const hit = all.find((k) => k.name === s) || all.find((k) => k.name.endsWith(`:${s}`) || k.name.includes(s));
        if (hit) input.push({ type: 'skill', name: hit.name, path: hit.path });
        else this.#push(a, 'info', `⚠ codex skill "${s}" not found; continuing without it`);
      }
    }
    for (const img of images) {
      if (/^(https?:|data:)/.test(img)) input.push({ type: 'image', url: img });
      else input.push({ type: 'localImage', path: path.resolve(a.cwd, img) });
    }
    input.push({ type: 'text', text, text_elements: [] });
    return input;
  }

  #developerInstructions(o, engine = 'codex') {
    const parts = [BRIDGE_INSTRUCTIONS];
    if (engine === 'codex' && process.env.CODEX_BRIDGE_AUTONOMY !== '0') parts.push(AUTONOMY_INSTRUCTIONS);
    const cu = computerUseTarget(o);
    if (cu === 'windows') parts.push(WINDOWS_COMPUTER_USE_INSTRUCTIONS);
    else if (cu) parts.push(COMPUTER_USE_INSTRUCTIONS);
    if (o.developer_instructions) parts.push(o.developer_instructions);
    return parts.join('\n\n');
  }

  #threadParams(a) {
    const o = a.opts;
    const p = {
      cwd: a.cwd,
      model: o.model || this.defaults.model,
      approvalPolicy: o.approval_policy || this.defaults.approvalPolicy,
      sandbox: o.sandbox || this.defaults.sandbox,
      developerInstructions: this.#developerInstructions(o),
    };
    if (o.config) p.config = o.config;
    if (o.ephemeral) p.ephemeral = true;
    return p;
  }

  async #openThread(a) {
    await this.ensureClient();
    const params = this.#threadParams(a);
    let r;
    if (a.threadId || a.opts.resume_thread_id) {
      const threadId = a.threadId || a.opts.resume_thread_id;
      r = await this.client.request('thread/resume', { threadId, ...params, excludeTurns: true });
    } else {
      r = await this.client.request('thread/start', params);
    }
    const t = r.thread;
    if (a.threadId) this.byThread.delete(a.threadId);
    a.threadId = t.id;
    a.generation = this.generation;
    a.model = r.model;
    a.sandbox = r.sandbox?.type;
    this.byThread.set(t.id, a);
    if (!a.opts.ephemeral && a.name) {
      this.client.request('thread/name/set', { threadId: t.id, name: `[claude] ${a.name}` }).catch(() => {});
    }
  }

  async #ensureThreadLoaded(a) {
    if (!a.threadId || a.generation !== this.generation || !this.client.alive) await this.#openThread(a);
  }

  async #startTurn(a, text, extra = {}) {
    await this.#ensureThreadLoaded(a);
    const o = a.opts;
    const params = {
      threadId: a.threadId,
      input: await this.#buildInput(a, text, extra),
      effort: extra.effort || o.effort || this.defaults.effort || undefined,
      summary: 'concise',
    };
    if (extra.model) params.model = extra.model;
    const schema = extra.output_schema || (a.turnCount === 0 ? o.output_schema : null);
    if (schema) params.outputSchema = schema;
    a.status = 'running';
    a.turnStartedAt = Date.now();
    a.turnCount++;
    a.finalMessage = null;
    this.#push(a, 'turn_start', `▶ turn ${a.turnCount} started${a.turnCount === 1 ? ` (model ${a.model ?? 'default'}, sandbox ${a.sandbox ?? '?'}, cwd ${a.cwd})` : ''}\n    ↳ ${clip(text, 400).replace(/\n/g, '\n      ')}`);
    const r = await this.client.request('turn/start', params);
    a.currentTurnId = r.turn?.id ?? a.currentTurnId;
  }

  #startProcess(a, text, extra = {}) {
    if (extra.model) a.model = extra.model;
    if (extra.effort) a.effort = extra.effort;
    a.status = 'running';
    a.turnStartedAt = Date.now();
    a.turnCount++;
    a.finalMessage = null;
    a.lastAgentMessage = null;
    a.error = null;
    a.usage = null;
    this.#push(a, 'turn_start', `▶ turn ${a.turnCount} started (engine ${a.engine}, model ${a.model || 'default'}, sandbox ${a.sandbox}, cwd ${a.cwd})\n    ↳ ${clip(text, 400)}`);
    startProcessTurn(a, `${this.#developerInstructions(a.opts, a.engine)}\n\nTask:\n${text}`, {
      push: (kind, message) => this.#push(a, kind, message),
      status: (state, error) => this.#setStatus(a, state, error),
    });
  }

  // ---------- public API ----------

  spawn(o) {
    if (!o.prompt) throw new Error('prompt is required');
    if (o.engine && o.engine !== 'codex') {
      const unsupported = ['images', 'skills', 'computer_use', 'computer_use_target', 'output_schema', 'config', 'ephemeral'].filter((k) => Array.isArray(o[k]) ? o[k].length : o[k]);
      if (unsupported.length) throw new Error(`${o.engine} does not support bridge options: ${unsupported.join(', ')} (Codex only)`);
    }
    const a = this.#newAgent(o, 'task');
    a.cwd = path.resolve(o.cwd || process.cwd());
    a.approvalMode = o.approval_mode || this.defaults.approvalMode;
    if (a.engine !== 'codex') {
      a.model = o.model || null;
      a.effort = o.effort || null;
      a.sandbox = o.sandbox || this.defaults.sandbox;
      a.threadId = o.resume_thread_id || null;
      this.#enqueue(a, async () => this.#startProcess(a, o.prompt));
      return a;
    }
    this.#enqueue(a, async () => {
      if (computerUseTarget(o) === 'windows') {
        this.#push(a, 'info', '🪟 starting the Windows Computer Use relay');
        a.opts.config = { ...(o.config || {}), ...(await this.windows.agentConfig()) };
      }
      await this.#openThread(a);
      await this.#startTurn(a, o.prompt, { images: o.images, skills: o.skills });
    });
    return a;
  }

  review(o) {
    const a = this.#newAgent({ ...o, name: o.name || `review: ${o.target || 'uncommitted'}` }, 'review');
    if (o.effort) a.opts.config = { ...(o.config || {}), model_reasoning_effort: o.effort };
    a.cwd = path.resolve(o.cwd || process.cwd());
    a.approvalMode = 'deny';
    a.opts.sandbox = a.opts.sandbox || 'read-only';
    a.opts.approval_policy = 'never';
    this.#enqueue(a, async () => {
      await this.#openThread(a);
      let target;
      switch (o.target || 'uncommitted') {
        case 'uncommitted': target = { type: 'uncommittedChanges' }; break;
        case 'base_branch': target = { type: 'baseBranch', branch: o.branch || 'main' }; break;
        case 'commit': target = { type: 'commit', sha: o.sha, title: null }; break;
        case 'custom': target = { type: 'custom', instructions: o.instructions || 'Review the current changes.' }; break;
        default: throw new Error(`unknown review target ${o.target}`);
      }
      a.status = 'running';
      a.turnStartedAt = Date.now();
      a.turnCount++;
      this.#push(a, 'turn_start', `▶ codex review started (${o.target || 'uncommitted'}) in ${a.cwd}`);
      const r = await this.client.request('review/start', { threadId: a.threadId, target, delivery: 'inline' });
      a.currentTurnId = r.turn?.id;
    });
    return a;
  }

  async send(id, message, { images, skills, mode = 'auto', effort, model, output_schema } = {}) {
    const a = this.get(id);
    if (a.status === 'closed') throw new Error(`${id} is closed`);
    if (a.engine !== 'codex') {
      if (a.child || ['running', 'starting', 'queued', 'finishing'].includes(a.status)) throw new Error(`${id} (${a.engine}) is still active; steering a running turn is not supported. Wait for IDLE or interrupt first.`);
      if (images?.length || skills?.length || output_schema) throw new Error(`${a.engine}: images, skills and output_schema are Codex-only options`);
      if (mode === 'steer') throw new Error(`${a.engine} does not support steering; use mode auto or new_turn on an idle agent`);
      a.status = 'queued';
      this.#enqueue(a, async () => this.#startProcess(a, message, { effort, model }));
      return { mode: 'new_turn' };
    }
    if (a.status === 'queued' || a.status === 'starting') throw new Error(`${id} has not started yet; wait first`);
    if (a.status === 'needs_input') throw new Error(`${id} is waiting on ${a.pending.size} request(s); answer them with codex_respond first`);
    if (a.status === 'finishing') {
      await this.#waitForStatus(a, (st) => st !== 'finishing', 180_000);
      if (a.status === 'finishing') await this.interrupt(id).then(() => this.#waitForStatus(a, (st) => st !== 'finishing', 15_000));
    }
    if (a.status === 'running' && mode !== 'new_turn') {
      await this.client.request('turn/steer', {
        threadId: a.threadId,
        expectedTurnId: a.currentTurnId,
        input: await this.#buildInput(a, message, { images, skills }),
      });
      this.#push(a, 'steer', `↪ orchestrator steered the running turn:\n    ${clip(message, 400)}`);
      return { mode: 'steer' };
    }
    if (a.status === 'running') throw new Error(`${id} is still running; use mode "steer" or interrupt it first`);
    if (computerUseTarget(a.opts) === 'windows') await this.windows.start();
    await this.#startTurn(a, message, { images, skills, effort, model, output_schema });
    return { mode: 'new_turn' };
  }

  async interrupt(id) {
    const a = this.get(id);
    if (a.status === 'queued') {
      this.#setStatus(a, 'interrupted', 'cancelled before start');
      return;
    }
    if (a.engine !== 'codex') {
      if (a.child) {
        const stopped = a.stopProcess();
        // Mark after the full process group has been sent its termination signal.
        this.#push(a, 'info', '⏹ interrupt requested');
        await stopped;
        this.#setStatus(a, 'interrupted');
      }
      return;
    }
    if (!a.currentTurnId || (this.isSettled(a) && a.status !== 'needs_input' && a.status !== 'finishing')) return;
    for (const req of [...a.pending.values()]) this.#answer(a, req, 'cancel');
    await this.client.request('turn/interrupt', { threadId: a.threadId, turnId: a.currentTurnId });
    this.#push(a, 'info', '⏹ interrupt requested');
  }

  async close(id, { archive = false } = {}) {
    const a = this.get(id);
    if (a.engine !== 'codex') {
      await this.interrupt(id);
      this.#setStatus(a, 'closed');
      this.#push(a, 'info', '■ closed (session retained by CLI)');
      return;
    }
    if (a.status === 'running' || a.status === 'needs_input' || a.status === 'finishing') {
      for (const req of a.pending.values()) this.#answer(a, req, 'cancel');
      await this.client.request('turn/interrupt', { threadId: a.threadId, turnId: a.currentTurnId }).catch(() => {});
    }
    if (a.status === 'queued') a.status = 'interrupted';
    if (a.threadId && this.client.alive) {
      await this.client.request(archive ? 'thread/archive' : 'thread/unsubscribe', { threadId: a.threadId }).catch(() => {});
    }
    this.#setStatus(a, 'closed');
    this.#push(a, 'info', `■ closed${archive ? ' and archived' : ''}`);
  }

  respond(id, requestId, decision, { answers, content, message } = {}) {
    const a = this.get(id);
    const req = a.pending.get(requestId);
    if (!req) throw new Error(`no pending request "${requestId}" on ${id}. Pending: ${[...a.pending.keys()].join(', ') || 'none'}`);
    this.#answer(a, req, decision, { answers, content, message });
  }

  // ---------- waiting / digests ----------

  #waitForStatus(a, pred, timeoutMs) {
    return new Promise((resolve) => {
      const check = (x) => { if (x === a && pred(a.status)) done(); };
      const done = () => { clearTimeout(t); this.off('change', check); resolve(); };
      const t = setTimeout(done, timeoutMs);
      this.on('change', check);
      check(a);
    });
  }

  isSettled(a) {
    return SETTLED.has(a.status);
  }

  wait(ids, { timeoutSec = 60, until = 'any', onEvent } = {}) {
    const targets = ids?.length
      ? ids.map((i) => this.get(i))
      : [...this.agents.values()].filter((a) => a.status !== 'closed' && (!this.isSettled(a) || a.cursor < a.events.length));
    if (!targets.length) return Promise.resolve([]);
    const done = () => {
      const allSettled = targets.every((a) => this.isSettled(a));
      if (until === 'all') return allSettled;
      return allSettled || targets.some((a) => this.isSettled(a) && a.cursor < a.events.length);
    };
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.off('change', onChange);
        this.off('event', evHandler);
        resolve(targets);
      };
      const onChange = () => { if (done()) finish(); };
      const evHandler = (a, ev) => { if (targets.includes(a) && onEvent) onEvent(a, ev); };
      const timer = setTimeout(finish, Math.max(1, Math.min(timeoutSec, 3600)) * 1000);
      this.on('change', onChange);
      this.on('event', evHandler);
      if (done()) finish();
    });
  }

  header(a) {
    const elapsed = a.turnStartedAt ? fmtDuration(Date.now() - a.turnStartedAt) : '-';
    const tok = a.usage?.total?.totalTokens ? ` · ${(a.usage.total.totalTokens / 1000).toFixed(1)}k tok` : '';
    const engine = a.engine !== 'codex' ? ` · ${a.engine} · model ${a.model || 'default'}${a.effort ? (a.engine === 'zcode' ? ` · effort ${a.effort} ignored (no CLI flag)` : ` · effort ${a.effort}`) : ''}` : '';
    return `### [${a.id}] ${a.name} — ${a.status.toUpperCase()} · ${a.kind} · turn ${a.turnCount} · ${elapsed}${tok}${engine}`;
  }

  digest(a, { maxChars = 16000, advance = true, from } = {}) {
    const start = from ?? a.cursor;
    let evs = a.events.slice(start);
    let lines = evs.map((e) => `[${fmtTime(e.ts)}] ${e.text}`);
    let omitted = 0;
    while (lines.join('\n').length > maxChars && lines.length > 1) {
      lines.shift();
      omitted++;
    }
    if (advance) a.cursor = a.events.length;
    const out = [this.header(a)];
    if (a.threadId) out.push(`thread: ${a.threadId}`);
    if (omitted) out.push(`…${omitted} earlier events omitted (codex_transcript for full log: ${a.logFile})`);
    out.push(lines.length ? lines.join('\n') : '(no new events)');
    if (a.pending.size) {
      out.push('⏳ NEEDS INPUT — answer with codex_respond:');
      for (const r of a.pending.values()) out.push(`  • request_id="${r.reqId}" (${r.kindLabel}): ${r.summary}`);
    }
    if (a.status === 'finishing') out.push(a.engine === 'codex' ? '→ final answer delivered (Codex is still running post-turn hooks). Results are ready to use.' : `→ final answer delivered (${a.engine} process is finishing). Results are ready to use.`);
    if (a.status === 'idle') out.push('→ turn finished. Continue with codex_send, or codex_close when done.');
    if (a.status === 'failed') out.push(`→ failed: ${a.error ?? 'unknown error'}. You may retry with codex_send.`);
    if (a.status === 'running') out.push('→ still running; call codex_wait again.');
    return out.join('\n');
  }

  statusLine(a) {
    const last = a.events.length ? a.events[a.events.length - 1].text.split('\n')[0] : '';
    const engine = a.engine !== 'codex' ? ` · ${a.engine} · model ${a.model || 'default'}` : '';
    return `- [${a.id}] ${a.status.padEnd(11)} ${a.kind.padEnd(6)} turn ${a.turnCount}  ${clip(a.name, 50)}${engine}  | ${clip(last, 90)}${a.pending.size ? `  (⏳ ${a.pending.size} pending)` : ''}${a.cursor < a.events.length ? `  (${a.events.length - a.cursor} unread)` : ''}`;
  }

  // ---------- notifications ----------

  #onNotification(method, p) {
    const a = p.threadId ? this.byThread.get(p.threadId) : null;
    if (!a) return;
    switch (method) {
      case 'turn/started':
        a.currentTurnId = p.turn?.id ?? a.currentTurnId;
        if (a.status !== 'needs_input') a.status = 'running';
        this.emit('change', a);
        break;
      case 'item/started':
      case 'item/completed': {
        const item = p.item;
        if (method === 'item/started' && a.status === 'finishing' && item?.type !== 'userMessage') a.status = 'running';
        if (method === 'item/completed' && item?.type === 'agentMessage' && item.text) a.lastAgentMessage = item.text;
        if (method === 'item/completed' && item?.type === 'exitedReviewMode') a.lastAgentMessage = item.review;
        const d = describeItem(item, method === 'item/started' ? 'started' : 'completed');
        if (d) this.#push(a, d.kind, d.text);
        const isFinal = (item?.type === 'agentMessage' && item.phase === 'final_answer') || item?.type === 'exitedReviewMode';
        if (method === 'item/completed' && isFinal && a.status === 'running') {
          a.finalMessage = item.text ?? item.review;
          this.#setStatus(a, 'finishing');
        }
        break;
      }
      case 'hook/started':
        if (p.run?.statusMessage && p.run.eventName !== 'preToolUse' && p.run.eventName !== 'postToolUse') {
          this.#push(a, 'hook', `⚙ codex hook ${p.run.eventName}: ${clip(p.run.statusMessage, 160)}`);
        }
        break;
      case 'hook/completed':
        if (Number(p.run?.durationMs ?? 0) > 3000) {
          this.#push(a, 'hook', `⚙ codex hook ${p.run.eventName} ${p.run.status} after ${fmtDuration(Number(p.run.durationMs))}`);
        }
        break;
      case 'turn/plan/updated': {
        const plan = (p.plan || []).map((s) => `    ${s.status === 'completed' ? '☑' : s.status === 'inProgress' || s.status === 'in_progress' ? '▣' : '☐'} ${s.step}`).join('\n');
        if (plan && plan !== a.lastPlan) {
          a.lastPlan = plan;
          this.#push(a, 'plan', `📋 plan${p.explanation ? ` — ${clip(p.explanation, 200)}` : ''}:\n${plan}`);
        }
        break;
      }
      case 'thread/tokenUsage/updated':
        a.usage = p.tokenUsage;
        break;
      case 'error':
        if (p.willRetry) this.#push(a, 'info', `↻ transient error, codex retrying: ${clip(p.error?.message, 300)}`);
        else this.#push(a, 'error', `⚠ ${clip(p.error?.message, 600)}`);
        break;
      case 'turn/completed': {
        const t = p.turn || {};
        // review/start reports a different turn id than the one that completes, so only skip duplicates.
        if (t.id && t.id === a.lastCompletedTurnId) break;
        a.lastCompletedTurnId = t.id;
        a.finalMessage = a.finalMessage || a.lastAgentMessage;
        for (const r of a.pending.values()) a.pending.delete(r.reqId);
        const map = { completed: 'idle', interrupted: 'interrupted', failed: 'failed' };
        const status = map[t.status] || 'idle';
        const dur = t.durationMs ? fmtDuration(t.durationMs) : a.turnStartedAt ? fmtDuration(Date.now() - a.turnStartedAt) : '';
        this.#push(a, 'turn_end', `■ turn ${a.turnCount} ${t.status ?? 'completed'}${dur ? ` in ${dur}` : ''}`);
        this.#setStatus(a, status, t.error?.message);
        break;
      }
      case 'serverRequest/resolved': {
        for (const r of a.pending.values()) {
          if (r.rpcId === p.requestId) {
            a.pending.delete(r.reqId);
            this.#push(a, 'info', `✓ request ${r.reqId} resolved elsewhere`);
          }
        }
        if (!a.pending.size && a.status === 'needs_input') this.#setStatus(a, 'running');
        break;
      }
      default:
        break;
    }
  }

  // ---------- server -> client requests (approvals, questions) ----------

  #onServerRequest({ id, method, params }) {
    const a = params.threadId ? this.byThread.get(params.threadId) : null;
    if (!a) {
      // Utility thread (direct MCP calls) or unknown: be conservative.
      if (method === 'mcpServer/elicitation/request' && params.threadId && params.threadId === this.utilThread) {
        this.client.respond(id, { action: 'accept', content: {}, _meta: null });
      } else this.#respondDefault(id, method, params, 'decline');
      return;
    }
    const kindLabel = {
      'item/commandExecution/requestApproval': 'command approval',
      'item/fileChange/requestApproval': 'file-change approval',
      'item/permissions/requestApproval': 'permission request',
      'mcpServer/elicitation/request': 'MCP elicitation',
      'item/tool/requestUserInput': 'question',
      execCommandApproval: 'command approval',
      applyPatchApproval: 'patch approval',
    }[method];
    if (!kindLabel) {
      this.#respondDefault(id, method, params, 'decline');
      return;
    }
    const req = { reqId: `r${this.nextReq++}`, rpcId: id, method, params, kindLabel, summary: describeRequest(method, params) };
    const mode = a.approvalMode;
    if (mode === 'auto' || mode === 'deny') {
      const decision = mode === 'auto' ? 'accept' : 'decline';
      this.#push(a, 'approval', `${mode === 'auto' ? '✅ auto-approved' : '🚫 auto-declined'} ${kindLabel}: ${req.summary}`);
      this.#answer(a, req, decision, { silent: true });
      return;
    }
    a.pending.set(req.reqId, req);
    this.#push(a, 'approval', `⏳ ${kindLabel} needed [${req.reqId}]: ${req.summary}`);
    this.#setStatus(a, 'needs_input');
  }

  #respondDefault(id, method, params, decision) {
    try {
      const r = this.#buildResponse(method, params, decision, {});
      if (r === undefined) this.client.respondError(id, -32601, `codex-bridge does not handle ${method}`);
      else this.client.respond(id, r);
    } catch (e) {
      this.log(`respondDefault failed: ${e.message}`);
    }
  }

  #buildResponse(method, params, decision, { answers, content, message }) {
    const accept = decision === 'accept' || decision === 'accept_for_session';
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision: { accept: 'accept', accept_for_session: 'acceptForSession', decline: 'decline', cancel: 'cancel' }[decision] || 'decline' };
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return {
          decision: decision === 'accept' ? 'approved'
            : decision === 'accept_for_session' ? 'approved_for_session'
            : decision === 'cancel' ? 'abort'
            : { denied: { rejection: message || 'declined by orchestrator' } },
        };
      case 'item/permissions/requestApproval': {
        const req = params.permissions || {};
        const granted = {};
        if (accept) {
          if (req.network) granted.network = req.network;
          if (req.fileSystem) granted.fileSystem = req.fileSystem;
        }
        return { permissions: granted, scope: decision === 'accept_for_session' ? 'session' : 'turn' };
      }
      case 'mcpServer/elicitation/request':
        if (accept && params.mode !== 'url') {
          const persist = params._meta?.persist;
          const meta = decision === 'accept_for_session' && Array.isArray(persist) && persist.includes('session') ? { persist: 'session' } : null;
          return { action: 'accept', content: content ?? {}, _meta: meta };
        }
        if (accept && params.mode === 'url') return { action: 'accept', content: null, _meta: null };
        return { action: decision === 'cancel' ? 'cancel' : 'decline', content: null, _meta: null };
      case 'item/tool/requestUserInput': {
        const out = {};
        for (const q of params.questions || []) {
          let v = answers?.[q.id];
          if (v == null) {
            if (accept && q.options?.length) v = q.options[0].label;
            else v = message || (accept ? 'Proceed using your best judgment.' : 'No answer available; proceed using your best judgment.');
          }
          out[q.id] = { answers: Array.isArray(v) ? v.map(String) : [String(v)] };
        }
        return { answers: out };
      }
      case 'item/tool/call':
        return { contentItems: [{ type: 'inputText', text: 'Dynamic tools are not provided by codex-bridge.' }], success: false };
      default:
        return undefined;
    }
  }

  #answer(a, req, decision, opts = {}) {
    const r = this.#buildResponse(req.method, req.params, decision, opts);
    this.client.respond(req.rpcId, r);
    a.pending.delete(req.reqId);
    if (!opts.silent) this.#push(a, 'approval', `↩ orchestrator answered ${req.reqId}: ${decision}${opts.answers ? ` ${clip(JSON.stringify(opts.answers), 200)}` : ''}`);
    if (!a.pending.size && a.status === 'needs_input') this.#setStatus(a, 'running');
  }

  // ---------- direct bridges: MCP tools, computer use, capabilities ----------

  async #utility() {
    await this.ensureClient();
    if (this.utilThread) return this.utilThread;
    const r = await this.client.request('thread/start', {
      cwd: process.cwd(),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      developerInstructions: 'Utility thread used by codex-bridge for direct MCP tool calls.',
    });
    this.utilThread = r.thread.id;
    return this.utilThread;
  }

  async mcpCall(server, tool, args = {}, { timeoutMs = 300_000 } = {}) {
    const threadId = await this.#utility();
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        return await this.client.request('mcpServer/tool/call', { threadId, server, tool, arguments: args }, timeoutMs);
      } catch (e) {
        const msg = e.message || '';
        if (Date.now() < deadline && /not (ready|found|running|started)|starting|unknown server|no such server/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw e;
      }
    }
  }

  async mcpServers() {
    await this.#utility();
    const r = await this.client.request('mcpServerStatus/list', {});
    return r.data || [];
  }

  async capabilities(cwd) {
    const out = [await engineCapabilities()];
    try { await this.ensureClient(); } catch (e) { return out.join('\n') + `\nCodex capabilities unavailable: ${e.message}`; }
    out.push(`codex app-server: ${this.client.info?.userAgent ?? '?'}`);
    out.push(`defaults: sandbox=${this.defaults.sandbox} approval_policy=${this.defaults.approvalPolicy} approval_mode=${this.defaults.approvalMode} max_parallel=${this.maxParallel}`);
    try {
      const m = await this.client.request('model/list', { limit: 50 });
      const models = (m.data || []).filter((x) => !x.hidden).map((x) => `${x.model}${x.supportedReasoningEfforts?.length ? ` [${x.supportedReasoningEfforts.map((e) => e.reasoningEffort ?? e).join('/')}]` : ''}`);
      out.push(`\nmodels: ${models.join(', ')}`);
    } catch (e) { out.push(`models: (error ${e.message})`); }
    try {
      const servers = await this.mcpServers();
      out.push('\nMCP servers available to codex (callable via codex_mcp_call):');
      for (const s of servers) {
        const tools = Object.keys(s.tools || {});
        out.push(`- ${s.name} [${s.runtimeStatus ?? s.authStatus ?? '?'}] ${tools.length ? `tools: ${clip(tools.join(', '), 400)}` : s.toolsError ? `error: ${clip(String(s.toolsError), 120)}` : '(no tools)'}`);
      }
      const cu = servers.find((s) => s.name === 'cua_repl' && Object.keys(s.tools || {}).length);
      out.push(`\ncomputer use: ${cu ? 'AVAILABLE via cua_repl (codex_computer_use tool, or computer_use:true on spawn)' : 'not detected (needs Codex Computer Use / ChatGPT desktop app setup)'}`);
    } catch (e) { out.push(`mcp: (error ${e.message})`); }
    if (!this.windows.configured()) out.push(`windows computer use: not configured (${this.windows.configPath}; see README "Windows Computer Use")`);
    else {
      try {
        const s = await this.windows.status();
        out.push(`windows computer use: configured; relay ${s.running ? `running (pid ${s.relay?.pid}, session ${s.relay?.session})` : 'stopped, starts on first use'}${s.installed && !s.kitCurrent ? '; kit update pending' : ''} (codex_computer_use target:"windows", or computer_use_target:"windows" on spawn)`);
      } catch (e) { out.push(`windows computer use: configured but unreachable (${clip(e.message, 200)})`); }
    }
    try {
      const skills = await this.#skills(path.resolve(cwd || process.cwd()));
      out.push(`\ncodex skills (attach with skills:[...] on spawn): ${skills.filter((s) => s.enabled !== false).map((s) => s.name).join(', ')}`);
    } catch (e) { out.push(`skills: (error ${e.message})`); }
    return out.join('\n');
  }
}
