// Offline lifecycle regression: shared queue, resume flags, process trees and failure isolation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentManager } from '../server/agent-manager.mjs';
import { zcodeEntry } from '../server/engines.mjs';

const work = fs.mkdtempSync('/private/tmp/codex-bridge-lifecycle-');
const fake = path.join(work, 'fake.cjs');
fs.mkdirSync(path.join(work, 'provider'));
fs.writeFileSync(path.join(work, 'provider/zcode-builtin.json'), '{}');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const {spawn}=require('node:child_process');
const args=process.argv.slice(2), ag=!process.argv[1].endsWith('/zcode.cjs');
const prompt=args[args.indexOf('-p')+1];
fs.writeFileSync('args.json',JSON.stringify(args));
const emit=e=>console.log(JSON.stringify(e));
if(args.includes('app-server')) {
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line);let result={};
  if(q.method==='session/resume')fs.writeFileSync('resume.json',JSON.stringify(q.params));
  if(q.method==='session/create'||q.method==='session/resume')result={session:{sessionId:'sess_protocol'},settings:{model:{available:[{ref:{providerId:'fake',modelId:'fake-model'},reasoning:{defaultLevel:'low'}}]}}};
  if(q.method==='session/setModel')fs.writeFileSync('model.json',JSON.stringify(q.params));
  if(q.method==='session/setMode')fs.writeFileSync('mode.json',JSON.stringify(q.params));
  emit({id:q.id,result});
  if(q.method==='session/send'){
   if(q.params.content.includes('FAIL_PROTOCOL'))setTimeout(()=>emit({method:'session/event',params:{sessionId:'sess_protocol',type:'turn.failed',payload:{message:'fixture protocol failure'}}}),20);
   else if(q.params.content.includes('FAIL'))process.exit(7);
   else setTimeout(()=>emit({method:'session/event',params:{sessionId:'sess_protocol',type:'turn.completed',payload:{response:'DONE',resultType:'success'}}}),150);
  }
 });
 process.stdin.on('end',()=>process.exit(0));
} else {
if(ag)emit({event:'init',conversation_id:'ag-session',init:{model:'fake-model'}});
else emit({type:'turn.started',sessionId:'sess_fake',turnId:'turn_fake'});
if(prompt.includes('HANG')){
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
 fs.writeFileSync('grandchild.pid',String(child.pid));
 setInterval(()=>{},1000);
}else if(prompt.includes('FAIL')){process.exit(7)}
else setTimeout(()=>{
 if(ag)emit({event:'result',result:{conversation_id:'ag-session',status:'SUCCESS',response:'DONE'}});
 else {emit({type:'turn.completed',sessionId:'sess_fake',payload:{response:'DONE',resultType:'success'}});emit({type:'result',sessionId:'sess_fake',response:'DONE',projection:{status:'idle'}})}
},150);
}
`);
fs.chmodSync(fake, 0o755);
const original = Object.fromEntries(['AGY_BIN','ZCODE_ENTRY','ZCODE_DATA_BASE_DIR','CODEX_BRIDGE_MAX_PARALLEL'].map((k) => [k, process.env[k]]));
process.env.AGY_BIN = fake; process.env.ZCODE_ENTRY = fake; process.env.ZCODE_DATA_BASE_DIR = work; process.env.CODEX_BRIDGE_MAX_PARALLEL = '1';
const m = new AgentManager();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function settled(a, expected = 'idle') {
  const end = Date.now() + 8000;
  while (a.status !== expected && Date.now() < end) await pause(30);
  assert.equal(a.status, expected, m.digest(a, { from: 0 }));
}
const cwd = (n) => { const p = path.join(work, n); fs.mkdirSync(p); return p; };
try {
  const ag = m.spawn({ engine: 'antigravity', cwd: cwd('ag'), sandbox: 'workspace-write', prompt: 'DONE', model: 'fake-model', effort: 'high' });
  const zc = m.spawn({ engine: 'zcode', cwd: cwd('zc'), sandbox: 'read-only', prompt: 'DONE' });
  assert.equal(zc.status, 'queued');
  await settled(ag); await settled(zc);
  const agArgs = JSON.parse(fs.readFileSync(path.join(ag.cwd, 'args.json')));
  assert(agArgs.includes('--dangerously-skip-permissions'));
  assert.equal(agArgs[agArgs.indexOf('--mode') + 1], 'accept-edits');
  assert(agArgs[agArgs.indexOf('-p') + 1].startsWith('You are running as a sub-agent'));
  let zArgs = JSON.parse(fs.readFileSync(path.join(zc.cwd, 'args.json')));
  assert(zArgs.includes('app-server')); assert(zArgs.includes('--stdio'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(zc.cwd, 'mode.json'))).mode, 'plan');
  await m.send(zc.id, 'DONE'); await settled(zc);
  zArgs = JSON.parse(fs.readFileSync(path.join(zc.cwd, 'args.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(zc.cwd, 'resume.json'))).sessionId, 'sess_protocol');
  await m.send(ag.id, 'DONE'); await settled(ag);
  const resumeArgs = JSON.parse(fs.readFileSync(path.join(ag.cwd, 'args.json')));
  assert.equal(resumeArgs[resumeArgs.indexOf('--conversation') + 1], 'ag-session');
  const ro = m.spawn({ engine: 'antigravity', sandbox: 'read-only', cwd: cwd('ro'), prompt: 'DONE' });
  await settled(ro);
  const roArgs = JSON.parse(fs.readFileSync(path.join(ro.cwd, 'args.json')));
  assert(!roArgs.includes('--dangerously-skip-permissions'));
  assert.equal(roArgs[roArgs.indexOf('--mode') + 1], 'plan');
  const hanging = m.spawn({ engine: 'antigravity', cwd: cwd('hang'), prompt: 'HANG' });
  const queued = m.spawn({ engine: 'zcode', cwd: cwd('queue'), prompt: 'DONE' });
  await assert.rejects(m.send(hanging.id, 'hello'), /steering.*not supported/);
  while (!fs.existsSync(path.join(hanging.cwd, 'grandchild.pid'))) await pause(30);
  const grandchild = Number(fs.readFileSync(path.join(hanging.cwd, 'grandchild.pid')));
  await m.interrupt(hanging.id); assert.equal(hanging.status, 'interrupted');
  assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' });
  await settled(queued);
  const bad = m.spawn({ engine: 'zcode', cwd: cwd('bad'), prompt: 'FAIL' });
  await settled(bad, 'failed'); assert.match(bad.error, /exited 7.*no final result/);
  const protocol = m.spawn({ engine: 'zcode', model: 'fake-model', effort: 'max', sandbox: 'read-only', cwd: cwd('protocol'), prompt: 'FAIL_PROTOCOL' });
  await settled(protocol, 'failed'); assert.equal(protocol.error, 'fixture protocol failure');
  const selected = JSON.parse(fs.readFileSync(path.join(protocol.cwd, 'model.json')));
  assert.equal(selected.model.options.reasoningLevel, 'low'); // native default, not ignored effort max
  assert.equal(selected.persistAsWorkspaceLastUsed, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(protocol.cwd, 'mode.json'))).mode, 'plan');
  // A Codex app-server failure must not affect the other engine pool.
  const running = m.spawn({ engine: 'antigravity', cwd: cwd('isolation'), prompt: 'DONE' });
  m.client.emit('exit'); await settled(running);
  const codex = { id: 'cx-abc123', engine: 'codex', name: 'queued compatibility', kind: 'task' };
  assert.match(m.header({ ...codex, status: 'idle', turnStartedAt: null, turnCount: 0, usage: null }), /^### \[cx-[a-f0-9]+\] queued compatibility — IDLE · task · turn 0 · -$/);
  assert.throws(() => m.spawn({ engine: 'bogus', prompt: 'x' }), /unknown engine/);
  assert.throws(() => m.spawn({ engine: 'zcode', prompt: 'x', images: ['a.png'] }), /Codex only/);
  assert(fs.readlinkSync(zcodeEntry()).endsWith('/fake.cjs'));
  console.log('PASS: queue, prompt/permission mapping, resume, process-tree interruption, exit failure, Codex isolation and header compatibility');
} finally {
  m.shutdown();
  for (const [key, val] of Object.entries(original)) { if (val == null) delete process.env[key]; else process.env[key] = val; }
  zcodeEntry(); // restore the native shim after the fake-entry override
}
