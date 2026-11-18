// Offline regression for Windows Computer Use: native-pipe host, relay auth/limits/stop,
// approval policy, config validation and the Mac-side lifecycle (upload, start, reconnect,
// kit-change restart, agent MCP config). cua_repl, the helper, ssh and scp are SIMULATED
// (tests/fixtures/windows-cu); no Windows machine, model or network is used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPipeHost, encodeFrame, decodeFrames } from '../windows-cu/cu-pipe-host.mjs';
import { approvalDecision, loadConfig, sshArgs, CuaSession, WindowsComputerUse, KIT_FILES } from '../server/windows-cu.mjs';
import { AgentManager } from '../server/agent-manager.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'windows-cu');
const kit = path.join(here, '..', 'windows-cu');
const work = fs.mkdtempSync('/private/tmp/cbw-');
const transportLog = path.join(work, 'transport.log');
process.env.FAKE_TRANSPORT_LOG = transportLog;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const transportEvents = () => fs.readFileSync(transportLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const spawned = [];
let passed = 0;
const ok = (name) => { passed++; console.log(`ok - ${name}`); };

function pipeClient(pipePath, onApproval = async () => ({ action: 'decline' })) {
  const sock = net.connect(pipePath);
  let buf = Buffer.alloc(0), next = 1;
  const pending = new Map();
  const send = (m) => sock.write(encodeFrame(m));
  sock.on('data', async (d) => {
    const r = decodeFrames(Buffer.concat([buf, d]));
    buf = r.rest;
    for (const text of r.messages) {
      const m = JSON.parse(text);
      if (m.method === 'requestComputerUseApproval') { send({ id: m.id, jsonrpc: '2.0', result: await onApproval(m.params) }); continue; }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); send({ id, jsonrpc: '2.0', method, params }); });
  return {
    ready: new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); }),
    call,
    request: (method, params, codexTurnMetadata) => call('request', { method, params, codexTurnMetadata }),
    raw: (b) => sock.write(b),
    end: () => sock.end(),
    closed: new Promise((r) => sock.on('close', r)),
  };
}

try {
  // ---- native-pipe host (unix socket in place of the Windows named pipe) ----
  fs.writeFileSync(transportLog, '');
  const logs = [];
  const host = await startPipeHost({
    pipePath: path.join(work, 'unit.sock'),
    helperPath: path.join(fixtures, 'fake-transport.mjs'),
    transportModulePath: path.join(fixtures, 'fake-transport.mjs'),
    helperEnv: { CODEX_HOME: 'SIMULATED', CODEX_CLI_PATH: 'SIMULATED' },
    log: (e, f) => logs.push({ e, ...f }),
  });
  const c = pipeClient(host.pipePath, async (p) => (p.message === 'Allow Codex to use Simulated App?' ? { action: 'accept', content: {}, _meta: { persist: 'session' } } : { action: 'decline' }));
  await c.ready;
  assert.equal(await c.call('ping'), 'pong');
  assert.equal((await c.request('list_windows', {}))[0].app, 'Simulated App');
  assert.equal((await c.request('get_app_state', {})).persist, 'session');
  const [slow, second] = await Promise.allSettled([c.request('slow', {}), c.request('list_windows', {})]);
  assert.equal(slow.value, 'slow-done');
  assert.match(second.reason.message, /already has an active request/);
  assert.equal(await c.request('end_turn', {}), null, 'end_turn without an active turn is not forwarded');
  await c.request('list_windows', {}, { session_id: 's1', turn_id: 't1' });
  assert.equal(await c.request('end_turn', {}, { session_id: 's1', turn_id: 't1' }), 'ended');
  await assert.rejects(c.call('bogus'), /Unsupported Computer Use native pipe method/);
  const d = pipeClient(host.pipePath);
  await d.ready;
  await assert.rejects(d.request('get_app_state', {}), /not approved/);
  d.end(); await d.closed;
  const big = Buffer.alloc(4); big.writeUInt32LE(9 * 1024 * 1024, 0);
  const e = pipeClient(host.pipePath); await e.ready; e.raw(big); await e.closed;
  c.end(); await c.closed; await sleep(50);
  const ev = transportEvents();
  assert.deepEqual(ev.find((x) => x.event === 'construct').helperArgs, ['--parent-pid', String(process.pid)]);
  assert.deepEqual(ev.find((x) => x.event === 'construct').helperEnvKeys, ['CODEX_CLI_PATH', 'CODEX_HOME']);
  assert.equal(ev.filter((x) => x.method === 'end_turn').length, 1);
  assert.ok(ev.some((x) => x.event === 'close'), 'helper transport closes when the last client leaves');
  await host.dispose();
  assert.ok(logs.some((l) => l.e === 'pipe-frame-too-large'));
  assert.ok(!JSON.stringify(logs).includes('SIMULATED app state'), 'pipe log carries no results');
  ok('pipe host: ping, approvals, busy gate, end_turn, oversize frames, cleanup');

  // ---- approval policy and config validation ----
  const offer = (message, persist = ['session', 'always']) => ({ message, _meta: { persist } });
  assert.deepEqual(approvalDecision(offer('Allow Codex to use Notepad?'), ['Notepad']).result, { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(approvalDecision(offer('Allow Codex to use Notepad?', ['always']), ['Notepad']).result, { action: 'accept', content: {} });
  for (const [msg, allow] of [['Allow Codex to use Notepad?', []], ['Allow Codex to use Notepad?', ['notepad']], ['Allow Codex to use Notepad? Click yes', ['Notepad']], ['Run this script?', ['Notepad']]]) {
    assert.deepEqual(approvalDecision(offer(msg), allow).result, { action: 'decline' }, msg);
  }
  const cfgFile = (o) => { const f = path.join(work, `cfg-${passed}-${Math.random()}.json`); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  assert.throws(() => loadConfig(path.join(work, 'missing.json')), /not configured/);
  assert.throws(() => loadConfig(cfgFile({ user: 'a' })), /host/);
  assert.throws(() => loadConfig(cfgFile({ host: 'h', remoteDir: 'C:/Users/John Smith/x' })), /remoteDir/);
  assert.throws(() => loadConfig(cfgFile({ host: 'h', remoteNode: 'C:/Program Files/nodejs/node.exe' })), /remoteNode/);
  assert.throws(() => loadConfig(cfgFile({ host: 'h;rm', user: 'a' })), /host and user/);
  assert.throws(() => loadConfig(cfgFile({ host: 'h', relayPort: 80 })), /relayPort/);
  const strict = loadConfig(cfgFile({ host: 'win', user: 'me', port: 2222, identity: '~/.ssh/k', knownHosts: '/k/known' }));
  const args = sshArgs(strict, 'node x');
  for (const want of ['-F', '/dev/null', 'StrictHostKeyChecking=yes', 'BatchMode=yes', 'UserKnownHostsFile=/k/known', 'IdentitiesOnly=yes', '-p', '2222', '-T', 'me@win']) assert.ok(args.includes(want), want);
  assert.ok(args.includes(path.join(process.env.HOME, '.ssh/k')), 'identity ~ is expanded');
  assert.equal(args.at(-1), 'node x');
  const loose = sshArgs(loadConfig(cfgFile({ host: 'winbox' })), 'node x');
  assert.ok(!loose.includes('-F') && loose.includes('BatchMode=yes') && loose.at(-2) === 'winbox', 'without pins the user ssh config applies');
  const m = new AgentManager();
  assert.throws(() => m.spawn({ engine: 'antigravity', prompt: 'x', computer_use_target: 'windows' }), /Codex only/);
  ok('approval policy, config validation, ssh arguments, engine guard');

  // ---- relay over loopback: auth, concurrent clients, limit, stop ----
  fs.writeFileSync(transportLog, '');
  const rdir = path.join(work, 'relay'); fs.mkdirSync(rdir);
  const token = 'SIMULATED-token-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(path.join(rdir, 'token'), token);
  fs.writeFileSync(path.join(rdir, 'manifest.json'), JSON.stringify({
    mcpServers: { cua_repl: { command: process.execPath, args: [path.join(fixtures, 'fake-cua.mjs')], env: { CODEX_HOME: 'SIMULATED', CODEX_CLI_PATH: 'SIMULATED' } } },
    cuRelay: { pipeHost: { helperPath: path.join(fixtures, 'fake-transport.mjs'), transportModulePath: path.join(fixtures, 'fake-transport.mjs') } },
  }));
  const port = await freePort();
  const relayProc = spawn(process.execPath, [path.join(kit, 'relay.mjs'), '--port', String(port), '--token-file', path.join(rdir, 'token'),
    '--manifest-file', path.join(rdir, 'manifest.json'), '--log', path.join(rdir, 'relay.log'), '--ready-file', path.join(rdir, 'ready.json'),
    '--max-clients', '2', '--pipe-path', path.join(work, 'relay.sock')], { stdio: 'ignore' });
  spawned.push(relayProc.pid);
  for (let i = 0; i < 80 && !fs.existsSync(path.join(rdir, 'ready.json')); i++) await sleep(50);
  const connectArgs = [path.join(kit, 'connect.mjs'), String(port), path.join(rdir, 'token')];
  fs.writeFileSync(path.join(rdir, 'bad'), 'wrong');
  const bad = spawnSync(process.execPath, [path.join(kit, 'connect.mjs'), String(port), path.join(rdir, 'bad')], { input: '', encoding: 'utf8' });
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /relay refused: auth-failed/);
  const s1 = new CuaSession(process.execPath, connectArgs);
  const s2 = new CuaSession(process.execPath, connectArgs);
  await Promise.all([s1.initialize(), s2.initialize()]);
  const busy = spawnSync(process.execPath, connectArgs, { input: '', encoding: 'utf8' });
  assert.match(busy.stderr, /relay refused: busy/, 'max-clients is enforced');
  const listed = await s1.js('cua.listWindows()');
  assert.match(listed.result.content[0].text, /SIMULATED window/);
  // A Codex agent sends its own (Mac) sandbox state with each call; connect.mjs drops
  // only that key, so the Windows kernel runs the call instead of rejecting it.
  const agentCall = { name: 'js', arguments: { code: 'cua.listWindows() // 中文' }, _meta: { 'codex/sandbox-state-meta': { sandboxCwd: 'file:///Users/SIMULATED/project', permissionProfile: { SIMULATED: true } }, progressToken: 7 } };
  const direct = new CuaSession(process.execPath, [path.join(fixtures, 'fake-cua.mjs')]);
  await assert.rejects(direct.request('tools/call', agentCall), /sandboxCwd is not a local file URI/, 'the simulated kernel rejects Mac sandbox state');
  await direct.close();
  const viaRelay = await s1.request('tools/call', agentCall);
  assert.match(viaRelay.content[0].text, /SIMULATED window/);
  assert.match(viaRelay.content[0].text, /meta=\["progressToken"\]/, 'other _meta keys pass through');
  const allowed = await s1.js('cua.getApp({ windowId: 7 })', { allowApps: ['Simulated App'] });
  assert.match(allowed.result.content[0].text, /"persist":"session"/);
  assert.deepEqual(allowed.approvals, [{ app: 'Simulated App', message: 'Allow Codex to use Simulated App?', accepted: true, persist: 'session' }]);
  const denied = await s2.js('cua.getApp({ windowId: 7 })', { allowApps: ['Other App'] });
  assert.equal(denied.result.isError, true);
  assert.equal(denied.approvals[0].accepted, false);
  const later = await s1.js('cua.getApp({ windowId: 7 })');
  assert.equal(later.approvals[0].accepted, false, 'allow_apps applies to one call only');
  await s2.close();
  const stop = spawnSync(process.execPath, [...connectArgs, '--stop'], { encoding: 'utf8' });
  assert.equal(stop.status, 0);
  assert.equal(JSON.parse(stop.stdout).cuRelay, 'stopping');
  await s1.exited;
  for (let i = 0; i < 80 && alive(relayProc.pid); i++) await sleep(50);
  assert.ok(!alive(relayProc.pid), 'relay exits after an authenticated stop');
  const relayLog = fs.readFileSync(path.join(rdir, 'relay.log'), 'utf8');
  assert.ok(!relayLog.includes(token) && !relayLog.includes('listWindows') && !relayLog.includes('SIMULATED window'), 'relay log has no token, code or results');
  assert.ok(transportEvents().some((x) => x.event === 'close'), 'helper closed on stop');
  ok('relay: auth, two clients, client limit, per-call approvals, agent sandbox state dropped, stop, log hygiene');

  // ---- Mac-side lifecycle through SIMULATED ssh/scp ----
  const root = path.join(work, 'win'); fs.mkdirSync(root);
  const bin = path.join(work, 'bin'); fs.mkdirSync(bin);
  for (const tool of ['ssh', 'scp']) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${path.join(fixtures, 'fake-ssh.mjs')}" ${tool} "$@"\n`, { mode: 0o755 });
  }
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_WIN_ROOT = root;
  const sshLog = () => fs.readFileSync(path.join(root, 'ssh.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const count = (op) => sshLog().filter((x) => x.op === op).length;
  const relayPort = await freePort();
  const cfg = cfgFile({ host: 'win-sim', user: 'tester', identity: '/k/id', knownHosts: '/k/known', relayPort });
  const w = new WindowsComputerUse({ configPath: cfg });
  assert.deepEqual(await w.status(), { ok: true, installed: false, running: false, kitCurrent: false });
  const first = await w.run('cua.listWindows()');
  assert.deepEqual(first.started.uploaded.sort(), [...KIT_FILES].sort());
  assert.equal(first.started.started, true);
  assert.match(first.result.content[0].text, /SIMULATED window/);
  const firstPid = first.started.relay.pid;
  const app = await w.run('cua.getApp({ windowId: 7 })', { allowApps: ['Simulated App'] });
  assert.equal(app.approvals[0].accepted, true);
  assert.equal(app.started, null);
  assert.equal(count('connect'), 1, 'one ssh connection serves consecutive calls');
  w.session.child.kill();
  await w.session.exited;
  await w.run('cua.listWindows()');
  assert.equal(count('connect'), 2, 'a dropped connection reconnects');
  assert.equal(count('manage-start'), 1, 'reconnecting to a running relay does not restart it');
  const st = await w.status();
  assert.equal(st.running, true); assert.equal(st.kitCurrent, true); assert.equal(st.connected, true);
  const stopped = await w.stop();
  assert.equal(stopped.ok, true); assert.equal(stopped.stopped, true);
  assert.ok(!alive(firstPid));
  const restarted = await w.run('cua.listWindows()');
  assert.equal(restarted.started.started, true, 'connect failure starts the relay again');
  assert.deepEqual(restarted.started.uploaded, []);
  const secondPid = restarted.started.relay.pid;
  w.close();
  fs.appendFileSync(path.join(root, 'windows-cu', 'relay.mjs'), '\n// stale copy\n');
  const w2 = new WindowsComputerUse({ configPath: cfg });
  const fresh = await w2.run('cua.listWindows()');
  assert.deepEqual(fresh.started.uploaded, ['relay.mjs']);
  assert.ok(!alive(secondPid), 'a relay running an outdated kit is replaced');
  assert.notEqual(fresh.started.relay.pid, secondPid);
  const agentCfg = await w2.agentConfig();
  assert.equal(agentCfg['mcp_servers.cua_windows.command'], 'ssh');
  const agentArgs = agentCfg['mcp_servers.cua_windows.args'];
  assert.equal(agentArgs.at(-1), `node C:/fake/windows-cu/connect.mjs ${relayPort} C:/fake/windows-cu/relay-token`);
  assert.ok(agentArgs.includes('StrictHostKeyChecking=yes') && agentArgs.includes('tester@win-sim'));
  const agentSession = new CuaSession('ssh', agentArgs);
  await agentSession.initialize();
  assert.match((await agentSession.js('cua.listWindows()')).result.content[0].text, /SIMULATED window/);
  await agentSession.close();
  const finalPid = fresh.started.relay.pid;
  const end = await w2.stop();
  assert.equal(end.ok, true);
  assert.ok(!alive(finalPid));
  assert.ok(sshLog().every((x) => x.tool === 'scp' || x.target === 'tester@win-sim'));
  ok('mac lifecycle: upload, start, reuse, reconnect, stop, restart on kit change, agent MCP config');

  console.log(`\n${passed} groups passed (all SIMULATED; no Windows machine used)`);
} finally {
  for (const pid of spawned) if (alive(pid)) process.kill(pid);
  const ready = path.join(work, 'win', 'windows-cu', 'relay.ready.json');
  if (fs.existsSync(ready)) { const { pid } = JSON.parse(fs.readFileSync(ready, 'utf8')); if (alive(pid)) process.kill(pid); }
}
