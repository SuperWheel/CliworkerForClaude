// SIMULATED (模拟) cua_repl for offline relay tests: each js call goes to the native
// pipe named in SKY_CUA_NATIVE_PIPE_DIRECTORY, and pipe approvals become MCP
// elicitations, as node_repl does. Code containing "getApp" asks for app state.
// Like node_repl on Windows, a call carrying Codex's sandbox state with a non-Windows
// sandboxCwd is rejected; results list the _meta keys that arrived.
import net from 'node:net';
import readline from 'node:readline';
import { encodeFrame, decodeFrames } from '../../../windows-cu/cu-pipe-host.mjs';

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let nextId = 1000;
const waiting = new Map();
const elicit = (params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, (r) => resolve(r.result));
  send({ id, method: 'elicitation/create', params });
});

let pipe = null;
function connectPipe(pipePath) {
  const sock = net.connect(pipePath);
  let buf = Buffer.alloc(0);
  let next = 1;
  const pending = new Map();
  const frame = (m) => sock.write(encodeFrame(m));
  sock.on('data', async (d) => {
    const r = decodeFrames(Buffer.concat([buf, d]));
    buf = r.rest;
    for (const text of r.messages) {
      const m = JSON.parse(text);
      if (m.method === 'requestComputerUseApproval') { frame({ id: m.id, jsonrpc: '2.0', result: await elicit(m.params) }); continue; }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    }
  });
  const ready = new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    frame({ id, jsonrpc: '2.0', method: 'request', params: { method, params } });
  });
  return { ready, request, end: () => sock.end() };
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); return; }
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-cua-simulated', version: '0' }, capabilities: { tools: {} } } });
  if (msg.method === 'tools/list') return send({ id: msg.id, result: { tools: [{ name: 'js', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } }, { name: 'js_reset', inputSchema: { type: 'object' } }] } });
  if (msg.method === 'tools/call') {
    const sandbox = msg.params._meta?.['codex/sandbox-state-meta'];
    if (sandbox && !/^file:\/\/\/[A-Za-z]:\//.test(sandbox.sandboxCwd ?? '')) {
      return send({ id: msg.id, error: { code: -32602, message: `js: codex/sandbox-state-meta: sandboxCwd is not a local file URI: ${sandbox.sandboxCwd}` } });
    }
    const meta = ` meta=${JSON.stringify(Object.keys(msg.params._meta ?? {}))}`;
    try {
      if (msg.params.name === 'js_reset') return send({ id: msg.id, result: { content: [{ type: 'text', text: 'SIMULATED reset' }] } });
      if (process.env.SKY_CUA_NATIVE_PIPE !== '1') throw new Error('SKY_CUA_NATIVE_PIPE not set');
      pipe ??= connectPipe(process.env.SKY_CUA_NATIVE_PIPE_DIRECTORY);
      await pipe.ready;
      const code = msg.params.arguments.code;
      const r = code.includes('getApp') ? await pipe.request('get_app_state', {}) : await pipe.request('list_windows', {});
      send({ id: msg.id, result: { content: [{ type: 'text', text: 'SIMULATED ' + JSON.stringify(r) + meta }] } });
    } catch (e) {
      send({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: e.message }] } });
    }
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'unknown' } });
});
process.stdin.on('end', () => { pipe?.end(); process.exit(0); });
