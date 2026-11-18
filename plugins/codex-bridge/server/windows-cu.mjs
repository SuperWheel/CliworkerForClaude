// Windows Computer Use over SSH: drives Codex Computer Use on a Windows PC from this Mac.
// The kit in ../windows-cu/ runs on Windows: a relay in the logged-on user's desktop
// session hosts cua_repl (Codex Desktop's Computer Use MCP server) and its native pipe.
// This module uploads the kit when it changed, starts/stops the relay over SSH and
// speaks MCP to cua_repl through `ssh … node connect.mjs`.
//
// App approvals ("Allow Codex to use <App>?") are answered here: accepted for the
// session only when the caller named that exact app in allow_apps, declined otherwise.
// No approval or turn metadata is injected. Nothing here reads or prints credentials;
// the relay token never leaves Windows.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const KIT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'windows-cu');
export const KIT_FILES = ['relay.mjs', 'cu-pipe-host.mjs', 'connect.mjs', 'derive-manifest.mjs', 'start-relay.ps1', 'manage.ps1'];
export const CONFIG_PATH = process.env.CODEX_BRIDGE_WINDOWS_CU_CONFIG || path.join(os.homedir(), '.codex-bridge', 'windows-cu.json');
export const MCP_SERVER_NAME = 'cua_windows';
// Remote paths go into cmd.exe or PowerShell command lines: no spaces or metacharacters.
const SAFE_REMOTE_PATH = /^[A-Za-z]:\/[\w.\-/]*$/;
const SAFE_REMOTE_EXE = /^(?:[\w.\-]+|[A-Za-z]:\/[\w.\-/]+)$/;
const APPROVAL_RE = /^Allow Codex to use (.+)\?$/;
const SESSION_IDLE_MS = Number(process.env.CODEX_BRIDGE_WINDOWS_CU_IDLE_SEC || 600) * 1000;

const expandHome = (p) => (typeof p === 'string' && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function loadConfig(file = CONFIG_PATH) {
  if (!fs.existsSync(file)) throw new Error(`Windows Computer Use is not configured: create ${file} (see the codex-bridge README, "Windows Computer Use")`);
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!c.host) throw new Error(`${file}: "host" is required`);
  const cfg = {
    host: String(c.host),
    user: c.user ? String(c.user) : null,
    port: c.port ? Number(c.port) : null,
    identity: expandHome(c.identity) || null,
    knownHosts: expandHome(c.knownHosts) || null,
    remoteDir: c.remoteDir ? String(c.remoteDir).replace(/\\/g, '/').replace(/\/+$/, '') : null,
    remoteNode: c.remoteNode ? String(c.remoteNode).replace(/\\/g, '/') : 'node',
    relayPort: Number(c.relayPort || 47614),
    idleExitSec: Number(c.idleExitSec || 1800),
  };
  if (!/^[\w.\-]+$/.test(cfg.host) || (cfg.user && !/^[\w.\-]+$/.test(cfg.user))) throw new Error(`${file}: host and user may only contain letters, digits, ".", "_" and "-"`);
  if (cfg.remoteDir && !SAFE_REMOTE_PATH.test(cfg.remoteDir)) throw new Error(`${file}: remoteDir must be an absolute Windows path without spaces, e.g. C:/cu-relay`);
  if (!SAFE_REMOTE_EXE.test(cfg.remoteNode)) throw new Error(`${file}: remoteNode must be "node" or an absolute path without spaces`);
  if (!Number.isInteger(cfg.relayPort) || cfg.relayPort < 1024 || cfg.relayPort > 65535) throw new Error(`${file}: relayPort must be 1024-65535`);
  if (!Number.isInteger(cfg.idleExitSec) || cfg.idleExitSec < 60) throw new Error(`${file}: idleExitSec must be at least 60`);
  return cfg;
}

// With identity + knownHosts the connection ignores ~/.ssh/config and pins the host
// key; otherwise the user's own ssh config decides. Never prompts (BatchMode).
function sshOptions(cfg, portFlag) {
  const opts = [];
  if (cfg.knownHosts) opts.push('-F', '/dev/null', '-o', `UserKnownHostsFile=${cfg.knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes');
  if (cfg.identity) opts.push('-i', cfg.identity, '-o', 'IdentitiesOnly=yes');
  opts.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15');
  if (cfg.port) opts.push(portFlag, String(cfg.port));
  return opts;
}
const target = (cfg) => (cfg.user ? `${cfg.user}@${cfg.host}` : cfg.host);
export const sshArgs = (cfg, remoteCommand) => [...sshOptions(cfg, '-p'), '-T', target(cfg), remoteCommand];
export const connectCommand = (cfg, dir) => `${cfg.remoteNode} ${dir}/connect.mjs ${cfg.relayPort} ${dir}/relay-token`;

function encodedPowerShell(script) {
  const header = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';";
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(header + script, 'utf16le').toString('base64')}`;
}

function run(cmd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function lastJson(r, what) {
  const line = r.stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-400) || 'no output'}`);
  return JSON.parse(line);
}

// Answer an "Allow Codex to use <App>?" elicitation. Session scope only, never "always".
export function approvalDecision(params, allowApps = []) {
  const message = String(params?.message ?? '');
  const app = APPROVAL_RE.exec(message)?.[1] ?? null;
  const accept = app !== null && allowApps.includes(app);
  const offered = params?._meta?.persist ?? params?.meta?.persist;
  const persist = accept && Array.isArray(offered) && offered.includes('session') ? 'session' : null;
  const result = accept ? { action: 'accept', content: {}, ...(persist ? { _meta: { persist } } : {}) } : { action: 'decline' };
  return { app, message, accept, persist, result };
}

// One MCP connection to cua_repl on Windows (newline-delimited JSON-RPC over ssh stdio).
export class CuaSession {
  constructor(command, args, { log = () => {} } = {}) {
    this.log = log;
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.allowApps = [];
    this.approvals = [];
    this.closed = false;
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.child.stdin.on('error', () => {});
    this.exited = new Promise((resolve) => this.child.on('close', (code, signal) => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Windows Computer Use connection ended (${code ?? signal}): ${this.stderrTail() || 'no details'}`)); }
      this.pending.clear();
      resolve({ code, signal });
    }));
    this.child.on('error', (e) => this.log(`windows-cu ssh error: ${e.message}`));
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.#onLine(line));
  }

  stderrTail() {
    return this.stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
  }

  #send(msg) {
    if (!this.closed) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'elicitation/create' && msg.id !== undefined) {
      const d = approvalDecision(msg.params, this.allowApps);
      this.approvals.push({ app: d.app, message: d.message, accepted: d.accept, persist: d.persist });
      this.log(`windows-cu approval ${d.accept ? 'accepted' : 'declined'}${d.app ? ` for ${d.app}` : ''}`);
      return this.#send({ id: msg.id, result: d.result });
    }
    if (msg.method === 'ping' && msg.id !== undefined) return this.#send({ id: msg.id, result: {} });
    if (msg.id !== undefined) this.#send({ id: msg.id, error: { code: -32601, message: `codex-bridge does not support ${msg.method}` } });
  }

  request(method, params, timeoutMs = 180_000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Windows Computer Use connection is closed'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ id, method, params });
    });
  }

  async initialize() {
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { elicitation: {} },
      clientInfo: { name: 'codex-bridge', version: '0.3.0' },
    }, 60_000);
    this.#send({ method: 'notifications/initialized' });
    const tools = await this.request('tools/list', {}, 60_000);
    if (!(tools.tools ?? []).some((t) => t.name === 'js')) throw new Error('Windows cua_repl did not offer the js tool');
    return init;
  }

  // Run JavaScript; approvals arriving during this call use its allowApps.
  async js(code, { allowApps = [], timeoutMs } = {}) {
    this.allowApps = allowApps;
    this.approvals = [];
    try {
      const result = await this.request('tools/call', { name: 'js', arguments: { code } }, timeoutMs);
      return { result, approvals: this.approvals };
    } finally {
      this.allowApps = [];
    }
  }

  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5000);
    await this.exited;
    clearTimeout(timer);
  }
}

export class WindowsComputerUse {
  constructor({ log = () => {}, configPath = CONFIG_PATH } = {}) {
    this.log = log;
    this.configPath = configPath;
    this.cfg = null;
    this.dir = null;
    this.checked = false;
    this.session = null;
    this.idleTimer = null;
    this.chain = Promise.resolve();
  }

  configured() {
    return fs.existsSync(this.configPath);
  }

  config() {
    return (this.cfg ??= loadConfig(this.configPath));
  }

  #serial(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  async #ssh(remoteCommand, timeoutMs) {
    return run('ssh', sshArgs(this.config(), remoteCommand), { timeoutMs });
  }

  // Resolves the remote kit directory and the hashes of what is installed there.
  async #inspect() {
    const cfg = this.config();
    const dirExpr = cfg.remoteDir ? `'${cfg.remoteDir}'` : "(Join-Path $env:LOCALAPPDATA 'codex-bridge\\windows-cu')";
    const script = `$d=${dirExpr};New-Item -ItemType Directory -Force -Path $d|Out-Null;$h=@{};Get-ChildItem -LiteralPath $d -File|Where-Object{$_.Extension -in '.mjs','.ps1'}|ForEach-Object{$h[$_.Name]=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()};@{dir=$d.Replace('\\','/');hashes=$h}|ConvertTo-Json -Compress`;
    const info = lastJson(await this.#ssh(encodedPowerShell(script), 60_000), 'inspecting the Windows kit directory');
    if (!SAFE_REMOTE_PATH.test(info.dir)) throw new Error(`Windows kit directory "${info.dir}" contains spaces or special characters; set "remoteDir" in ${this.configPath} (e.g. "C:/cu-relay")`);
    this.dir = info.dir;
    return info;
  }

  async #sync() {
    const info = await this.#inspect();
    const stale = KIT_FILES.filter((f) => info.hashes?.[f] !== sha256(path.join(KIT_DIR, f)));
    if (stale.length) {
      const cfg = this.config();
      const r = await run('scp', [...sshOptions(cfg, '-P'), '-q', ...stale.map((f) => path.join(KIT_DIR, f)), `${target(cfg)}:${info.dir}/`], { timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`uploading the Windows kit failed: ${r.stderr.trim().slice(-400)}`);
    }
    return { dir: info.dir, uploaded: stale };
  }

  async #manage(action) {
    const cfg = this.config();
    if (!this.dir) await this.#inspect();
    const cmd = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${this.dir}/manage.ps1 -Action ${action} -Port ${cfg.relayPort} -IdleExitSec ${cfg.idleExitSec}`;
    return lastJson(await this.#ssh(cmd, 90_000), `windows relay ${action}`);
  }

  status() {
    return this.#serial(async () => {
      const info = await this.#inspect();
      const kitCurrent = KIT_FILES.every((f) => info.hashes?.[f] === sha256(path.join(KIT_DIR, f)));
      if (!info.hashes?.['manage.ps1']) return { ok: true, installed: false, running: false, kitCurrent };
      return { ...(await this.#manage('status')), installed: true, kitCurrent, connected: !!this.session && !this.session.closed };
    });
  }

  // Uploads the kit if it changed and starts the relay if it is not running.
  start() {
    return this.#serial(() => this.#start());
  }

  async #start() {
    const sync = await this.#sync();
    // A relay still running the previous kit is replaced; connect.mjs and manage.ps1 run per call.
    if (sync.uploaded.some((f) => f !== 'connect.mjs' && f !== 'manage.ps1')) {
      await this.#closeSession();
      const s = await this.#manage('stop');
      if (!s.ok) throw new Error(`could not stop the outdated Windows relay: ${JSON.stringify(s)}`);
    }
    const r = await this.#manage('start');
    if (!r.ok) throw new Error(`Windows relay did not start (${r.stage ?? 'unknown'}): ${typeof r.error === 'string' ? r.error : JSON.stringify(r.error ?? r.result)}`);
    return { ...r, uploaded: sync.uploaded, dir: sync.dir };
  }

  stop() {
    return this.#serial(async () => {
      await this.#closeSession();
      return this.#manage('stop');
    });
  }

  async #closeSession() {
    clearTimeout(this.idleTimer);
    const s = this.session;
    this.session = null;
    if (s) await s.close();
  }

  async #connect() {
    const s = new CuaSession('ssh', sshArgs(this.config(), connectCommand(this.config(), this.dir)), { log: this.log });
    try {
      await s.initialize();
      return s;
    } catch (e) {
      await s.close().catch(() => {});
      throw e;
    }
  }

  // The first use per bridge process syncs the kit and starts the relay if needed;
  // later reconnects start it again only when connecting fails (idle exit, reboot).
  async #ensureSession() {
    if (this.session && !this.session.closed) return { started: null };
    let started = null;
    if (!this.checked) {
      started = await this.#start();
      this.checked = true;
    }
    try {
      this.session = await this.#connect();
    } catch (first) {
      if (started) throw first;
      this.log(`windows-cu connect failed, starting relay: ${first.message}`);
      started = await this.#start();
      this.session = await this.#connect();
    }
    return { started };
  }

  #armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.#serial(() => this.#closeSession()), SESSION_IDLE_MS);
    this.idleTimer.unref?.();
  }

  // Runs JavaScript in the Windows cua_repl. Returns the MCP result plus the
  // approvals answered during the call and whether the relay had to be started.
  run(code, { allowApps = [], reset = false, timeoutMs } = {}) {
    return this.#serial(async () => {
      const { started } = await this.#ensureSession();
      try {
        if (reset) await this.session.request('tools/call', { name: 'js_reset', arguments: {} });
        const { result, approvals } = await this.session.js(code, { allowApps, timeoutMs });
        return { result, approvals, started };
      } catch (e) {
        if (this.session?.closed) this.session = null;
        throw e;
      } finally {
        this.#armIdle();
      }
    });
  }

  // Codex config overrides that give a Codex agent the Windows cua_repl as MCP server
  // `cua_windows`; starts the relay first so the server connects on thread start.
  async agentConfig() {
    const { dir } = await this.start();
    const cfg = this.config();
    return {
      [`mcp_servers.${MCP_SERVER_NAME}.command`]: 'ssh',
      [`mcp_servers.${MCP_SERVER_NAME}.args`]: sshArgs(cfg, connectCommand(cfg, dir)),
      [`mcp_servers.${MCP_SERVER_NAME}.startup_timeout_sec`]: 60,
      [`mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec`]: 300,
    };
  }

  close() {
    clearTimeout(this.idleTimer);
    this.session?.child.kill();
    this.session = null;
  }
}
