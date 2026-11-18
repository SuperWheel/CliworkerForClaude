// Turns app-server items/notifications into compact transcript events
// that read well inside a Claude sub-agent's tool results.

export function clip(s, max = 1200) {
  if (s == null) return '';
  s = String(s);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.35);
  return `${s.slice(0, head)}\n…[${s.length - max} chars omitted]…\n${s.slice(s.length - (max - head))}`;
}

function tail(s, lines = 12, max = 900) {
  if (!s) return '';
  const arr = String(s).trimEnd().split('\n');
  const t = arr.slice(-lines).join('\n');
  return (arr.length > lines ? `…(${arr.length - lines} earlier lines)\n` : '') + clip(t, max);
}

function indent(s, pad = '    │ ') {
  return String(s).split('\n').map((l) => pad + l).join('\n');
}

function diffStats(diff) {
  let add = 0, del = 0;
  for (const l of String(diff || '').split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return `+${add} −${del}`;
}

function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : c?.type ? `[${c.type}]` : ''))
    .filter(Boolean)
    .join('\n');
}

// Returns {kind, text} or null when the item is not worth showing.
export function describeItem(item, phase /* 'started' | 'completed' */) {
  if (!item) return null;
  switch (item.type) {
    case 'userMessage':
      return null;
    case 'agentMessage':
      if (phase !== 'completed' || !item.text) return null;
      return {
        kind: item.phase === 'final_answer' ? 'final' : 'message',
        text: `💬 codex${item.phase === 'final_answer' ? ' (final)' : ''}:\n${indent(clip(item.text, 6000), '    ')}`,
      };
    case 'reasoning': {
      if (phase !== 'completed') return null;
      const sum = (item.summary || []).join('\n').trim();
      if (!sum) return null;
      return { kind: 'reasoning', text: `🧠 ${clip(sum, 800)}` };
    }
    case 'plan':
      if (phase !== 'completed' || !item.text) return null;
      return { kind: 'plan', text: `📋 plan:\n${indent(clip(item.text, 1500), '    ')}` };
    case 'commandExecution': {
      const cmd = clip(item.command, 300);
      if (phase === 'started') return { kind: 'command_start', text: `$ ${cmd}` };
      const ok = item.exitCode === 0;
      const dur = item.durationMs != null ? ` ${(item.durationMs / 1000).toFixed(1)}s` : '';
      const short = clip(String(item.command).split('\n')[0], 100);
      const head = `${ok ? '✓' : '✗'} $ ${short} → exit ${item.exitCode ?? '?'}${dur} [${item.status}]`;
      const out = tail(item.aggregatedOutput, ok ? 6 : 14);
      return { kind: 'command', text: out ? `${head}\n${indent(out)}` : head };
    }
    case 'fileChange': {
      if (phase !== 'completed') return null;
      const lines = (item.changes || []).map((c) => `    ${c.kind?.type ?? c.kind ?? 'edit'} ${c.path} (${diffStats(c.diff)})`);
      return { kind: 'file_change', text: `✎ file changes [${item.status}]:\n${lines.join('\n')}` };
    }
    case 'mcpToolCall': {
      const name = `${item.server}.${item.tool}`;
      if (phase === 'started') {
        const args = item.arguments ? clip(typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments), 500) : '';
        return { kind: 'tool_start', text: `🔧 ${name} ${args}` };
      }
      const res = item.error ? `error: ${item.error.message}` : clip(textOfContent(item.result?.content), 700);
      const dur = item.durationMs != null ? ` ${(item.durationMs / 1000).toFixed(1)}s` : '';
      return { kind: 'tool', text: `${item.error ? '✗' : '✓'} 🔧 ${name}${dur}${res ? `\n${indent(res)}` : ''}` };
    }
    case 'dynamicToolCall':
      if (phase !== 'completed') return null;
      return { kind: 'tool', text: `🔧 ${item.namespace ? item.namespace + '.' : ''}${item.tool} [${item.status}]` };
    case 'collabAgentToolCall':
      if (phase !== 'completed') return null;
      return {
        kind: 'subagent',
        text: `🤝 codex sub-agent ${item.tool} → ${(item.receiverThreadIds || []).map((t) => t.slice(-8)).join(', ') || '-'}${item.prompt ? `: ${clip(item.prompt, 300)}` : ''}`,
      };
    case 'subAgentActivity':
      if (phase !== 'completed') return null;
      return { kind: 'subagent', text: `🤝 codex sub-agent ${item.agentPath ?? ''} ${item.kind ?? ''}` };
    case 'webSearch': {
      if (phase !== 'completed') return null;
      const a = item.action || {};
      const q = a.query || (a.queries || []).join(' | ') || a.url || item.query || '';
      return { kind: 'web', text: `🌐 web ${a.type ?? 'search'}: ${clip(q, 300)}` };
    }
    case 'imageView':
      return phase === 'completed' ? { kind: 'image', text: `🖼  viewed image ${item.path}` } : null;
    case 'imageGeneration':
      return phase === 'completed' ? { kind: 'image', text: `🎨 generated image ${item.savedPath ?? item.path ?? ''}` } : null;
    case 'contextCompaction':
      return phase === 'completed' ? { kind: 'info', text: '🗜  context compacted' } : null;
    case 'enteredReviewMode':
      return phase === 'completed' ? { kind: 'info', text: '🔍 entered review mode' } : null;
    case 'exitedReviewMode':
      return phase === 'completed' ? { kind: 'final', text: `🔍 review result:\n${indent(clip(item.review ?? '', 8000), '    ')}` } : null;
    case 'hookPrompt':
    case 'functionCallOutput':
    case 'sleep':
      return null;
    default:
      return phase === 'completed' ? { kind: 'info', text: `• ${item.type}` } : null;
  }
}

export function describeRequest(method, params) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return `run command \`${clip(params.command ?? '', 400)}\`${params.cwd ? ` in ${params.cwd}` : ''}${params.reason ? ` — reason: ${params.reason}` : ''}`;
    case 'item/fileChange/requestApproval':
      return `apply file changes${params.grantRoot ? ` (grant write to ${params.grantRoot})` : ''}${params.reason ? ` — reason: ${params.reason}` : ''}`;
    case 'item/permissions/requestApproval':
      return `grant extra permissions ${JSON.stringify(params.permissions)}${params.reason ? ` — reason: ${params.reason}` : ''}`;
    case 'mcpServer/elicitation/request':
      return `MCP server "${params.serverName}" asks: ${clip(params.message ?? '', 600)}${params.url ? ` (url: ${params.url})` : ''}`;
    case 'item/tool/requestUserInput':
      return 'question(s) for you:\n' + (params.questions || []).map((q) =>
        `    [${q.id}] ${q.header ? q.header + ': ' : ''}${q.question}${q.options?.length ? `  options: ${q.options.map((o) => o.label).join(' / ')}` : ''}`,
      ).join('\n');
    default:
      return `${method} ${clip(JSON.stringify(params), 400)}`;
  }
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

// Antigravity / ZCode tool calls, drawn with the same marks as Codex items.
const TOOL_CLASS = {
  command: ['run_command', 'send_command_input', 'Bash', 'BashOutput'],
  edit: ['write_to_file', 'write_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  read: ['view_file', 'list_dir', 'grep_search', 'find_by_name', 'Read', 'Grep', 'Glob', 'LS'],
  web: ['search_web', 'read_url_content', 'WebSearch', 'WebFetch'],
};
const CREATES = new Set(['write_to_file', 'write_file', 'Write']);

function firstArg(p, keys) {
  for (const k of keys) if (p?.[k] != null && p[k] !== '') return String(p[k]);
  return '';
}

function classify(name) {
  for (const [k, list] of Object.entries(TOOL_CLASS)) if (list.includes(name)) return k;
  return 'other';
}

// phase: 'started' | 'completed'. Returns {kind, text} or null.
export function describeEngineTool(engine, name, params = {}, { phase, ok = true, output = '', exitCode, durationMs } = {}) {
  // Some transports serialize arguments and return MCP-style content blocks.
  if (typeof params === 'string') {
    try { params = JSON.parse(params); } catch { params = { input: params }; }
  }
  if (exitCode != null) ok = ok && Number(exitCode) === 0;
  const dur = durationMs != null ? ` ${(durationMs / 1000).toFixed(1)}s` : '';
  const mark = ok ? '✓' : '✗';
  const out = typeof output === 'string' ? output : output == null ? '' : Array.isArray(output) ? textOfContent(output) : output.message || JSON.stringify(output);
  const failure = !ok && out ? `\n${indent(tail(out, 8))}` : '';
  switch (classify(name)) {
    case 'command': {
      const cmd = firstArg(params, ['CommandLine', 'command', 'Input', 'cmd']);
      if (phase === 'started') return { kind: 'command_start', text: `$ ${clip(cmd, 300)}` };
      const head = `${mark} $ ${clip(cmd.split('\n')[0], 100)} → exit ${exitCode ?? '?'}${dur} [${ok ? 'completed' : 'failed'}]`;
      const body = tail(out, ok ? 6 : 14);
      return { kind: 'command', text: body ? `${head}\n${indent(body)}` : head };
    }
    case 'edit': {
      if (phase === 'started') return null;
      const file = firstArg(params, ['TargetFile', 'Path', 'file_path', 'notebook_path', 'AbsolutePath', 'path']);
      return { kind: 'file_change', text: `✎ file changes [${ok ? 'completed' : 'failed'}]:\n    ${CREATES.has(name) ? 'add' : 'update'} ${file}${failure}` };
    }
    case 'read': {
      if (phase === 'started') return null;
      const what = firstArg(params, ['AbsolutePath', 'file_path', 'DirectoryPath', 'path', 'Pattern', 'pattern', 'Query', 'SearchPath']);
      return { kind: 'tool', text: `${mark} 📖 ${name} ${clip(what, 200)}${dur}${failure}` };
    }
    case 'web': {
      if (phase === 'started') return null;
      const q = firstArg(params, ['query', 'Query', 'url', 'Url', 'URL']);
      return { kind: 'web', text: `${mark} 🌐 web ${/search/i.test(name) ? 'search' : 'fetch'}: ${clip(q, 300)}${failure}` };
    }
    default: {
      if (phase === 'started') return null;
      const args = Object.keys(params || {}).length ? ` ${clip(JSON.stringify(params), 300)}` : '';
      const res = clip(out, 700);
      return { kind: 'tool', text: `${mark} 🔧 ${engine}.${name}${dur}${args}${res ? `\n${indent(res)}` : ''}` };
    }
  }
}
