// Exercises approval relay (ask mode), codex_review and codex_capabilities over MCP.
import { spawn, execSync } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-feat-'));
execSync('git init -q && printf "def add(a, b):\\n    return a + b\\n" > calc.py && git add . && git -c user.email=t@t -c user.name=t commit -qm init && printf "def add(a, b):\\n    return a - b  # oops\\n" > calc.py', { cwd: work });
const srv = spawn('node', [path.join(here, '..', 'server', 'index.mjs')], { cwd: work, stdio: ['pipe', 'pipe', 'inherit'] });
let id = 0; const pending = new Map();
readline.createInterface({ input: srv.stdout }).on('line', (l) => { const m = JSON.parse(l); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
const rpc = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const call = async (name, args, show = 2500) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const out = r.result.content.map((c) => c.text ?? `[${c.type}]`).join('\n');
  console.log(`\n==> ${name}${r.result.isError ? ' ERROR' : ''}\n${out.slice(0, show)}`);
  return out;
};
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });

await call('codex_capabilities', {}, 3000);

// Approval relay: read-only sandbox forces an escalation request for the write.
let out = await call('codex_spawn', { name: 'needs-approval', sandbox: 'read-only', approval_policy: 'on-request', effort: 'low',
  prompt: 'Create the file note.txt containing "hello" (use a shell command). If the sandbox blocks you, request escalation.' });
const ag = out.match(/\[(cx-[0-9a-f]+)\]/)[1];
for (let i = 0; i < 8; i++) {
  out = await call('codex_wait', { agent_ids: [ag], timeout_sec: 90 });
  const req = out.match(/request_id="(r\d+)"/);
  if (req) await call('codex_respond', { agent_id: ag, request_id: req[1], decision: 'accept' });
  else if (/FINISHING|IDLE|FAILED/.test(out.split('\n')[0])) break;
}
console.log('\nnote.txt:', fs.existsSync(path.join(work, 'note.txt')) ? fs.readFileSync(path.join(work, 'note.txt'), 'utf8') : 'MISSING');

out = await call('codex_review', { target: 'uncommitted' });
const rv = out.match(/\[(cx-[0-9a-f]+)\]/)[1];
for (let i = 0; i < 8; i++) {
  out = await call('codex_wait', { agent_ids: [rv], timeout_sec: 120 }, 4000);
  if (/FINISHING|IDLE|FAILED/.test(out.split('\n')[0])) break;
}
srv.stdin.end();
