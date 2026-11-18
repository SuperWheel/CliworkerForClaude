// Per-turn process engines. Codex keeps its existing app-server implementation.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clip, describeEngineTool } from './format.mjs';
import { zcodeRuntime, zcodeAccounts, selectZcodeModel } from './zcode.mjs';

const exec = promisify(execFile);
export const ENGINES = ['codex', 'antigravity', 'zcode'];
const home = path.join(os.homedir(), '.codex-bridge');

function link(target, dest) {
  try { if (fs.readlinkSync(dest) === target) return; } catch {}
  // Only replace bridge-owned symlinks; preserve unexpected regular files.
  try { if (!fs.lstatSync(dest).isSymbolicLink()) throw new Error(`Refusing to replace non-symlink ${dest}`); fs.unlinkSync(dest); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.symlinkSync(target, dest);
}

export function zcodeEntry({ runtime = false } = {}) {
  const app = path.resolve(process.env.ZCODE_APP || '/Applications/ZCode.app');
  const entry = path.resolve(process.env.ZCODE_ENTRY || path.join(app, 'Contents/Resources/glm/zcode.cjs'));
  const candidates = [path.join(path.dirname(entry), 'provider/zcode-builtin.json'), path.resolve(path.dirname(entry), '../config/provider/zcode-builtin.json'), path.join(app, 'Contents/Resources/config/provider/zcode-builtin.json')];
  const provider = candidates.find((p) => fs.existsSync(p));
  if (!fs.existsSync(entry) || !provider) throw new Error(`ZCode entry/provider not found: ${entry}; set ZCODE_ENTRY or ZCODE_APP`);
  const shim = path.join(home, 'zcode-shim');
  fs.mkdirSync(path.join(shim, 'provider'), { recursive: true });
  link(entry, path.join(shim, 'zcode.cjs'));
  link(provider, path.join(shim, 'provider/zcode-builtin.json'));
  const cli = path.join(shim, 'zcode.cjs');
  return runtime ? zcodeRuntime(cli, provider, app, home) : cli;
}

export function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
}

async function executable(bin) {
  if (bin.includes('/')) { fs.accessSync(bin, fs.constants.X_OK); return path.resolve(bin); }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  throw new Error(`${bin} not found on PATH`);
}

export async function engineCapabilities() {
  const results = await Promise.all(ENGINES.map(async (engine) => {
    try {
      const cli = engine === 'zcode' ? zcodeEntry() : await executable(engine === 'codex' ? process.env.CODEX_BIN || 'codex' : process.env.AGY_BIN || 'agy');
      const bin = engine === 'zcode' ? process.execPath : cli;
      const prefix = engine === 'zcode' ? [cli] : [];
      const { stdout } = await exec(bin, [...prefix, '--version'], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
      let line = `- ${engine}: AVAILABLE · ${cli} · version ${stdout.trim()}`;
      if (engine === 'zcode') line += ` · source ${fs.readlinkSync(cli)} · live events: app-server (desktop account host; cached individual plans)`;
      if (engine === 'antigravity') {
        try {
          const m = await exec(bin, ['models'], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
          line += `\n  models:\n${m.stdout.trim().split('\n').map((l) => `    ${l}`).join('\n')}`;
        } catch (e) { line += `\n  models: unavailable (${clip(e.message, 200)})`; }
      }
      return line;
    } catch (e) { return `- ${engine}: UNAVAILABLE · ${clip(e.message, 250)}`; }
  }));
  return `\nengines:\n${results.join('\n')}`;
}

// Hooks are deliberately small so AgentManager owns all statuses, logs and queueing.
export function startProcessTurn(a, prompt, { push, status, child: suppliedChild } = {}) {
  const readonly = a.sandbox === 'read-only';
  const mode = readonly ? 'plan' : a.sandbox === 'danger-full-access' ? 'yolo' : 'edit';
  const protocol = a.engine === 'zcode' && (!!a.model || !suppliedChild);
  const runtime = !suppliedChild && a.engine === 'zcode' ? zcodeEntry({ runtime: true }) : null;
  const accounts = runtime && protocol ? zcodeAccounts(runtime) : null;
  // A supplied child lets offline tests replay the exact stdout/RPC path.
  const args = suppliedChild ? [] : a.engine === 'antigravity'
    ? ['-p', prompt, '--output-format', 'stream-json', '--mode', readonly ? 'plan' : 'accept-edits', ...(!readonly ? ['--dangerously-skip-permissions'] : []), ...(a.model ? ['--model', a.model] : []), ...(a.effort ? ['--effort', a.effort] : []), ...(a.threadId ? ['--conversation', a.threadId] : [])]
    : [runtime.entry, ...(protocol ? ['app-server', '--stdio', '--surface', 'desktop'] : ['-p', prompt, '--output-format', 'stream-json', '--mode', mode, ...(a.threadId ? ['--resume', a.threadId] : [])]), '--cwd', a.cwd];
  const child = suppliedChild || spawn(a.engine === 'antigravity' ? process.env.AGY_BIN || 'agy' : process.execPath, args, { cwd: a.cwd, ...(runtime ? { env: runtime.env } : {}), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  a.child = child;
  let stderr = '', resultSeen = false, terminalError = null, interrupted = false;
  const steps = new Map(), texts = new Map(), seen = new Set(), requests = new Map(), calls = new Map();
  let next = 0;
  const line = (kind, text) => push(kind, text);
  // Hold the latest message: the last one before the result is the final answer
  // (as Codex marks it), so it is drawn once, not as a message and again as final.
  let pending = null;
  const drawnMessages = new Set();
  const textOf = (value) => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((v) => textOf(v?.text ?? v?.content)).filter(Boolean).join('\n');
    return value && typeof value === 'object' ? textOf(value.text ?? value.response ?? value.content) : '';
  };
  const flush = () => { if (pending) { line('message', `💬 ${a.engine}:\n    ${clip(pending, 6000).replace(/\n/g, '\n    ')}`); drawnMessages.add(pending.trim()); pending = null; } };
  const message = (text) => { if (!text?.trim() || resultSeen || pending === text) return; flush(); a.lastAgentMessage = text; pending = text; };
  const tool = (name, params, info) => { const d = describeEngineTool(a.engine, name, params, info); if (d && !resultSeen) { flush(); line(d.kind, d.text); } };
  const fail = (message) => { terminalError = message; line('error', `⚠ ${message}`); };
  const final = (text, usage) => {
    if (resultSeen) return;
    // The result is authoritative; a pending commentary or partial delta must
    // never replace it. A stream without text_end can still supply the answer.
    const response = textOf(text);
    const partial = [...texts.values()].at(-1) || [...steps.values()].findLast((step) => !step.completed && step.text)?.text;
    const answer = (response.trim() ? response : '') || partial || pending || a.lastAgentMessage || '';
    if (pending && pending.trim() !== answer.trim()) flush();
    if (!answer.trim() && !terminalError) fail(`${a.engine} returned a result without an answer`);
    resultSeen = true;
    a.finalMessage = answer;
    pending = null;
    if (usage) a.usage = { total: { totalTokens: usage.totalTokens ?? usage.total_tokens ?? 0 }, raw: usage };
    if (answer && !drawnMessages.has(answer.trim())) line('final', `💬 ${a.engine} (final):\n    ${clip(answer, 6000).replace(/\n/g, '\n    ')}`);
    if (!terminalError) status('finishing');
  };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`${method} timed out`)); }, 60000);
    requests.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const zEvent = (e) => {
    if (e.eventId && seen.has(e.eventId)) return;
    if (e.eventId) seen.add(e.eventId);
    if (e.sessionId) a.threadId = e.sessionId;
    if (e.turnId) a.currentTurnId = e.turnId;
    const p = e.payload || {};
    if (e.type === 'model.streaming') {
      const key = p.assistantMessageId || 'response';
      if (p.kind === 'text_delta') texts.set(key, (texts.get(key) || '') + (p.delta || ''));
      if (['text_end', 'finish'].includes(p.kind) && texts.get(key)) { message(texts.get(key)); texts.delete(key); }
      if (p.kind === 'tool_call' && p.toolCallId) {
        const c = calls.get(p.toolCallId) || {};
        calls.set(p.toolCallId, { ...c, name: p.toolName || c.name, input: p.input ?? c.input ?? {} });
      }
      if (p.kind === 'error') fail(p.error?.message || p.message || JSON.stringify(p));
    } else if (e.type === 'tool.updated') {
      if (p.kind === 'batch') return;
      const c = calls.get(p.toolCallId) || { name: p.toolName || 'tool', input: {} };
      if (p.toolName) c.name = p.toolName;
      if (p.input) c.input = p.input;
      if (p.toolCallId) calls.set(p.toolCallId, c);
      if (p.kind === 'started' && !c.started && !c.completed) { c.started = true; tool(c.name, c.input, { phase: 'started' }); }
      if (p.kind === 'result' && !c.completed) {
        c.completed = true;
        const r = p.result || {};
        const command = r.perf?.detail?.command;
        const exitCode = command?.exitCode ?? r.exitCode;
        const ok = r.success !== false && !r.error && !r.isError && !command?.timedOut && !['failed', 'error', 'cancelled', 'canceled', 'timed_out'].includes(r.status || command?.status);
        const error = r.error ? (typeof r.error === 'string' ? r.error : r.error.message || JSON.stringify(r.error)) : '';
        const output = error ? [textOf(r.content), error].filter(Boolean).join('\n') : r.content ?? '';
        tool(c.name, c.input, { phase: 'completed', ok, output, exitCode, durationMs: p.duration ?? r.perf?.totalMs });
      }
    } else if (e.type === 'permission.resolved') {
      flush();
      line('approval', `↩ permission ${clip(JSON.stringify(p), 800)}`);
    } else if (e.type === 'turn.failed') {
      fail(p.error?.message || p.message || JSON.stringify(p));
      final(p.response, p.usage);
      if (protocol) child.stdin.end();
    } else if (e.type === 'turn.completed') {
      if (p.resultType && !['success', 'completed'].includes(p.resultType)) fail(`turn result: ${p.resultType}`);
      final(p.response, p.usage);
      // A protocol process is per turn too: close its stdin once the turn settles.
      if (protocol) child.stdin.end();
    } else if (e.type === 'result') {
      if (e.projection?.status === 'failed') fail('ZCode projection failed');
      final(e.response, e.usage);
    }
  };
  const onJSON = (e) => {
    if (interrupted) return;
    if (a.engine === 'zcode') {
      if (protocol) {
        if (e.method === 'session/requestRuntimePreferences') {
          child.stdin.write(JSON.stringify({ id: e.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false } }) + '\n');
        } else if (e.method === 'interaction/requestProviderRuntimeHeaders' && accounts) {
          // Credentials travel only over the native process's private stdin.
          // Re-read settings/credentials to honor account changes between turns
          // and requests; never put auth material into the event log/digest.
          let result;
          try { result = zcodeAccounts(runtime).requestAuth(e.params); }
          catch (error) { result = { headersApplied: false, errorMessage: error.message }; }
          child.stdin.write(JSON.stringify({ id: e.id, result }) + '\n');
        } else if (e.method && e.id != null) {
          // Headless protocol cannot delegate interactive permission/UI questions.
          child.stdin.write(JSON.stringify({ id: e.id, error: { code: -32601, message: 'Headless bridge cannot answer interactive requests' } }) + '\n');
          line('approval', `🚫 headless request declined: ${e.method}`);
        } else if (e.id != null && requests.has(e.id)) {
          const r = requests.get(e.id); requests.delete(e.id); clearTimeout(r.timer);
          if (e.error) r.reject(new Error(e.error.message)); else r.resolve(e.result);
        } else if (e.method === 'session/event') zEvent(e.params);
      } else zEvent(e);
      return;
    }
    const p = e.step_update;
    if (e.event === 'init') { a.threadId = e.conversation_id; a.model = e.init?.model || a.model; }
    if (e.event === 'step_update' && p) {
      if (p.conversation_id) a.threadId = p.conversation_id;
      const key = p.step_index;
      const step = steps.get(key) || {};
      steps.set(key, step);
      if (p.step_type === 'agent_response') {
        // text_delta is incremental; accept text/response/content snapshots
        // defensively, without appending them to already collected deltas.
        const snapshot = textOf(p.text ?? p.response ?? p.content ?? p.agent_response);
        if (!step.completed) step.text = snapshot || (step.text || '') + (p.text_delta || '');
        if (p.state === 'DONE' && !step.completed) { step.completed = true; message(step.text); }
        if (p.state === 'ERROR' && !step.failed) { step.failed = true; message(step.text); fail(p.error?.message || p.error || p.error_message || `Antigravity response step ${key} failed`); }
      } else if (p.tool_name || p.tool_info || p.step_type === 'tool') {
        step.name = p.tool_name || p.tool_info?.name || step.name || 'tool';
        step.params = p.tool_info?.parameters ?? step.params ?? {};
        if (p.state === 'ACTIVE' && !step.started && !step.completed) {
          step.started = true;
          tool(step.name, step.params, { phase: 'started' });
        } else if (['DONE', 'ERROR'].includes(p.state) && !step.completed) {
          step.completed = true;
          const error = p.error?.message || p.error || p.error_message || p.tool_info?.error?.message || p.tool_info?.error;
          const raw = String(p.tool_info?.output || error || '');
          const code = raw.match(/Command exited with code (-?\d+)/);
          const output = raw.includes('Command output:') ? raw.split('Command output:').slice(1).join('Command output:').replace(/\r/g, '').trim() : raw;
          const exitCode = code ? Number(code[1]) : undefined;
          tool(step.name, step.params, { phase: 'completed', ok: p.state === 'DONE' && !error && (exitCode == null || exitCode === 0), output, exitCode, durationMs: p.duration_seconds != null ? p.duration_seconds * 1000 : undefined });
        }
      } else if (p.state === 'ERROR' && !step.failed) { step.failed = true; fail(p.error?.message || p.error || p.error_message || `Antigravity step ${key} failed`); }
    }
    if (e.event === 'result' && !resultSeen) {
      const r = e.result || {};
      a.threadId = r.conversation_id || a.threadId;
      if (r.status !== 'SUCCESS') fail(r.error?.message || r.error || `Antigravity returned ${r.status}`);
      final(r.response, r.usage);
    }
    if (e.event === 'error') fail(e.error?.message || e.error || JSON.stringify(e));
  };
  readline.createInterface({ input: child.stdout }).on('line', (s) => {
    try { onJSON(JSON.parse(s)); } catch (e) { fail(`invalid ${a.engine} event: ${clip(e.message, 200)}`); }
  });
  child.stderr.on('data', (s) => { stderr = (stderr + s.toString()).slice(-12000); });
  child.stdin.on('error', () => {});
  child.on('error', (e) => { terminalError = e.message; });
  child.on('close', (code, signal) => {
    for (const r of requests.values()) { clearTimeout(r.timer); r.reject(new Error('process exited')); } requests.clear();
    if (a.child === child) a.child = null;
    if (interrupted || a.status === 'closed') return;
    // Preserve partial assistant output even if the CLI dies before its result.
    if (!resultSeen) { for (const text of texts.values()) message(text); for (const step of steps.values()) if (!step.completed) message(step.text); flush(); }
    line('turn_end', `■ turn ${a.turnCount} ${code === 0 && resultSeen && !terminalError ? 'completed' : 'failed'} (exit ${code ?? signal})`);
    if (terminalError || code !== 0 || !resultSeen) status('failed', terminalError || `${a.engine} exited ${code ?? signal}${stderr ? ': ' + clip(stderr, 1500) : ''}${!resultSeen ? ' (no final result)' : ''}`);
    else status('idle');
  });
  // Do not release the process's queue slot until the process actually exits.
  const stop = () => {
    interrupted = true;
    killTree(child);
    const forced = new Promise((resolve) => setTimeout(() => { killTree(child, 'SIGKILL'); resolve(); }, 1500));
    const closed = new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', resolve); });
    return Promise.all([forced, closed]);
  };
  a.stopProcess = stop;
  if (!protocol) child.stdin.end();
  else (async () => {
    if (accounts && Object.keys(accounts.snapshot.providers).length) await rpc('provider/updateAccountConfig', accounts.snapshot);
    let snapshot;
    const workspace = { workspaceKey: a.cwd, workspacePath: a.cwd };
    if (a.threadId) snapshot = await rpc('session/resume', { sessionId: a.threadId, workspace });
    else snapshot = await rpc('session/create', { workspace, titleGenerationEnabled: false });
    a.threadId = snapshot.session.sessionId;
    const hit = selectZcodeModel(a.model, snapshot.settings?.model, accounts?.snapshot.states);
    if (hit) await rpc('session/setModel', { sessionId: a.threadId, model: { ...hit.ref, ...(hit.reasoning?.defaultLevel ? { options: { reasoningLevel: hit.reasoning.defaultLevel } } : {}) }, persistAsWorkspaceLastUsed: false });
    await rpc('session/setMode', { sessionId: a.threadId, mode });
    await rpc('session/subscribe', { sessionId: a.threadId, deliveryKind: 'desktop-continuous' });
    await rpc('session/send', { sessionId: a.threadId, content: prompt });
  })().catch((e) => { if (!interrupted) { fail(e.message); child.stdin.end(); killTree(child); } });
  return child;
}
