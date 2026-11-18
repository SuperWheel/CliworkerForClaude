// Windows Computer Use relay for codex-bridge. Runs inside the user's interactive
// Windows session and exposes the Desktop-generated cua_repl MCP server (stdio) to
// authenticated loopback clients. Each connection gets a fresh cua_repl process;
// a dropped connection ends that process and nothing is replayed.
//
// The relay also hosts the Computer Use native pipe (see cu-pipe-host.mjs) and
// points every cua_repl process at it, as Codex Desktop does, so the helper runs
// outside node_repl's sandbox with the user's environment.
//
// The first line of a connection is {"auth": token} (or {"auth": token, "op": "stop"}).
// The log records only connection events, JSON-RPC methods/ids and byte sizes,
// never message contents, tokens or manifest values.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { defaultPipePath, startPipeHost } from './cu-pipe-host.mjs';

const { values: opt } = parseArgs({
  options: {
    port: { type: 'string' },
    'token-file': { type: 'string' },
    'manifest-file': { type: 'string' },
    server: { type: 'string', default: 'cua_repl' },
    surfaces: { type: 'string', default: 'computer' },
    log: { type: 'string' },
    'ready-file': { type: 'string' },
    'idle-exit-sec': { type: 'string', default: '1800' },
    'stop-grace-ms': { type: 'string', default: '3000' },
    'max-clients': { type: 'string', default: '4' },
    'pipe-path': { type: 'string' },
  },
});
for (const k of ['port', 'token-file', 'manifest-file', 'log', 'ready-file']) {
  if (!opt[k]) throw new Error(`--${k} is required`);
}

const log = (event, fields = {}) =>
  appendFileSync(opt.log, JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');
const digest = (s) => createHash('sha256').update(s).digest();
const tokenDigest = digest(readFileSync(opt['token-file'], 'utf8').trim());
const readManifest = () => JSON.parse(readFileSync(opt['manifest-file'], 'utf8').replace(/^﻿/, ''));

function loadServer() {
  const server = readManifest().mcpServers?.[opt.server];
  if (!server?.command || !existsSync(server.command)) throw new Error(`${opt.server} in --manifest-file is not launchable`);
  return server;
}

// Log JSON-RPC shape (method/id/size) of newline-delimited traffic without contents.
function tap(direction) {
  let pending = '';
  return (chunk) => {
    pending += chunk.toString('utf8');
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        log('rpc', { direction, method: m.method, id: m.id, error: m.error ? m.error.code : undefined, bytes: line.length });
      } catch {
        log('rpc-unparsed', { direction, bytes: line.length });
      }
    }
  };
}

const clients = new Set();
let idleTimer = null;
let pipeHost = null;
let stopping = false;
async function shutdown(event, fields = {}) {
  if (stopping) return;
  stopping = true;
  clearTimeout(idleTimer);
  log(event, fields);
  for (const c of clients) { c.child?.kill(); c.socket.destroy(); }
  const timer = setTimeout(() => process.exit(0), Number(opt['stop-grace-ms']));
  try { await pipeHost?.dispose(); } catch (e) { log('pipe-dispose-failed', { message: e.message }); }
  clearTimeout(timer);
  process.exit(0);
}
const armIdle = () => {
  clearTimeout(idleTimer);
  if (clients.size || stopping) return;
  idleTimer = setTimeout(() => shutdown('idle-exit', { idleExitSec: Number(opt['idle-exit-sec']) }), Number(opt['idle-exit-sec']) * 1000);
};

function refuse(socket, status) {
  log('refused', { status });
  socket.end(JSON.stringify({ cuRelay: status }) + '\n');
}

function serve(client, firstBytes) {
  const { socket } = client;
  let server;
  try {
    server = loadServer();
  } catch (e) {
    log('manifest-error', { message: e.message });
    clients.delete(client);
    refuse(socket, 'manifest-error');
    armIdle();
    return;
  }
  const env = { ...process.env, ...(server.env ?? {}), CUA_REPL_ENABLED_SURFACES: opt.surfaces };
  env.SKY_CUA_NATIVE_PIPE = '1';
  env.SKY_CUA_NATIVE_PIPE_DIRECTORY = pipeHost.pipePath;
  const child = spawn(server.command, server.args ?? [], {
    env,
    cwd: server.cwd ?? undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  client.child = child;
  log('child-start', { pid: child.pid, clients: clients.size, surfaces: env.CUA_REPL_ENABLED_SURFACES });
  socket.write(JSON.stringify({ cuRelay: 'ready', childPid: child.pid }) + '\n');

  const toChild = tap('client->server');
  const toClient = tap('server->client');
  if (firstBytes.length) { toChild(firstBytes); child.stdin.write(firstBytes); }
  socket.on('data', toChild);
  child.stdout.on('data', toClient);
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  let stderrBytes = 0;
  child.stderr.on('data', (d) => { stderrBytes += d.length; });

  let stopTimer = null;
  socket.on('close', () => {
    log('client-close', { childPid: child.pid });
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      stopTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          log('child-kill', { pid: child.pid });
          child.kill();
        }
      }, Number(opt['stop-grace-ms']));
    }
  });
  child.stdin.on('error', (e) => log('child-stdin-error', { code: e.code }));
  child.on('error', (e) => log('child-error', { code: e.code, message: e.message }));
  child.on('exit', (code, signal) => {
    clearTimeout(stopTimer);
    log('child-exit', { pid: child.pid, code, signal, stderrBytes });
    socket.end();
    clients.delete(client);
    armIdle();
  });
}

const relay = net.createServer((socket) => {
  socket.setNoDelay(true);
  if (stopping) return refuse(socket, 'stopping');
  if (clients.size >= Number(opt['max-clients'])) return refuse(socket, 'busy');
  const client = { socket, child: null };
  clients.add(client);
  clearTimeout(idleTimer);
  let head = Buffer.alloc(0);
  const fail = (status) => { clearTimeout(authTimer); socket.off('data', onHead); clients.delete(client); refuse(socket, status); armIdle(); };
  const authTimer = setTimeout(() => fail('auth-timeout'), 5000);
  const onHead = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const nl = head.indexOf(10);
    if (nl < 0) {
      if (head.length > 1024) fail('auth-failed');
      return;
    }
    let first = {};
    let ok = false;
    try {
      first = JSON.parse(head.subarray(0, nl).toString('utf8'));
      ok = timingSafeEqual(digest(String(first.auth ?? '')), tokenDigest);
    } catch {}
    if (!ok) return fail('auth-failed');
    clearTimeout(authTimer);
    socket.off('data', onHead);
    if (first.op === 'stop') {
      clients.delete(client);
      socket.end(JSON.stringify({ cuRelay: 'stopping', pid: process.pid }) + '\n', () => shutdown('stop-requested'));
      return;
    }
    serve(client, head.subarray(nl + 1));
  };
  socket.on('data', onHead);
  socket.on('error', (e) => log('socket-error', { code: e.code }));
  socket.on('close', () => {
    if (clients.has(client) && !client.child) { clearTimeout(authTimer); clients.delete(client); armIdle(); }
  });
});

// The pipe host serves every cua_repl process for the relay's lifetime, like
// Desktop's; its helper starts on first use and stops when the last client leaves.
const manifest = readManifest();
const hostSpec = manifest.cuRelay?.pipeHost;
const serverEnv = manifest.mcpServers?.[opt.server]?.env ?? {};
if (!hostSpec?.helperPath || !hostSpec?.transportModulePath) throw new Error('--manifest-file has no cuRelay.pipeHost paths');
pipeHost = await startPipeHost({
  pipePath: opt['pipe-path'] ?? defaultPipePath(),
  helperPath: hostSpec.helperPath,
  transportModulePath: hostSpec.transportModulePath,
  helperEnv: Object.fromEntries(['CODEX_HOME', 'CODEX_CLI_PATH'].filter((k) => serverEnv[k]).map((k) => [k, serverEnv[k]])),
  log,
});

relay.on('error', (e) => { log('listen-error', { code: e.code }); process.exit(1); });
relay.listen(Number(opt.port), '127.0.0.1', () => {
  const ready = { pid: process.pid, port: Number(opt.port), host: '127.0.0.1', startedUtc: new Date().toISOString(), node: process.version };
  writeFileSync(opt['ready-file'], JSON.stringify(ready));
  log('listening', ready);
  armIdle();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown('signal', { sig }));
