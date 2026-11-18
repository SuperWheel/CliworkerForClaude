// Computer Use native-pipe host for the Windows relay, mirroring Codex Desktop's
// own host (main bundle `Gae`/`Zae`/`Jae`/`Xae`): the cua_repl kernel stays in
// node_repl's sandbox and reaches this pipe through `nodeRepl.nativePipe`, while
// the helper runs here, outside the sandbox, with the user's environment.
//
// The helper keeps its own login and policy checks. App approvals go back to the
// kernel as `requestComputerUseApproval` and are answered by its MCP elicitation;
// this host never answers one itself.
//
// Logs carry only events, method names, durations and error messages.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEADER = 4;
const MAX_FRAME = 8 * 1024 * 1024;
const APPROVAL_PREFIX = 'computer-use-approval:';
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export const defaultPipePath = () =>
  process.platform === 'win32' ? `\\\\.\\pipe\\codex-computer-use-${randomUUID()}` : null;

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.alloc(HEADER + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, HEADER);
  return frame;
}

// Returns { messages, rest }, or null when a frame is larger than allowed.
export function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= HEADER) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_FRAME) return null;
    if (buffer.length - offset < HEADER + length) break;
    messages.push(buffer.subarray(offset + HEADER, offset + HEADER + length).toString('utf8'));
    offset += HEADER + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

const turnKey = (meta) =>
  meta && typeof meta.session_id === 'string' && meta.session_id.trim() && typeof meta.turn_id === 'string' && meta.turn_id.trim()
    ? `${meta.session_id}\0${meta.turn_id}`
    : null;

export async function startPipeHost({ pipePath, helperPath, transportModulePath, helperEnv, log = () => {} }) {
  if (!pipePath) throw new Error('pipe path is required');
  if (!existsSync(helperPath)) throw new Error('Computer Use helper is missing');
  if (!existsSync(transportModulePath)) throw new Error('Computer Use helper transport module is missing');
  const { WindowsHelperTransport } = await import(pathToFileURL(transportModulePath).href);

  let transport = null;
  let busy = false;
  const activeTurnBySocket = new Map();
  const approvals = new Map();
  const sockets = new Set();

  const getTransport = () =>
    (transport ??= new WindowsHelperTransport({
      helperArgs: ['--parent-pid', String(process.pid)],
      helperCommand: helperPath,
      helperEnv,
    }));
  const closeTransport = async () => {
    const current = transport;
    if (!current) return;
    transport = null;
    await current.close();
    log('pipe-helper-closed');
  };
  const rejectApprovals = (error) => {
    for (const pending of approvals.values()) { clearTimeout(pending.timer); pending.reject(error); }
    approvals.clear();
  };

  const requestApproval = (send, params) => new Promise((resolve, reject) => {
    const id = `${APPROVAL_PREFIX}${randomUUID()}`;
    const timer = setTimeout(() => {
      approvals.delete(id);
      log('pipe-approval', { result: 'timeout' });
      reject(new Error('Computer Use app approval timed out'));
    }, APPROVAL_TIMEOUT_MS);
    timer.unref();
    approvals.set(id, { resolve, reject, timer });
    log('pipe-approval-requested');
    send({ id, jsonrpc: '2.0', method: 'requestComputerUseApproval', params });
  });

  const handleApprovalResponse = (message) => {
    if (typeof message.id !== 'string' || !message.id.startsWith(APPROVAL_PREFIX)) return false;
    const pending = approvals.get(message.id);
    if (!pending) return true;
    approvals.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      log('pipe-approval', { result: 'error', message: message.error.message });
      pending.reject(new Error(message.error.message));
    } else {
      log('pipe-approval', { result: message.result?.action ?? 'unknown', persist: message.result?._meta?.persist });
      pending.resolve(message.result);
    }
    return true;
  };

  const isCloseOrEndTurn = (message) =>
    message.method === 'close' || (message.method === 'request' && message.params?.method === 'end_turn');

  async function handle(message, send, socket) {
    const id = message.id;
    if (id == null || typeof message.method !== 'string') return;
    let method = message.method;
    const started = Date.now();
    try {
      if (message.method === 'ping') return send({ id, jsonrpc: '2.0', result: 'pong' });
      if (message.method === 'close') {
        activeTurnBySocket.delete(socket);
        await closeTransport();
        return send({ id, jsonrpc: '2.0', result: null });
      }
      if (message.method !== 'request') throw new Error('Unsupported Computer Use native pipe method');
      const request = message.params ?? {};
      if (typeof request.method !== 'string' || !request.method.trim()) throw new Error('Computer Use request is missing a method');
      method = request.method;
      const turn = turnKey(request.codexTurnMetadata);
      if (method === 'end_turn' && (turn == null || ![...activeTurnBySocket.values()].includes(turn))) {
        return send({ id, jsonrpc: '2.0', result: null });
      }
      if (method !== 'end_turn' && turn != null) activeTurnBySocket.set(socket, turn);
      const result = await getTransport().request(method, request.params, {
        codexTurnMetadata: request.codexTurnMetadata,
        createElicitation: (params) => requestApproval(send, params),
      });
      if (method === 'end_turn') for (const [s, t] of activeTurnBySocket) if (t === turn) activeTurnBySocket.delete(s);
      log('pipe-request', { method, ms: Date.now() - started, ok: true });
      send({ id, jsonrpc: '2.0', result });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      log('pipe-request', { method, ms: Date.now() - started, ok: false, error: text.slice(0, 500) });
      send({ error: { code: -32000, message: text }, id, jsonrpc: '2.0' });
    }
  }

  if (process.platform !== 'win32' && existsSync(pipePath)) unlinkSync(pipePath);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    log('pipe-connect', { sockets: sockets.size });
    let pending = Buffer.alloc(0);
    const send = (message) => { if (!socket.destroyed) socket.write(encodeFrame(message)); };
    socket.on('data', (chunk) => {
      const decoded = decodeFrames(Buffer.concat([pending, chunk]));
      if (!decoded) { log('pipe-frame-too-large'); socket.destroy(); return; }
      pending = decoded.rest;
      for (const text of decoded.messages) {
        let message;
        try { message = JSON.parse(text); } catch { continue; }
        if (handleApprovalResponse(message)) continue;
        const bypass = isCloseOrEndTurn(message);
        if (busy && !bypass) {
          if (message.id != null) send({ error: { code: -32000, message: 'Computer Use helper already has an active request' }, id: message.id, jsonrpc: '2.0' });
          continue;
        }
        if (!bypass) busy = true;
        handle(message, send, socket).finally(() => { if (!bypass) busy = false; });
      }
    });
    socket.on('error', (e) => log('pipe-socket-error', { code: e.code }));
    socket.on('close', () => {
      sockets.delete(socket);
      activeTurnBySocket.delete(socket);
      log('pipe-disconnect', { sockets: sockets.size });
      if (sockets.size === 0) {
        rejectApprovals(new Error('Computer Use native pipe client disconnected'));
        closeTransport().catch((e) => log('pipe-helper-close-failed', { message: e.message }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => { server.off('error', reject); resolve(); });
  });
  log('pipe-listening');

  return {
    pipePath,
    async dispose() {
      rejectApprovals(new Error('Computer Use native pipe is shutting down'));
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      try { await closeTransport(); } finally {
        await new Promise((resolve) => server.close(() => resolve()));
        if (process.platform !== 'win32' && existsSync(pipePath)) unlinkSync(pipePath);
        log('pipe-closed');
      }
    },
  };
}
