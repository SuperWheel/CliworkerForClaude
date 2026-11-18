// Stdio side of the Windows Computer Use relay. Runs under SSH (session 0),
// authenticates to the loopback relay in the interactive session, then passes MCP
// bytes through unchanged, except that client messages lose Codex's sandbox state
// (see dropSandboxMeta). The relay's one-line status is consumed here, never
// forwarded. With --stop it asks the relay to shut down instead.
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

// A Codex agent attaches its own sandbox state (Mac paths such as sandboxCwd
// file:///Users/…) to every tool call; node_repl on Windows rejects those paths and
// runs nothing. Dropping it leaves node_repl on its own default sandbox, as for direct
// codex_computer_use calls, which never send it. Other _meta keys pass through.
const SANDBOX_META = 'codex/sandbox-state-meta';
function dropSandboxMeta(line) {
  if (!line.includes(SANDBOX_META)) return line;
  let msg;
  try { msg = JSON.parse(line); } catch { return line; }
  const meta = msg?.params?._meta;
  if (!meta || typeof meta !== 'object' || !(SANDBOX_META in meta)) return line;
  delete meta[SANDBOX_META];
  if (!Object.keys(meta).length) delete msg.params._meta;
  return JSON.stringify(msg);
}

// MCP stdio is newline-delimited JSON; whole lines are rewritten, partial ones wait.
function clientMessages() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return new Transform({
    transform(chunk, _encoding, done) {
      pending += decoder.write(chunk);
      const end = pending.lastIndexOf('\n');
      if (end < 0) return done();
      const lines = pending.slice(0, end).split('\n');
      pending = pending.slice(end + 1);
      done(null, lines.map(dropSandboxMeta).join('\n') + '\n');
    },
    flush(done) {
      pending += decoder.end();
      done(null, pending ? dropSandboxMeta(pending) : undefined);
    },
  });
}

const [port, tokenFile, flag] = process.argv.slice(2);
if (!port || !tokenFile || (flag && flag !== '--stop')) {
  process.stderr.write('usage: connect.mjs PORT TOKEN_FILE [--stop]\n');
  process.exit(2);
}
const stop = flag === '--stop';
const token = readFileSync(tokenFile, 'utf8').trim();
const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
socket.setNoDelay(true);
let ready = false;
let head = Buffer.alloc(0);

const forward = (data) => {
  if (!process.stdout.write(data)) {
    socket.pause();
    process.stdout.once('drain', () => socket.resume());
  }
};

socket.on('connect', () => socket.write(JSON.stringify(stop ? { auth: token, op: 'stop' } : { auth: token }) + '\n'));
socket.on('data', (chunk) => {
  if (ready) return forward(chunk);
  head = Buffer.concat([head, chunk]);
  const nl = head.indexOf(10);
  if (nl < 0) return;
  let status = {};
  try { status = JSON.parse(head.subarray(0, nl).toString('utf8')); } catch {}
  if (stop) {
    process.stdout.write(JSON.stringify(status) + '\n');
    process.exit(status.cuRelay === 'stopping' ? 0 : 3);
  }
  if (status.cuRelay !== 'ready') {
    process.stderr.write(`relay refused: ${status.cuRelay ?? 'unknown'}\n`);
    process.exit(3);
  }
  process.stderr.write(`relay ready childPid=${status.childPid}\n`);
  ready = true;
  const rest = head.subarray(nl + 1);
  if (rest.length) forward(rest);
  process.stdin.pipe(clientMessages()).pipe(socket);
});
if (!stop) process.stdin.on('end', () => socket.end());
socket.on('error', (e) => { process.stderr.write(`relay connection error: ${e.code}\n`); process.exit(4); });
socket.on('close', () => process.exit(ready ? 0 : 3));
