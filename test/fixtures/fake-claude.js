'use strict';
// Stand-in for claude.exe for tests. Makes no network calls.
//
// Terminal mode (default): writes the status file and transcript lines Claude Code would, on a
// fixed schedule: busy (0s) -> waiting: permission prompt (3s) -> busy (9s) -> idle (12s). q exits.
// Point Preferences > Claude Code > Program at this file, with CLAUDE_CONFIG_DIR set to a sandbox.
//
// Stream mode (--input-format stream-json): speaks the same JSON protocol as the real CLI.
// Prompts containing "write" ask permission for Write, "ask" asks a question, "slow" takes 3s
// (and can be interrupted), "delegate" / "delegate slow" / "delegate foreground" start subagents,
// "run slow" runs a shell command reported as a task; anything else is echoed back.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.0.0 (fake Claude Code)');
  process.exit(0);
}
if (args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json') {
  streamMode();
  return;
}
const dir = process.env.CLAUDE_CONFIG_DIR;
if (!dir) {
  console.error('fake-claude: set CLAUDE_CONFIG_DIR to a sandbox folder first.');
  process.exit(2);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const sessionId = flag('--session-id') || flag('--resume') || crypto.randomUUID();
const cwd = process.cwd();
const projectDir = path.join(dir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
const transcript = path.join(projectDir, `${sessionId}.jsonl`);
const record = path.join(dir, 'sessions', `${process.pid}.json`);

function status(s, waitingFor) {
  fs.writeFileSync(record, JSON.stringify({
    pid: process.pid, sessionId, cwd, kind: 'interactive', status: s, waitingFor,
    name: 'fake', nameSource: 'derived', statusUpdatedAt: Date.now(), updatedAt: Date.now(),
  }));
}

function log(o) {
  fs.appendFileSync(transcript, `${JSON.stringify({ sessionId, cwd, gitBranch: 'main', timestamp: new Date().toISOString(), ...o })}\n`);
}

const prompt = args.includes('--') ? args[args.indexOf('--') + 1] : 'Tidy up the build script';
console.log(`fake claude started with: ${JSON.stringify(args)}`);
console.log(`cwd: ${cwd}`);
console.log('press q to exit');
status('busy');
log({ type: 'user', message: { role: 'user', content: prompt } });
setTimeout(() => {
  log({ type: 'assistant', message: { id: 'm1', model: 'claude-fake', content: [{ type: 'text', text: 'Checking `build.ps1` first.' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status' } }] } });
  log({ type: 'ai-title', aiTitle: 'Tidy the build script' });
  status('waiting', 'permission prompt');
}, 3000);
setTimeout(() => status('busy'), 9000);
setTimeout(() => {
  log({ type: 'assistant', message: { id: 'm2', model: 'claude-fake', content: [{ type: 'text', text: 'Done. **The script is tidy.**' }] } });
  status('idle');
}, 12000);

process.on('exit', () => {
  try { fs.unlinkSync(record); } catch { /* already gone */ }
});
process.on('SIGINT', () => {});
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on('data', (d) => { if (String(d).toLowerCase() === 'q') process.exit(0); });
}
setInterval(() => {}, 1000);

// Message shapes copied from what claude.exe 2.1.281 emits in stream-json mode.
function streamMode() {
  const flagValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const sessionId = flagValue('--session-id') || flagValue('--resume') || crypto.randomUUID();
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const waiting = new Map(); // request_id -> resolve
  let cost = 0;
  let n = 0;
  let turn = Promise.resolve();
  let interrupted = null;

  const init = () => out({ type: 'system', subtype: 'init', session_id: sessionId, model: flagValue('--model') || 'claude-fake', permissionMode: flagValue('--permission-mode') || 'default', cwd: process.cwd() });
  const text = (t) => {
    out({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'assistant', message: { id: `msg_${++n}`, role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: t }] }, parent_tool_use_id: null, session_id: sessionId });
  };
  const result = (extra = {}) => {
    cost += 0.01;
    out({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: cost, duration_ms: 5, session_id: sessionId, queued_turn_count: 0, ...extra });
  };
  const ask = (request) => new Promise((resolve) => {
    const id = crypto.randomUUID();
    waiting.set(id, resolve);
    out({ type: 'control_request', request_id: id, request });
  });
  const toolUse = (name, input) => {
    const id = `toolu_${++n}`;
    out({ type: 'assistant', message: { id: `msg_${++n}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null, session_id: sessionId });
    return id;
  };
  const toolResult = (id, content, isError) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError || undefined }] }, parent_tool_use_id: null, session_id: sessionId });

  const stopTask = new Map(); // task_id -> stop()

  // A background subagent, in the message shapes the real CLI uses: system task_* messages, plus
  // the subagent's own tool calls tagged with parent_tool_use_id. "delegate slow" runs ~3s.
  function delegate(prompt) {
    const input = { description: 'Check the build', prompt: 'run the checks', subagent_type: 'general-purpose' };
    const id = toolUse('Agent', input);
    const taskId = `task_${++n}`;
    const sys = (o) => out({ type: 'system', session_id: sessionId, ...o });
    sys({ subtype: 'task_started', task_id: taskId, tool_use_id: id, description: input.description, subagent_type: input.subagent_type, is_backgrounded: true, task_type: 'local_agent', prompt: input.prompt });
    toolResult(id, 'Async agent launched successfully.');
    const sub = (type, content) => out({ type, message: { role: type === 'user' ? 'user' : 'assistant', content }, parent_tool_use_id: id, session_id: sessionId });
    const timers = [];
    let finished = false;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      stopTask.delete(taskId);
      sys({ subtype: 'task_updated', task_id: taskId, patch: { status, end_time: Date.now() } });
      sys({ subtype: 'task_notification', task_id: taskId, tool_use_id: id, status, summary: status === 'completed' ? 'All 12 tests pass.' : '', usage: { total_tokens: 150, tool_uses: 1, duration_ms: 60 } });
    };
    // Stoppable from the moment it starts, like the real CLI.
    stopTask.set(taskId, () => finish('stopped'));
    timers.push(setTimeout(() => {
      sub('assistant', [{ type: 'tool_use', id: 'toolu_sub_1', name: 'Bash', input: { command: 'npm test' } }]);
      sys({ subtype: 'task_progress', task_id: taskId, tool_use_id: id, description: 'Running npm test', usage: { total_tokens: 120, tool_uses: 1, duration_ms: 40 }, last_tool_name: 'Bash' });
      sub('user', [{ type: 'tool_result', tool_use_id: 'toolu_sub_1', content: '12 passing' }]);
      if (!/slow/i.test(prompt)) finish('completed');
    }, 50));
    if (/slow/i.test(prompt)) timers.push(setTimeout(() => finish('completed'), 3000));
    text('Started a helper to check the build.');
    return result();
  }

  // A foreground subagent: Claude waits for it, and (like the real CLI) its own messages never
  // reach stdout. They go only to its transcript, <config>/projects/<project>/<session>/subagents/
  // agent-<task id>.jsonl, one step every 300ms, with token usage on each assistant record.
  async function delegateForeground() {
    const input = { description: 'Review the code', prompt: 'review src', subagent_type: 'code-reviewer', run_in_background: false };
    const id = toolUse('Agent', input);
    const taskId = `a${crypto.randomBytes(8).toString('hex')}`;
    const sys = (o) => out({ type: 'system', session_id: sessionId, ...o });
    const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), sessionId, 'subagents', `agent-${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec = (o) => fs.appendFileSync(file, `${JSON.stringify({ isSidechain: true, agentId: taskId, sessionId, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), ...o })}\n`);
    const usage = (inTok, outTok) => ({ input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 });
    sys({ subtype: 'task_started', task_id: taskId, tool_use_id: id, description: input.description, subagent_type: input.subagent_type, is_backgrounded: false, task_type: 'local_agent', prompt: input.prompt });
    rec({ type: 'user', message: { role: 'user', content: input.prompt } });
    const pause = () => new Promise((r) => setTimeout(r, 300));
    await pause();
    // One API message split over two records sharing an id, as the real CLI writes them.
    rec({ type: 'assistant', message: { id: 'msg_sub_1', model: 'claude-fake-sub', role: 'assistant', content: [{ type: 'text', text: 'Reading the source.' }], usage: usage(100, 5) } });
    rec({ type: 'assistant', message: { id: 'msg_sub_1', model: 'claude-fake-sub', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fg_1', name: 'Grep', input: { pattern: 'TODO' } }], usage: usage(100, 20) } });
    await pause();
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fg_1', content: '3 matches' }] } });
    sys({ subtype: 'task_progress', task_id: taskId, tool_use_id: id, description: 'Searching for TODO', usage: { total_tokens: 1120, tool_uses: 1, duration_ms: 600 }, last_tool_name: 'Grep' });
    await pause();
    rec({ type: 'assistant', message: { id: 'msg_sub_2', model: 'claude-fake-sub', role: 'assistant', content: [{ type: 'text', text: 'Found 3 TODOs.' }], usage: usage(150, 30) } });
    await pause();
    sys({ subtype: 'task_updated', task_id: taskId, patch: { status: 'completed', end_time: Date.now() } });
    sys({ subtype: 'task_notification', task_id: taskId, tool_use_id: id, status: 'completed', summary: 'Found 3 TODOs.', usage: { total_tokens: 2300, tool_uses: 1, duration_ms: 1200 } });
    toolResult(id, 'Found 3 TODOs.');
    text('The review found 3 TODOs.');
    return result();
  }

  async function handle(prompt, images) {
    init();
    if (images.length) {
      text(`Saw ${images.length} image${images.length === 1 ? '' : 's'} (${images.join(', ')})${prompt.trim() ? ` with: ${prompt.trim()}` : ''}.`);
      return result();
    }
    if (/delegate foreground/i.test(prompt)) return delegateForeground();
    if (/delegate/i.test(prompt)) return delegate(prompt);
    // A shell command slow enough that the real CLI reports it as a task (task_type local_bash).
    if (/run slow/i.test(prompt)) {
      const id = toolUse('Bash', { command: 'sleep 3', description: 'Wait a bit' });
      out({ type: 'system', session_id: sessionId, subtype: 'task_started', task_id: 'bash_1', tool_use_id: id, description: 'Wait a bit', is_backgrounded: false, task_type: 'local_bash' });
      out({ type: 'system', session_id: sessionId, subtype: 'task_notification', task_id: 'bash_1', tool_use_id: id, status: 'completed', output_file: '', summary: 'Wait a bit' });
      toolResult(id, '');
      text('Waited.');
      return result();
    }
    if (/write/i.test(prompt)) {
      const input = { file_path: path.join(process.cwd(), 'fake.txt'), content: 'hi\n' };
      const id = toolUse('Write', input);
      const r = await ask({ subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input, description: 'fake.txt', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], tool_use_id: id });
      if (r.behavior === 'allow') toolResult(id, `File created successfully${r.updatedPermissions ? ' (rule saved)' : ''}`);
      else toolResult(id, r.message, true);
      text(r.behavior === 'allow' ? 'Wrote the file.' : 'Okay, I will not write it.');
      return result();
    }
    if (/ask/i.test(prompt)) {
      const input = { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }], multiSelect: false }] };
      const id = toolUse('AskUserQuestion', input);
      const r = await ask({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input, tool_use_id: id, requires_user_interaction: true });
      toolResult(id, r.behavior === 'allow' ? `answers=${JSON.stringify(r.updatedInput.answers)}` : r.message, r.behavior !== 'allow');
      text(r.behavior === 'allow' ? `You picked ${Object.values(r.updatedInput.answers).join(', ')}.` : 'No answer.');
      return result();
    }
    if (/slow/i.test(prompt)) {
      const stopped = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        interrupted = () => { clearTimeout(timer); resolve(true); };
      });
      interrupted = null;
      if (stopped) {
        out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, session_id: sessionId });
        return result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' });
      }
      text('Slow reply done.');
      return result();
    }
    text(`Echo: ${prompt}`);
    return result();
  }

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type === 'control_request') {
        const sub = m.request.subtype;
        if (sub === 'interrupt' && interrupted) interrupted();
        if (sub === 'stop_task' && stopTask.has(m.request.task_id)) stopTask.get(m.request.task_id)();
        let response = sub === 'initialize' ? { commands: [{ name: 'compact', description: 'Summarize the conversation', argumentHint: '' }] } : {};
        // Like the real CLI (2.1.281): rewinding needs checkpointing turned on by env var. The
        // file named by FAKE_REWIND_FILE stands in for a file the turn created; rewinding deletes it.
        if (sub === 'rewind_files') {
          const target = process.env.FAKE_REWIND_FILE;
          if (process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING !== '1') response = { canRewind: false, error: 'File rewinding is not enabled.' };
          else if (m.request.dry_run) response = { canRewind: true, filesChanged: target && fs.existsSync(target) ? [target] : [], insertions: 0, deletions: 1 };
          else {
            if (target) fs.rmSync(target, { force: true });
            response = { canRewind: true, skippedLinks: [] };
          }
        }
        // Like the real CLI: no system/init until the first user message arrives.
        out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
      } else if (m.type === 'control_response') {
        const resolve = waiting.get(m.response.request_id);
        if (resolve) {
          waiting.delete(m.response.request_id);
          resolve(m.response.response);
        }
      } else if (m.type === 'user') {
        const content = m.message.content;
        const prompt = typeof content === 'string' ? content : content.map((b) => b.text || '').join(' ');
        const images = Array.isArray(content) ? content.filter((b) => b.type === 'image').map((b) => b.source.media_type) : [];
        // command_lifecycle, keyed by the message's uuid: queued on arrival, started when its
        // turn begins, completed after its result (as the real CLI reports it).
        const lifecycle = (state) => { if (m.uuid) out({ type: 'command_lifecycle', command_uuid: m.uuid, state, session_id: sessionId }); };
        lifecycle('queued');
        turn = turn.then(async () => { lifecycle('started'); await handle(prompt, images); lifecycle('completed'); });
      }
    }
  });
  process.stdin.on('end', () => turn.then(() => process.exit(0)));
}
