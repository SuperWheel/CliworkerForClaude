// SIMULATED (模拟) stand-in for sky's WindowsHelperTransport, for offline tests only.
// Records what the pipe host asks of the helper in $FAKE_TRANSPORT_LOG.
import { appendFileSync } from 'node:fs';

const rec = (e) => appendFileSync(process.env.FAKE_TRANSPORT_LOG, JSON.stringify(e) + '\n');

export class WindowsHelperTransport {
  constructor(o) {
    rec({ event: 'construct', helperArgs: o.helperArgs, helperEnvKeys: Object.keys(o.helperEnv ?? {}).sort() });
  }

  async request(method, params, opts = {}) {
    rec({ event: 'request', method, hasElicitation: typeof opts.createElicitation === 'function', turn: opts.codexTurnMetadata ?? null });
    if (method === 'list_windows') return [{ id: 7, app: 'Simulated App', title: 'SIMULATED window' }];
    if (method === 'slow') { await new Promise((r) => setTimeout(r, 300)); return 'slow-done'; }
    if (method === 'end_turn') return 'ended';
    if (method === 'get_app_state') {
      const answer = await opts.createElicitation({ message: 'Allow Codex to use Simulated App?', requestedSchema: { type: 'object', properties: {} }, _meta: { persist: ['session', 'always'] } });
      if (answer?.action !== 'accept') throw new Error('Computer Use was not approved to use Simulated App');
      return { state: 'SIMULATED app state', persist: answer._meta?.persist ?? null };
    }
    throw new Error(`SIMULATED unknown method ${method}`);
  }

  async close() {
    rec({ event: 'close' });
  }
}
