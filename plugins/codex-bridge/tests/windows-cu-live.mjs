// Live, read-only acceptance for Windows Computer Use against the configured PC
// (~/.codex-bridge/windows-cu.json). Starts the relay if needed, lists windows, binds
// one window of --app and takes a screenshot (no clicks or typing), then stops the
// relay unless --keep. Uses no model. Screenshots go to --out (0600) when given.
// Usage: node tests/windows-cu-live.mjs [--app "DeepSeek Harness"] [--out DIR] [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WindowsComputerUse } from '../server/windows-cu.mjs';

const { values: opt } = parseArgs({ options: { app: { type: 'string', default: 'DeepSeek Harness' }, out: { type: 'string' }, keep: { type: 'boolean', default: false } } });
const w = new WindowsComputerUse({ log: (m) => console.error(`[log] ${m}`) });
const summary = { app: opt.app, steps: [] };
const textOf = (r) => (r.result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const pick = (s) => (s && typeof s === 'object' ? JSON.parse(JSON.stringify(s, (k, v) => (['dir', 'exe', 'out'].includes(k) ? undefined : v))) : s);
async function step(name, fn) {
  const t = Date.now();
  try {
    const value = await fn();
    summary.steps.push({ name, ms: Date.now() - t, ok: true, ...value });
  } catch (e) {
    summary.steps.push({ name, ms: Date.now() - t, ok: false, error: e.message });
    throw e;
  }
}

try {
  await step('status-before', async () => ({ status: pick(await w.status()) }));
  let target = null;
  await step('list-windows', async () => {
    const r = await w.run('var wins = await cua.listWindows({ emit: false }); nodeRepl.write(JSON.stringify(wins.map((x) => ({ id: x.id, app: x.app, title: x.title }))));');
    const wins = JSON.parse(textOf(r).trim().split('\n').at(-1));
    // On Windows `app` is a process path; the approval prompt uses the display name.
    target = wins.filter((x) => `${x.app} ${x.title ?? ''}`.toLowerCase().includes(opt.app.toLowerCase()));
    return { started: pick(r.started), windows: wins.length, apps: [...new Set(wins.map((x) => x.app))], matches: target.length, isError: !!r.result.isError };
  });
  if (target.length !== 1) throw new Error(`expected exactly one "${opt.app}" window, found ${target.length}`);
  await step('get-app-and-screenshot', async () => {
    const r = await w.run(`var app = await cua.getApp({ windowId: ${Number(target[0].id)} }); var shots = await app.getScreenshot();`, { allowApps: [opt.app] });
    const images = (r.result.content ?? []).filter((c) => c.type === 'image');
    if (opt.out) {
      fs.mkdirSync(opt.out, { recursive: true, mode: 0o700 });
      images.forEach((img, i) => fs.writeFileSync(path.join(opt.out, `window-${i + 1}.${img.mimeType === 'image/png' ? 'png' : 'jpg'}`), Buffer.from(img.data, 'base64'), { mode: 0o600 }));
    }
    const sizes = images.map((img) => { const b = Buffer.from(img.data, 'base64'); return b.length > 24 && img.mimeType === 'image/png' ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : img.mimeType; });
    return { isError: !!r.result.isError, approvals: r.approvals, images: sizes, textChars: textOf(r).length };
  });
  await step('ax-state-again', async () => {
    const r = await w.run('var ax = await app.getAXState({ emit: false }); nodeRepl.write(String(ax.length));', { allowApps: [opt.app] });
    return { isError: !!r.result.isError, approvals: r.approvals, axChars: Number(textOf(r).trim().split('\n').at(-1)) };
  });
} catch (e) {
  summary.error = e.message;
} finally {
  if (!opt.keep) {
    try { summary.stop = pick(await w.stop()); } catch (e) { summary.stopError = e.message; }
  } else w.close();
  console.log(JSON.stringify(summary, null, 1));
  process.exitCode = summary.error || summary.stopError || (summary.stop && !summary.stop.ok) ? 1 : 0;
}
