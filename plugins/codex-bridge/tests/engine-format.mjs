// Offline replay of captured CLI stdout, including the app-server envelope.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { startProcessTurn } from '../server/engines.mjs';
import { describeEngineTool } from '../server/format.mjs';
import { zcodeRuntime, zcodeAccounts, selectZcodeModel } from '../server/zcode.mjs';

const fixture = (name) => fs.readFileSync(new URL(`fixtures/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const ag = fixture('ag'), zc = fixture('zc');

async function replay(engine, events, { protocol = false, code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const drawn = [], statuses = [], requests = [];
  const a = { engine, cwd: process.cwd(), sandbox: 'workspace-write', status: 'running', turnCount: 1, ...(protocol ? { model: 'fixture-model' } : {}) };
  let started = false, closed = false;
  const emit = (event) => child.stdout.write(JSON.stringify(event) + '\n');
  const close = () => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    setImmediate(() => { child.exitCode = code; child.emit('close', code, null); });
  };
  const feed = () => {
    started = true;
    for (const event of events) emit(protocol ? { method: 'session/event', params: event } : event);
    // Native protocol exits after stdin is closed by the bridge.
    if (!protocol) close();
  };
  child.stdin = new Writable({
    write(chunk, encoding, done) {
      for (const line of chunk.toString().trim().split('\n')) {
        const q = JSON.parse(line);
        requests.push(q);
        if (!q.method) continue; // response to a server-initiated request
        queueMicrotask(() => {
          let result = {};
          if (q.method === 'session/create') {
            emit({ id: 'runtime-preferences', method: 'session/requestRuntimePreferences', params: {} });
            result = { session: { sessionId: 'fixture-session' }, settings: { model: { available: [{ ref: { providerId: 'fixture', modelId: 'fixture-model' } }] } } };
          }
          emit({ id: q.id, result });
          if (q.method === 'session/send') queueMicrotask(feed);
        });
      }
      done();
    },
    final(done) { if (protocol && started) setImmediate(close); done(); },
  });
  const finished = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  startProcessTurn(a, 'fixture prompt', {
    child,
    push: (kind, text) => drawn.push({ kind, text }),
    status: (state, error) => { a.status = state; a.error = error; statuses.push(state); },
  });
  if (!protocol) queueMicrotask(feed);
  await finished;
  return { a, drawn, statuses, requests, text: drawn.map((v) => v.text).join('\n') };
}

function capturedAssertions(r, engine) {
  assert.equal(r.a.status, 'idle', r.text);
  assert.equal(r.a.finalMessage.trim(), 'DONE');
  assert.equal(r.drawn.filter((v) => v.kind === 'command_start').length, 1, r.text);
  assert.equal(r.drawn.filter((v) => v.kind === 'command').length, 1, r.text);
  assert.match(r.text, /^\$ echo hi-from-cli && ls$/m);
  assert.match(r.text, /^✓ \$ echo hi-from-cli && ls → exit 0 \d+\.\d+s \[completed\]$/m);
  assert.match(r.text, /^    │ hi-from-cli$/m);
  assert.equal(r.drawn.filter((v) => v.kind === 'file_change').length, 1, r.text);
  assert.match(r.text, /✎ file changes \[completed\]:\n    add .*\/note\.txt/);
  assert.equal(r.drawn.filter((v) => v.kind === 'final').length, 1, r.text);
  assert.equal((r.text.match(/\bDONE\b/g) || []).length, 1, r.text);
  assert.match(r.text, new RegExp(`💬 ${engine} \\(final\\):`));
  assert(!/🔧|tool\.updated|tool_info|toolCallId/.test(r.text), r.text);
}

capturedAssertions(await replay('antigravity', ag), 'antigravity');
capturedAssertions(await replay('zcode', zc), 'zcode');
const protocol = await replay('zcode', zc, { protocol: true });
capturedAssertions(protocol, 'zcode');
assert.deepEqual(protocol.requests.filter((q) => q.method).map((q) => q.method), ['session/create', 'session/setModel', 'session/setMode', 'session/subscribe', 'session/send']);
assert.equal(protocol.requests.find((q) => q.id === 'runtime-preferences').result.memoryEnabled, false);

// Event IDs are not the only replay protection: new envelopes can contain the
// same tool-call lifecycle, and streaming metadata must not erase that state.
const duplicatedZc = zc.flatMap((e) => e.type === 'tool.updated' || (e.type === 'model.streaming' && e.payload.kind === 'tool_call') ? [e, { ...e, eventId: `${e.eventId}-replayed` }] : [e]);
capturedAssertions(await replay('zcode', duplicatedZc), 'zcode');
// agy has no chunk IDs: identical incremental text chunks can be legitimate.
capturedAssertions(await replay('antigravity', ag.flatMap((e) => e.step_update?.step_type === 'agent_response' && e.step_update.state === 'ACTIVE' ? [e] : [e, e])), 'antigravity');

const z = (type, payload) => ({ type, payload });
const stream = (kind, delta = '', extra = {}) => z('model.streaming', { kind, delta, assistantMessageId: 'answer', ...extra });
const zFinal = (response = 'DONE') => z('turn.completed', { response, resultType: 'success' });
const step = (state, fields) => ({ event: 'step_update', step_update: { step_index: 1, state, ...fields } });
const agFinal = (response = 'DONE', status = 'SUCCESS') => ({ event: 'result', result: { response, status } });

for (const protocol of [false, true]) {
  const r = await replay('zcode', [stream('text_delta', 'commentary'), stream('text_end'), zFinal('AUTHORITATIVE'), zFinal('ignored')], { protocol });
  assert.equal(r.a.finalMessage, 'AUTHORITATIVE');
  assert.equal(r.drawn.filter((v) => v.kind === 'final').length, 1);
  assert.match(r.text, /💬 zcode:\n    commentary/);
  assert.match(r.text, /💬 zcode \(final\):\n    AUTHORITATIVE/);
  const partial = await replay('zcode', [stream('text_delta', 'UNTERMINATED'), zFinal('')], { protocol });
  assert.equal(partial.a.finalMessage, 'UNTERMINATED');
  assert.equal(partial.drawn.filter((v) => v.kind === 'final').length, 1);
  const unfinishedAfterCommentary = await replay('zcode', [stream('text_delta', 'COMMENTARY'), stream('text_end'), stream('text_delta', 'LATEST'), zFinal('')], { protocol });
  assert.equal(unfinishedAfterCommentary.a.finalMessage, 'LATEST');
  assert.equal(unfinishedAfterCommentary.drawn.filter((v) => v.kind === 'final').length, 1);
  const empty = await replay('zcode', [zFinal('')], { protocol });
  assert.equal(empty.a.status, 'failed');
  assert.match(empty.a.error, /without an answer/);
}

// No final result: preserve the partial answer and report a failed process.
const crashed = await replay('zcode', [stream('text_delta', 'PARTIAL')], { code: 7 });
assert.equal(crashed.a.status, 'failed');
assert.match(crashed.text, /PARTIAL/);
assert.match(crashed.a.error, /exited 7.*no final result/);

// A start event for a read is invisible and must not flush the final message.
const invisible = await replay('zcode', [stream('text_delta', 'DONE'), stream('text_end'), z('tool.updated', { kind: 'started', toolCallId: 'read', toolName: 'Read' }), zFinal()]);
assert.equal((invisible.text.match(/\bDONE\b/g) || []).length, 1);
assert.equal(invisible.drawn.filter((v) => v.kind === 'final').length, 1);

// Tools may fail and be recovered within a successful agent turn. Neither a
// transport success flag nor a zero process exit can hide a tool failure.
for (const result of [
  { success: false, content: 'denied' },
  { success: true, error: { message: 'boom' }, content: 'detail' },
  { isError: true, content: [{ type: 'text', text: 'MCP failure' }] },
  { success: true, content: 'bad exit', perf: { detail: { command: { exitCode: 9 } } } },
  { success: true, content: 'timeout', perf: { detail: { command: { exitCode: 0, timedOut: true } } } },
]) {
  const r = await replay('zcode', [
    z('tool.updated', { kind: 'scheduled', toolCallId: 'failed', toolName: 'Bash', input: { command: 'false' } }),
    z('tool.updated', { kind: 'started', toolCallId: 'failed' }),
    z('tool.updated', { kind: 'result', toolCallId: 'failed', result }),
    zFinal('RECOVERED'),
  ]);
  assert.match(r.text, /^✗ \$ false → exit (\?|9|0).*\[failed\]$/m);
  assert.equal(r.a.status, 'idle');
  assert.match(r.text, /    │ /);
}

for (const field of ['text', 'response', 'content', 'agent_response']) {
  const r = await replay('antigravity', [
    step('ACTIVE', { step_type: 'agent_response', text_delta: 'incomplete' }),
    step('DONE', { step_type: 'agent_response', [field]: field === 'agent_response' ? { text: 'SNAPSHOT' } : 'SNAPSHOT' }),
    agFinal(''),
  ]);
  assert.equal(r.a.finalMessage, 'SNAPSHOT');
  assert.equal(r.a.status, 'idle');
  assert(!r.text.includes('incomplete'));
}
const agAuthoritative = await replay('antigravity', [step('DONE', { step_type: 'agent_response', text_delta: 'COMMENTARY' }), agFinal('ACTUAL')]);
assert.equal(agAuthoritative.a.finalMessage, 'ACTUAL');
const agPartial = await replay('antigravity', [step('ACTIVE', { step_type: 'agent_response', text_delta: 'LATEST' }), agFinal('')]);
assert.equal(agPartial.a.finalMessage, 'LATEST');
assert.equal(agPartial.a.status, 'idle');

const toolFields = { step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'false' } } };
const agError = await replay('antigravity', [
  step('QUEUED', toolFields), step('ACTIVE', toolFields),
  step('ERROR', { step_type: 'tool', error_message: 'denied', tool_info: { output: 'Command exited with code 2.\n\nCommand output:\r\nbad\r\n' } }),
  agFinal('RECOVERED'),
]);
assert.equal(agError.drawn.filter((v) => v.kind === 'command').length, 1);
assert.match(agError.text, /✗ \$ false → exit 2.*\[failed\]\n    │ bad/);
assert.equal(agError.a.status, 'idle');

for (const step_type of ['agent_response', 'unknown']) {
  const r = await replay('antigravity', [step('ERROR', { step_type, error_message: 'step exploded', text: 'PARTIAL' }), agFinal('FAILURE ANSWER', 'ERROR')]);
  assert.equal(r.a.status, 'failed');
  assert.match(r.text, /step exploded/);
  assert.equal(r.a.finalMessage, 'FAILURE ANSWER');
  assert.equal(r.drawn.filter((v) => v.kind === 'final').length, 1);
}
const failedZc = await replay('zcode', [stream('text_delta', 'FAILURE ANSWER'), stream('text_end'), z('turn.failed', { message: 'turn exploded' })], { protocol: true });
assert.equal(failedZc.a.status, 'failed');
assert.equal(failedZc.a.finalMessage, 'FAILURE ANSWER');
assert.equal((failedZc.text.match(/FAILURE ANSWER/g) || []).length, 1);

// Formatter categories and normalized failures, without changing Codex items.
const format = (name, params, info = {}) => describeEngineTool('zcode', name, params, { phase: 'completed', ...info }).text;
assert.match(format('Read', { file_path: '/tmp/a' }), /^✓ 📖 Read \/tmp\/a/);
assert.match(format('Edit', { file_path: '/tmp/a' }), /✎ file changes \[completed\]:\n    update \/tmp\/a/);
assert.match(format('WebSearch', { query: 'hello' }), /^✓ 🌐 web search: hello$/);
assert.match(format('read_url_content', { Url: 'https://example.com' }), /^✓ 🌐 web fetch: https:\/\/example.com$/);
assert.match(format('custom', { x: 1 }, { output: [{ type: 'text', text: 'answer' }] }), /^✓ 🔧 zcode.custom \{"x":1\}\n    │ answer$/);
assert.match(format('Bash', '{"command":"false"}', { exitCode: '1' }), /^✗ \$ false → exit 1.*\[failed\]$/);
assert.match(format('Bash', { command: 'unknown' }), /exit \?/);

// Reproduce the desktop account contract without a real login or network call.
const work = fs.mkdtempSync('/private/tmp/codex-bridge-zcode-runtime-');
const root = path.join(work, '.zcode/v2'), shim = path.join(work, 'bridge/zcode-shim/provider');
fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(shim, { recursive: true });
const family = 'bigmodel', providerId = `account:${family}-individual-coding-plan`;
const release = { schemaVersion: 1, revision: 30, config: { providerConfigRules: { providerRules: [
  { providerId, config: { access: { type: 'zhipu-account', accountType: family, mode: 'individual-coding-plan' } } },
  { providerId: 'account:team', config: { access: { type: 'zhipu-account', accountType: family, mode: 'team-coding-plan' } } },
] } } };
const builtin = path.join(work, 'builtin.json'); fs.writeFileSync(builtin, JSON.stringify(release));
const settingsFile = path.join(root, 'setting.json');
fs.writeFileSync(settingsFile, JSON.stringify({ providerFamilyDomain: family, providerFamilyConnectionSelections: { [family]: { kind: 'individual-coding-plan' } } }));
const secret = 'fixture-secret', credentialFile = path.join(root, 'credentials.json');
const encrypt = (s) => {
  const iv = Buffer.alloc(12, 1), cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const data = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  return `enc:v1:${[iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')}`;
};
fs.writeFileSync(credentialFile, JSON.stringify({
  'oauth:bigmodel:user_info': encrypt(JSON.stringify({ id: 'fixture-user' })),
  'oauth:bigmodel:access_token': encrypt('fixture-oauth'),
  [`account-provider:coding-plan:${providerId}:account:fixture-user:api-key`]: encrypt('fixture-api-key'),
}));
const beforeCredentials = fs.readFileSync(credentialFile, 'utf8'), beforeSettings = fs.readFileSync(settingsFile, 'utf8');
const inherited = { ZCODE_DATA_BASE_DIR: work, ZCODE_APP_VERSION: '3.14.4', ZCODE_CREDENTIAL_SECRET: secret, ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: builtin };
const runtime = zcodeRuntime('fixture.cjs', builtin, work, path.join(work, 'bridge'), inherited);
assert.equal(runtime.env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE, undefined);
assert.equal(runtime.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, path.join(root, 'provider_config.json'));
assert.equal(runtime.env.ZCODE_ENDPOINT_ORIGIN, 'https://zcode.z.ai');
assert(runtime.builtin.startsWith(shim));
const account = zcodeAccounts(runtime);
assert.equal(account.snapshot.states[providerId].current, true);
assert.equal(account.snapshot.states[providerId].entitled, true);
assert.equal(account.snapshot.states['account:team'].entitled, false);
assert(!JSON.stringify(account.snapshot).includes('fixture-api-key'));
const request = { providerId, modelSelection: { providerId, modelId: 'GLM-5.3-Flash' }, accountAccess: { type: 'zhipu-account', accountType: family, mode: 'individual-coding-plan', entitled: true } };
assert.equal(account.requestAuth(request).requestAuth.apiKey, 'fixture-api-key');
assert.throws(() => account.requestAuth({ ...request, providerId: 'account:team' }), /not the active/);
assert.throws(() => zcodeAccounts({ ...runtime, env: { ...runtime.env, ZCODE_CREDENTIAL_SECRET: 'wrong' } }), /ZCODE_CREDENTIAL_DECRYPT_FAILED/);
assert.equal(fs.readFileSync(credentialFile, 'utf8'), beforeCredentials);
assert.equal(fs.readFileSync(settingsFile, 'utf8'), beforeSettings);
const first = { ref: { providerId: 'account:zai', modelId: 'GLM-5.3-Flash' }, label: 'Flash display' };
const active = { ref: { providerId, modelId: 'GLM-5.3-Flash' }, label: 'Flash display' };
const models = { available: [first, active], current: first.ref };
assert.equal(selectZcodeModel('glm-5.3-flash', models, account.snapshot.states), active);
assert.equal(selectZcodeModel('FLASH DISPLAY', models), first);
assert.equal(selectZcodeModel(`${providerId.toUpperCase()}/glm-5.3-flash`, models), active);
assert.equal(selectZcodeModel('glm-5.3-flash', { ...models, current: undefined, lastUsed: active.ref }), active);
assert.throws(() => selectZcodeModel('glm-5.3-flash', { available: models.available }), /Ambiguous/);
assert.throws(() => selectZcodeModel('missing', models), /unavailable/);
// The installed desktop version and endpoint choose the active release; an
// older CLI's compiled 0.0.0-dev must not decide which desktop cache to read.
const app = path.join(work, 'ZCode.app');
fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>3.14.4</string></dict></plist>');
const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${({ arm64: 'aarch64', x64: 'x86_64' })[process.arch] || process.arch}`;
const endpointHash = createHash('sha256').update('https://custom.example').digest('hex').slice(0, 32);
const activeFile = path.join(root, 'runtime/provider', platform, '3.14.4', `endpoint-${endpointHash}`, 'zcode-builtin.json');
fs.mkdirSync(path.dirname(activeFile), { recursive: true });
fs.writeFileSync(activeFile, JSON.stringify({ ...release, revision: 31 }));
const originalRelease = fs.readFileSync(activeFile, 'utf8');
const detected = zcodeRuntime('fixture.cjs', builtin, app, path.join(work, 'bridge'), { ...inherited, ZCODE_APP_VERSION: undefined, ZCODE_ENDPOINT_ORIGIN: 'https://custom.example/path' });
assert.equal(detected.env.ZCODE_APP_VERSION, '3.14.4');
assert.equal(detected.env.ZCODE_ENDPOINT_ORIGIN, 'https://custom.example');
assert.equal(detected.release.revision, 31);
assert.equal(fs.readFileSync(activeFile, 'utf8'), originalRelease);

console.log('PASS: captured Antigravity/ZCode and app-server replay; tool lifecycle deduplication, failure/exit handling, response snapshots, partial output and single final answers; ZCode desktop environment, encrypted read-only accounts, scoped auth and model selection');
