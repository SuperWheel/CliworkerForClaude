// Computer-use via a Codex agent turn. Read-only: lists Finder window titles.
// Prints any approval request and accepts ONLY app-access elicitations.
import { AgentManager } from '../server/agent-manager.mjs';
const mgr = new AgentManager({ log: (m) => console.error('[log]', m) });
mgr.on('event', (a, ev) => console.log(`[${a.id}] ${ev.text}`));
const a = mgr.spawn({ name: 'cu-finder', computer_use: true, effort: 'low', sandbox: 'read-only',
  prompt: 'Using Computer Use, read the Finder app state and report the titles of open Finder windows (or say none). Read only: do not click, type, or change anything.' });
const t0 = Date.now();
while (Date.now() - t0 < 240_000) {
  await mgr.wait([a.id], { timeoutSec: 30 });
  if (a.status === 'needs_input') {
    for (const r of [...a.pending.values()]) {
      console.log('PENDING', r.method, JSON.stringify(r.params).slice(0, 800));
      mgr.respond(a.id, r.reqId, r.method === 'mcpServer/elicitation/request' ? 'accept' : 'decline');
    }
  } else if (mgr.isSettled(a)) break;
}
console.log('FINAL STATUS', a.status, '\n', a.finalMessage);
mgr.shutdown();
