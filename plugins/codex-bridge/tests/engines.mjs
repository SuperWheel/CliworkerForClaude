// Real end-to-end acceptance over MCP stdio. Requires logged-in agy and ZCode.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync('/private/tmp/codex-bridge-engines-');
const agDir = path.join(work, 'antigravity'), zcDir = path.join(work, 'zcode');
fs.mkdirSync(agDir); fs.mkdirSync(zcDir);
const agModel = process.env.AGY_TEST_MODEL || 'claude-sonnet-4-6';
const srv = spawn(process.execPath, [path.join(here, '../server/index.mjs')], { cwd: work, env: { ...process.env, CODEX_BRIDGE_MAX_PARALLEL: '2' }, stdio: ['pipe', 'pipe', 'pipe'] });
let seq = 0, stderr = '';
const pending = new Map();
srv.stderr.on('data', (s) => { stderr = (stderr + s).slice(-8000); });
readline.createInterface({ input: srv.stdout }).on('line', (s) => {
  const m = JSON.parse(s), p = pending.get(m.id);
  if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
});
srv.on('exit', (code) => {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`server exited ${code}: ${stderr}`)); }
  pending.clear();
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    // A blocking codex_run may legitimately exceed the transport's old 75s
    // timeout; leave time for its requested wait plus response/cleanup.
    const timeoutMs = Math.max(75000, ((params.arguments?.timeout_sec || 0) + 15) * 1000);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args, allowError = false) {
  const r = await rpc('tools/call', { name, arguments: args });
  assert(!r.error, JSON.stringify(r.error));
  const out = r.result.content.map((c) => c.text || '').join('\n');
  console.log(`\n${name}:\n${out}`);
  if (!allowError) assert(!r.result.isError, out);
  return out;
}
const ids = [];
async function idle(agentIds, maxSeconds = 300) {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    const out = await call('codex_wait', { agent_ids: agentIds, timeout_sec: 30, until: 'all' });
    const headers = out.split('\n').filter((s) => s.startsWith('### '));
    assert.equal(headers.length, agentIds.length);
    assert(!headers.some((s) => /— (FAILED|INTERRUPTED|CLOSED)/.test(s)), out);
    if (headers.every((s) => /— IDLE/.test(s))) return out;
    // FINISHING is settled to the public wait API; allow post-turn process cleanup.
    if (headers.some((s) => /— FINISHING/.test(s))) await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Agents failed to reach IDLE before deadline');
}
try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'engines-acceptance', version: '0.2.0' } });
  assert.equal(init.result.serverInfo.version, JSON.parse(fs.readFileSync(path.join(here, '../.claude-plugin/plugin.json'), 'utf8')).version);
  const list = await rpc('tools/list', {});
  assert.deepEqual(list.result.tools.find((t) => t.name === 'codex_run').inputSchema.properties.engine.enum, ['codex', 'antigravity', 'zcode']);
  const agWord = `AG_${Date.now()}`, zcWord = `ZC_${Date.now()}`;
  const out = await call('codex_spawn', { sandbox: 'workspace-write', tasks: [
    { engine: 'antigravity', model: agModel, cwd: agDir, name: 'ag-write', prompt: `Run the shell command printf BRIDGE_SHELL_OK once. Then create hello.txt in the current directory containing exactly ${agWord} with no newline using your file writing tool. Then reply DONE. Do not do any other work.` },
    { engine: 'zcode', cwd: zcDir, name: 'zc-write', effort: 'low', prompt: `Run the Bash command printf BRIDGE_SHELL_OK once. Then use the Write tool to create hello.txt in the current directory containing exactly ${zcWord} with no newline. Then reply DONE. Do not do other work.` },
  ] });
  ids.push(...new Set([...out.matchAll(/\[((?:ag|zc)-[0-9a-f]+)\]/g)].map((m) => m[1])));
  assert.equal(ids.length, 2);
  const ag = ids.find((id) => id.startsWith('ag-')), zc = ids.find((id) => id.startsWith('zc-'));
  assert(ag && zc);
  // Verify both launched together, before either could finish in the serial queue.
  assert.equal((out.match(/running|finishing|idle/g) || []).length, 2, out);
  const steer = await call('codex_send', { agent_id: zc, message: 'This should not steer an active turn.' }, true);
  assert.match(steer, /steering.*not supported/);
  await idle(ids);
  assert.equal(fs.readFileSync(path.join(agDir, 'hello.txt'), 'utf8'), agWord);
  assert.equal(fs.readFileSync(path.join(zcDir, 'hello.txt'), 'utf8'), zcWord);
  for (const id of ids) {
    const transcript = await call('codex_transcript', { agent_id: id });
    assert.equal((transcript.match(/\] \$ /g) || []).length, 1, transcript);
    assert.equal((transcript.match(/✓ \$ .* → exit 0/g) || []).length, 1, transcript);
    assert.equal((transcript.match(/✎ file changes \[completed\]/g) || []).length, 1, transcript);
    assert.equal((transcript.match(/💬 (antigravity|zcode) \(final\):/g) || []).length, 1, transcript);
    assert.match(transcript, /    │ BRIDGE_SHELL_OK/);
    assert(!/🔧 (antigravity|zcode)\.(run_command|Bash|write_file|write_to_file|Write)/.test(transcript), transcript);
  }
  const before = await call('codex_status', { agent_id: zc });
  const session = before.match(/^thread: (sess_\S+)/m)?.[1];
  assert(session);
  assert.match(before.split('\n')[0], /zcode.*effort low ignored/);
  await call('codex_send', { agent_id: zc, message: 'From our previous conversation, what exact word did you write into hello.txt? Reply only that word. Do not read files or call any tools.' });
  await idle([zc]);
  const after = await call('codex_transcript', { agent_id: zc });
  assert(after.includes(`thread: ${session}`));
  assert.match(after.split('\n')[0], /turn 2/);
  const lastFinal = after.slice(after.lastIndexOf('💬 zcode (final):'));
  assert(lastFinal.includes(zcWord), 'resume did not recall the exact word');
  const ro = await call('codex_run', { engine: 'antigravity', model: agModel, cwd: agDir, sandbox: 'read-only', name: 'ag-readonly', timeout_sec: 180, prompt: 'Compute 19+23 mentally. Reply READ_ONLY_OK_42. Do not invoke tools, run commands, or modify or create files.' });
  const roId = ro.match(/\[(ag-[0-9a-f]+)\]/)?.[1]; ids.push(roId);
  assert.match(ro.split('\n')[0], /— (FINISHING|IDLE)/);
  assert(ro.includes('READ_ONLY_OK_42'));
  await idle([roId]);
  assert.equal(fs.readFileSync(path.join(agDir, 'hello.txt'), 'utf8'), agWord);
  assert.deepEqual(fs.readdirSync(agDir).filter((s) => !s.startsWith('.')), ['hello.txt']);
  for (const id of ids) {
    const transcript = await call('codex_transcript', { agent_id: id });
    assert.match(transcript, /\[\d\d:\d\d:\d\d\]/);
    assert.match(transcript, /💬 (antigravity|zcode) \(final\)/);
    const state = await call('codex_status', { agent_id: id });
    const logFile = state.match(/^log file: (.+)$/m)?.[1];
    assert(logFile && fs.readFileSync(logFile, 'utf8').includes('(final)'));
  }
  if (process.env.ZCODE_TEST_MODEL) {
    const modelRun = await call('codex_run', { engine: 'zcode', model: process.env.ZCODE_TEST_MODEL, cwd: zcDir, sandbox: 'workspace-write', name: 'zc-model', timeout_sec: 180, prompt: 'Run the Bash command printf PROTOCOL_SHELL_OK once. Then use Write to create protocol.txt containing exactly PROTOCOL_WRITE_OK with no newline. Finally reply MODEL_PATH_OK. Do not do other work.' });
    const modelId = modelRun.match(/\[(zc-[0-9a-f]+)\]/)?.[1]; ids.push(modelId);
    assert.match(modelRun.split('\n')[0], /— (FINISHING|IDLE)/);
    assert(modelRun.includes('MODEL_PATH_OK'));
    await idle([modelId]);
    assert.equal(fs.readFileSync(path.join(zcDir, 'protocol.txt'), 'utf8'), 'PROTOCOL_WRITE_OK');
    const protocolTranscript = await call('codex_transcript', { agent_id: modelId });
    assert.equal((protocolTranscript.match(/\] \$ /g) || []).length, 1, protocolTranscript);
    assert.equal((protocolTranscript.match(/✓ \$ .* → exit 0/g) || []).length, 1, protocolTranscript);
    assert.equal((protocolTranscript.match(/✎ file changes \[completed\]/g) || []).length, 1, protocolTranscript);
    assert.equal((protocolTranscript.match(/💬 zcode \(final\):/g) || []).length, 1, protocolTranscript);
    assert.match(protocolTranscript, /    │ PROTOCOL_SHELL_OK/);
    await call('codex_send', { agent_id: modelId, message: 'What exact marker did you reply in our previous turn? Reply only that marker. Do not use tools.' });
    await idle([modelId]);
    const continued = await call('codex_transcript', { agent_id: modelId });
    assert.match(continued.split('\n')[0], /turn 2/);
    assert(continued.slice(continued.lastIndexOf('💬 zcode (final):')).includes('MODEL_PATH_OK'));
  }
  if (process.env.ZCODE_GLM_MODEL) {
    const glmDir = path.join(work, 'zcode-glm'); fs.mkdirSync(glmDir);
    // Native edit mode asks interactively for python3. This explicitly scoped
    // temporary-directory acceptance authorizes execution with native yolo.
    const glm = await call('codex_run', { engine: 'zcode', model: process.env.ZCODE_GLM_MODEL, cwd: glmDir, sandbox: 'danger-full-access', name: 'zc-glm-factorial', timeout_sec: 180, prompt: 'Use the Write tool to create fact.py in the current directory. It must print the factorial n! for every n=1..8, one integer per line, without labels. Then use Bash to run python3 fact.py and verify the output. Finally reply GLM_FACTORIAL_OK. Do no other work.' });
    const glmId = glm.match(/\[(zc-[0-9a-f]+)\]/)?.[1]; ids.push(glmId);
    await idle([glmId]);
    const expected = '1\n2\n6\n24\n120\n720\n5040\n40320\n';
    assert.equal(execFileSync('python3', [path.join(glmDir, 'fact.py')], { encoding: 'utf8' }), expected);
    const digest = await call('codex_transcript', { agent_id: glmId });
    assert.match(digest, /GLM_FACTORIAL_OK/);
    assert.match(digest, /✓ \$ .*python3[^\n]*fact\.py[^\n]* → exit 0/);
    assert.match(digest, /✎ file changes \[completed\]:\n\s+add [^\n]*fact\.py/);
    // A passing command shows its last 6 output lines, like Codex's digest.
    for (const n of expected.trim().split('\n').slice(-6)) assert(digest.includes(`│ ${n}\n`), digest);
    assert.match(digest, /│ …\(2 earlier lines\)\n/);
  } else console.log('SKIP: GLM factorial acceptance (ZCODE_GLM_MODEL unset)');
  console.log(`\nPASS: parallel Antigravity + ZCode writes, same-session ZCode follow-up, read-only Antigravity, active steering rejection, transcript and logs${process.env.ZCODE_TEST_MODEL ? ', explicit ZCode model + protocol resume' : ''}${process.env.ZCODE_GLM_MODEL ? ', GLM factorial write + python3 execution' : ''}. Artifacts: ${work}`);
} finally {
  for (const id of ids.filter(Boolean)) await call('codex_close', { agent_id: id }).catch(() => {});
  srv.stdin.end();
  const force = setTimeout(() => srv.kill('SIGKILL'), 5000); force.unref();
  await once(srv, 'exit'); clearTimeout(force);
}
