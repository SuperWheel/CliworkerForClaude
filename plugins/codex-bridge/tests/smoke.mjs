// End-to-end smoke test: talks MCP to server/index.mjs, which drives real Codex.
// Usage: node tests/smoke.mjs [--cu]   (--cu also exercises computer use, read-only)
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-smoke-'));
const srv = spawn('node', [path.join(here, '..', 'server', 'index.mjs')], { cwd: work, stdio: ['pipe', 'pipe', 'inherit'] });
let id = 0;
const pending = new Map();
readline.createInterface({ input: srv.stdout }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'notifications/progress') return console.log('   · progress', m.params.message);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); p(m); }
});
const rpc = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const call = async (name, args) => {
  const t0 = Date.now();
  const r = await rpc('tools/call', { name, arguments: args, _meta: { progressToken: `p${id}` } });
  const out = r.result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type} ${c.mimeType ?? ''} ${c.data?.length ?? 0}b]`)).join('\n');
  console.log(`\n==> ${name} (${Date.now() - t0}ms)${r.result.isError ? ' ERROR' : ''}\n${out}`);
  return { r, out };
};

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
const tools = await rpc('tools/list', {});
console.log('tools:', tools.result.tools.map((t) => t.name).join(', '));

const { out } = await call('codex_spawn', {
  sandbox: 'workspace-write', effort: 'low',
  tasks: [
    { name: 'alpha', prompt: 'Create a file alpha.txt containing the word ALPHA, then run `cat alpha.txt`. Reply "alpha ok".' },
    { name: 'beta', prompt: 'Run `echo $((6*7))` and reply with just the number.' },
  ],
});
const ids = [...out.matchAll(/\[(cx-[0-9a-f]+)\]/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);
for (let i = 0; i < 10; i++) {
  const { out: w } = await call('codex_wait', { agent_ids: ids, timeout_sec: 60, until: 'all' });
  if (!/RUNNING|STARTING|QUEUED/.test(w)) break;
}
await call('codex_send', { agent_id: ids[1], message: 'Now multiply that by 2. Reply with just the number.', wait_sec: 90 });
await call('codex_status', {});
console.log('\nalpha.txt exists:', fs.existsSync(path.join(work, 'alpha.txt')));

if (process.argv.includes('--cu')) {
  await call('codex_computer_use', { code: 'const apps = await cua.listApps({ emit: false }); nodeRepl.write(`running apps: ${apps.filter(a => a.isRunning).length}`);' });
  await call('codex_computer_use', { code: 'const f = await cua.getApp("Finder"); const png = await f.getScreenshot({ emit: false }); nodeRepl.write(`screenshot bytes: ${png.length}`);' });
}
for (const a of ids) await call('codex_close', { agent_id: a });
srv.stdin.end();
