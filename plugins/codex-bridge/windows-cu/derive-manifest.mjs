// Derives a Desktop-independent cua_repl launch spec for the Windows relay from
// the Desktop-generated plugin manifest, following the Desktop's own rule
// (cua_repl = node_repl env + cua-repl.mjs) but:
//   - runtime paths are rebased onto the newest installed cua_node runtime,
//   - a missing CODEX_CLI_PATH is rebased onto the current Codex bin,
//   - the Desktop-instance native pipe is dropped (the relay hosts its own),
//   - surfaces are limited to `computer`, and the Desktop's trusted-service map
//     (written for its own surfaces) is dropped so cua-repl derives it from them,
//   - `cuRelay.pipeHost` names the runtime's Windows helper and its transport
//     module, which the relay's native-pipe host runs outside the sandbox.
// The user's Codex config and plugin cache are not modified. Values never leave
// this machine; stdout reports only key names, categories and existence checks.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    'plugin-dir': { type: 'string' },
    'runtimes-dir': { type: 'string' },
    'codex-bin-dir': { type: 'string' },
    out: { type: 'string' },
    server: { type: 'string', default: 'cua_repl' },
    'node-repl-exe': { type: 'string', default: path.join('bin', 'node_repl.exe') },
    'codex-exe': { type: 'string', default: 'codex.exe' },
    'sky-dir': { type: 'string', default: path.join('bin', 'node_modules', '@oai', 'sky') },
  },
});
for (const k of ['plugin-dir', 'runtimes-dir', 'codex-bin-dir', 'out']) if (!opt[k]) throw new Error(`--${k} is required`);

const DROPPED = ['SKY_CUA_NATIVE_PIPE', 'SKY_CUA_NATIVE_PIPE_DIRECTORY', 'NODE_REPL_TRUSTED_SERVICES'];
const byVersionDesc = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};
const dirs = (p) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const newestBy = (root, names, rel) => names
  .map((n) => ({ n, p: path.join(root, n) }))
  .filter((r) => existsSync(path.join(r.p, rel)))
  .sort((a, b) => statSync(b.p).mtimeMs - statSync(a.p).mtimeMs)[0];

const pluginVersion = dirs(opt['plugin-dir']).sort(byVersionDesc)[0];
if (!pluginVersion) throw new Error('no plugin version directory');
const spec = JSON.parse(readFileSync(path.join(opt['plugin-dir'], pluginVersion, '.mcp.json'), 'utf8').replace(/^﻿/, '')).mcpServers?.[opt.server];
if (!spec?.command) throw new Error(`plugin ${pluginVersion} has no ${opt.server} command`);

const runtime = newestBy(opt['runtimes-dir'], dirs(opt['runtimes-dir']), opt['node-repl-exe']);
if (!runtime) throw new Error('no installed cua_node runtime with node_repl');
const codexBin = newestBy(opt['codex-bin-dir'], dirs(opt['codex-bin-dir']), opt['codex-exe']);

const escaped = opt['runtimes-dir'].replace(/[\\/]+$/, '').split(/[\\/]+/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
const runtimeRe = new RegExp(`${escaped}[\\\\/]+[0-9a-f]{8,}`, 'gi');
const rebase = (v) => (typeof v === 'string' ? v.replace(runtimeRe, runtime.p) : v);

const report = { pluginVersion, runtime: runtime.n, rebasedKeys: [], droppedKeys: [], codexCliRebased: false };
const command = rebase(spec.command);
if (command !== spec.command) report.rebasedKeys.push('command');
const args = (spec.args ?? []).map((a, i) => { const r = rebase(a); if (r !== a) report.rebasedKeys.push(`args[${i}]`); return r; });
const env = {};
for (const [k, v] of Object.entries(spec.env ?? {})) {
  if (DROPPED.includes(k)) { report.droppedKeys.push(k); continue; }
  const r = rebase(v);
  if (r !== v) report.rebasedKeys.push(`env.${k}`);
  env[k] = r;
}
if (env.CODEX_CLI_PATH && !existsSync(env.CODEX_CLI_PATH) && codexBin) {
  env.CODEX_CLI_PATH = path.join(codexBin.p, opt['codex-exe']);
  report.codexCliRebased = true;
}
env.CUA_REPL_ENABLED_SURFACES = 'computer';
report.surfaces = env.CUA_REPL_ENABLED_SURFACES;

const isAbs = (v) => (process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(v) : v.startsWith('/'));
const asPath = (v) => {
  if (typeof v !== 'string') return null;
  if (v.startsWith('file:')) { try { return fileURLToPath(v); } catch { return null; } }
  return isAbs(v) ? v : null;
};
const missing = [];
if (!existsSync(command)) missing.push('command');
args.forEach((a, i) => { const p = asPath(a); if (p && !existsSync(p)) missing.push(`args[${i}]`); });
for (const [k, v] of Object.entries(env)) {
  if (typeof v !== 'string' || !isAbs(v)) continue;
  for (const part of v.split(';').filter(Boolean)) if (!existsSync(part)) { missing.push(`env.${k}`); break; }
}
const skyDir = path.join(runtime.p, opt['sky-dir']);
const pipeHost = {
  helperPath: path.join(skyDir, 'bin', 'windows', process.arch === 'arm64' ? 'codex-computer-use-arm64.exe' : 'codex-computer-use.exe'),
  transportModulePath: path.join(skyDir, 'dist', 'project', 'cua', 'sky_js', 'src', 'targets', 'windows', 'internal', 'helper_transport.js'),
};
for (const [k, v] of Object.entries(pipeHost)) if (!existsSync(v)) missing.push(`cuRelay.pipeHost.${k}`);
report.missing = missing;
report.envKeys = Object.keys(env).length;
if (missing.length) {
  console.log(JSON.stringify({ ok: false, ...report }));
  process.exit(1);
}
writeFileSync(opt.out, JSON.stringify({ mcpServers: { [opt.server]: { command, args, env, ...(spec.cwd ? { cwd: spec.cwd } : {}) } }, cuRelay: { pipeHost } }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ok: true, out: opt.out, ...report }));
