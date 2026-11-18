// JSON-RPC client for `codex app-server` (stdio transport).
// One app-server process hosts many threads, so all Codex sub-agents share it.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

const NOISY_NOTIFICATIONS = [
  'item/commandExecution/outputDelta',
  'item/reasoning/textDelta',
  'item/fileChange/outputDelta',
  'rawResponseItem/completed',
  'rawResponse/completed',
  'account/rateLimits/updated',
  'thread/realtime/outputAudio/delta',
  'fuzzyFileSearch/sessionUpdated',
];

export class AppServerClient extends EventEmitter {
  constructor({ bin = 'codex', args = [], log = () => {} } = {}) {
    super();
    this.bin = bin;
    this.args = args;
    this.log = log;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.info = null;
    this.stderrTail = [];
  }

  get alive() {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  async ensureStarted() {
    if (this.alive && this.ready) return this.ready;
    this.ready = this.#start();
    try {
      return await this.ready;
    } catch (e) {
      this.ready = null;
      throw e;
    }
  }

  async #start() {
    const proc = spawn(this.bin, ['app-server', ...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.proc = proc;
    proc.on('error', (err) => this.log(`app-server spawn error: ${err.message}`));
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      this.stderrTail.push(s);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });
    proc.on('exit', (code, signal) => {
      this.log(`app-server exited code=${code} signal=${signal}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`codex app-server exited (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
      if (this.proc === proc) {
        this.proc = null;
        this.ready = null;
      }
      this.emit('exit', { code, signal });
    });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.#onLine(line));

    this.info = await this.request('initialize', {
      clientInfo: { name: 'claude-codex-bridge', title: 'Claude Code Codex Bridge', version: '0.1.2' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: NOISY_NOTIFICATIONS,
      },
    }, 60_000);
    this.notify('initialized');
    return this.info;
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`unparseable app-server line: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.rpc = msg.error;
        p.reject(err);
      } else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      this.emit('serverRequest', { id: msg.id, method: msg.method, params: msg.params ?? {} });
      return;
    }
    if (msg.method) this.emit('notification', msg.method, msg.params ?? {});
  }

  #write(obj) {
    if (!this.alive) throw new Error('codex app-server is not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params = {}, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method, params) {
    this.#write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  respond(id, result) {
    this.#write({ jsonrpc: '2.0', id, result });
  }

  respondError(id, code, message) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}
