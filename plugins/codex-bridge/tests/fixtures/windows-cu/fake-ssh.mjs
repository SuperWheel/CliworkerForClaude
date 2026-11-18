// SIMULATED (模拟) ssh/scp for offline tests of server/windows-cu.mjs. "Windows" is a
// local directory: C:/fake stands for $FAKE_WIN_ROOT. Remote commands are interpreted:
//   powershell … -EncodedCommand …        kit inspection → {dir, hashes}
//   powershell … manage.ps1 -Action X …   status/start/stop of the real relay.mjs, run locally
//   node …/connect.mjs …                  connect.mjs, run locally with inherited stdio
// Usage: fake-ssh.mjs ssh|scp ARGS…; every call is appended to $FAKE_WIN_ROOT/ssh.log.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.FAKE_WIN_ROOT;
const here = path.dirname(fileURLToPath(import.meta.url));
const local = (s) => s.replaceAll('C:/fake', ROOT);
const [tool, ...args] = process.argv.slice(2);
const record = (entry) => fs.appendFileSync(path.join(ROOT, 'ssh.log'), JSON.stringify({ tool, ...entry }) + '\n');
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };

if (tool === 'scp') {
  const dest = local(args.at(-1).replace(/^[^:]+:/, ''));
  const sources = args.slice(0, -1).filter((a, i, all) => a.startsWith('/') && !['-F', '-i', '-o'].includes(all[i - 1]));
  for (const s of sources) fs.copyFileSync(s, path.join(dest, path.basename(s)));
  record({ uploaded: sources.map((s) => path.basename(s)) });
  process.exit(0);
}

const command = args.at(-1);
const target = args.at(-2);
const dir = path.join(ROOT, 'windows-cu');
const ready = path.join(dir, 'relay.ready.json');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const relay = () => {
  if (!fs.existsSync(ready)) return null;
  const r = JSON.parse(fs.readFileSync(ready, 'utf8'));
  return alive(r.pid) ? { pid: r.pid, session: 1, port: r.port, startedUtc: r.startedUtc } : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (command.includes('-EncodedCommand')) {
  record({ target, op: 'inspect' });
  fs.mkdirSync(dir, { recursive: true });
  const hashes = {};
  for (const f of fs.readdirSync(dir)) {
    if (/\.(mjs|ps1)$/.test(f)) hashes[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  }
  out({ dir: 'C:/fake/windows-cu', hashes });
}

const manage = /manage\.ps1 -Action (\w+) -Port (\d+) -IdleExitSec (\d+)/.exec(command);
if (manage) {
  const [, action, port, idle] = manage;
  record({ target, op: `manage-${action}` });
  const cur = relay();
  if (action === 'status') out({ ok: true, running: !!cur, relay: cur, desktopSession: 1 });
  if (action === 'start') {
    if (cur) out({ ok: true, running: true, started: false, relay: cur });
    const token = path.join(dir, 'relay-token');
    if (!fs.existsSync(token)) fs.writeFileSync(token, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 });
    const manifest = path.join(dir, 'cua_repl.derived.mcp.json');
    fs.writeFileSync(manifest, JSON.stringify({
      mcpServers: { cua_repl: { command: process.execPath, args: [path.join(here, 'fake-cua.mjs')], env: { CODEX_HOME: 'SIMULATED', CODEX_CLI_PATH: 'SIMULATED' } } },
      cuRelay: { pipeHost: { helperPath: path.join(here, 'fake-transport.mjs'), transportModulePath: path.join(here, 'fake-transport.mjs') } },
    }));
    fs.rmSync(ready, { force: true });
    const child = spawn(process.execPath, [path.join(dir, 'relay.mjs'), '--port', port, '--token-file', token, '--manifest-file', manifest,
      '--log', path.join(dir, 'relay.log'), '--ready-file', ready, '--idle-exit-sec', idle, '--pipe-path', path.join(ROOT, `p${Date.now() % 100000}.sock`)],
    { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 80 && !relay(); i++) await sleep(50);
    const now = relay();
    out({ ok: !!now, running: !!now, started: true, desktopSession: 1, relay: now });
  }
  if (action === 'stop') {
    if (!cur) out({ ok: true, running: false, stopped: false });
    spawnSync(process.execPath, [path.join(dir, 'connect.mjs'), String(cur.port), path.join(dir, 'relay-token'), '--stop'], { stdio: 'ignore' });
    for (let i = 0; i < 80 && alive(cur.pid); i++) await sleep(50);
    if (!alive(cur.pid)) fs.rmSync(ready, { force: true });
    out({ ok: !alive(cur.pid), stopped: !alive(cur.pid), pid: cur.pid, method: 'graceful', leftover: [] });
  }
}

const connect = /^(\S+) (\S+\/connect\.mjs) (\d+) (\S+)$/.exec(command);
if (connect) {
  record({ target, op: 'connect' });
  const child = spawn(process.execPath, [local(connect[2]), connect[3], local(connect[4])], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  record({ target, op: 'unknown', command });
  process.stderr.write(`fake ssh: unsupported command ${command}\n`);
  process.exit(127);
}
