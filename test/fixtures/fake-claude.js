'use strict';
// Stand-in for claude.exe for tests. Makes no network calls.
//
// Terminal mode (default): writes the status file and transcript lines Claude Code would, on a
// fixed schedule: busy (0s) -> waiting: permission prompt (3s) -> busy (9s) -> idle (12s). q exits.
// Point Claude Deck Preferences > Claude Code > Program at this file, with CLAUDE_CONFIG_DIR set to a sandbox.
//
// Stream mode (--input-format stream-json): speaks the same JSON protocol as the real CLI.
// Prompts containing "write" ask permission for Write, "ask" asks a question, "slow" takes 3s
// (and can be interrupted), "delegate" / "delegate slow" / "delegate foreground" start subagents,
// "run slow" runs a shell command reported as a task, "which effort" reports the effort level;
// "/clear", "/compact" and "/config" behave like the real local commands; anything else is echoed back.
// Answers reload_plugins from the plugin state below, get_context_usage, and the MCP requests
// (mcp_status, mcp_toggle, mcp_reconnect) for two made-up servers.
//
// Plugin mode (plugin ...): Claude Code's plugin and marketplace commands (see pluginMode).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// initialize's `models`, shaped like the real CLI's (2.1.284), fields trimmed.
const FAKE_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
];

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.0.0 (fake Claude Code)');
  process.exit(0);
}
if (args[0] === 'plugin') {
  pluginMode();
  return;
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
  // For the terminal-in-the-window tests: says when the console is resized, and to what.
  process.stdout.on('resize', () => console.log(`size: ${process.stdout.columns}x${process.stdout.rows}`));
}
setInterval(() => {}, 1000);

// Message shapes copied from what claude.exe 2.1.281 emits in stream-json mode.
function streamMode() {
  const flagValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  // /clear starts a new conversation with a new id, as the real CLI does.
  let sessionId = flagValue('--session-id') || flagValue('--resume') || crypto.randomUUID();
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const waiting = new Map(); // request_id -> resolve
  let cost = 0;
  // Running token totals (modelUsage) and the context size, both reset by /clear. Each turn uses
  // 100 input, 20 output and 1000 cache-read tokens, and adds 1000 tokens of context.
  let tokens = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let context = 5000;
  let n = 0;
  let turn = Promise.resolve();
  let interrupted = null;
  let effort = flagValue('--effort');
  // The plugins this session loaded, as the real CLI keeps them until a reload.
  let sessionPlugins = enabledPlugins(loadPluginState());
  // MCP servers, shaped like the real CLI's mcp_status (2.1.284). docs connects; broken never does.
  const docsTools = [{ name: 'search', annotations: {} }, { name: 'read_page', annotations: {} }];
  const mcpServers = [
    { name: 'docs', status: 'connected', serverInfo: { name: 'docs-server', version: '1.0.0' }, config: { type: 'stdio', command: 'node', args: ['docs.js'], env: { DOCS_TOKEN: 'not-for-the-page' } }, scope: 'user', source: 'user', tools: docsTools },
    { name: 'broken', status: 'failed', error: 'Connection closed', config: { type: 'stdio', command: 'node', args: ['missing.js'] }, scope: 'project', source: 'project' },
  ];
  // Like the real CLI: an unknown name is an error; off is "disabled", with no tools or server info.
  function mcpControl(request) {
    const s = mcpServers.find((x) => x.name === request.serverName);
    if (!s) return { error: `Server not found: ${request.serverName}` };
    if (request.subtype === 'mcp_toggle') {
      if (!request.enabled) {
        Object.assign(s, { status: 'disabled' });
        delete s.tools;
        delete s.serverInfo;
      } else if (s.name === 'docs') Object.assign(s, { status: 'connected', serverInfo: { name: 'docs-server', version: '1.0.0' }, tools: docsTools });
      else Object.assign(s, { status: 'failed', error: 'Connection closed' });
      return {};
    }
    return s.name === 'docs' ? {} : { error: 'Connection closed' };
  }

  // Like the real CLI (2.1.281): a reload sees a settings change only once the session has
  // re-read its settings, about a second after the change (here: once the file is 400ms old).
  // With hold_on_cache_impact, a reload that would change the tools mid-conversation is held.
  function reloadPlugins(request, conversationStarted) {
    let next = sessionPlugins;
    const file = pluginStateFile();
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs >= 400) next = enabledPlugins(loadPluginState());
    const changed = [...next.filter((p) => !sessionPlugins.some((q) => q.id === p.id)), ...sessionPlugins.filter((p) => !next.some((q) => q.id === p.id))];
    if (request.hold_on_cache_impact && conversationStarted && changed.some((p) => p.tools)) {
      return { held: true, cache_impact: { tools_changed: true } };
    }
    sessionPlugins = next;
    return {
      commands: [{ name: 'compact', description: 'Summarize the conversation', argumentHint: '' }, ...pluginCommands(sessionPlugins)],
      agents: [],
      plugins: sessionPlugins.map((p) => ({ name: p.name, path: p.installPath, source: p.id, version: p.version })),
      mcpServers: [],
      error_count: 0,
    };
  }

  const init = () => out({ type: 'system', subtype: 'init', session_id: sessionId, model: flagValue('--model') || 'claude-fake', permissionMode, cwd: process.cwd(), mcp_servers: mcpServers.map((s) => ({ name: s.name, status: s.status, source: s.source })) });
  const text = (t) => {
    out({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'assistant', message: { id: `msg_${++n}`, role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: t }] }, parent_tool_use_id: null, session_id: sessionId });
  };
  // Like the real CLI (2.1.281): total_cost_usd and modelUsage are running totals for the
  // conversation; usage is this turn's alone.
  // A turn's result comes a moment after its reply, as from the real CLI, so the two arrive as
  // separate reads: a test that takes "the reply is here" for "the turn is over" fails here, not
  // only on a slow CI machine (where it did, 2026-10-23).
  const result = async (...a) => { await new Promise((r) => setTimeout(r, 20)); resultNow(...a); };
  const resultNow = (extra = {}, charge = true) => {
    if (charge) {
      cost += 0.01;
      tokens = { ...tokens, inputTokens: tokens.inputTokens + 100, outputTokens: tokens.outputTokens + 20, cacheReadInputTokens: tokens.cacheReadInputTokens + 1000 };
      context += 1000;
    }
    const usage = charge ? { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } : { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const modelUsage = cost ? { 'claude-fake': { ...tokens, costUSD: cost, contextWindow: 200000 } } : {};
    out({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: cost, usage, modelUsage, duration_ms: 5, session_id: sessionId, queued_turn_count: 0, fast_mode_state: fastMode ? 'on' : 'off', ...extra });
    // Like the real CLI with promptSuggestions (schema in 2.1.284): a guess at the next prompt, made
    // after the turn (a request of its own there), so it comes a moment after the result.
    if (suggestions && charge) setTimeout(() => out({ type: 'prompt_suggestion', suggestion: 'Run the tests', uuid: crypto.randomUUID(), session_id: sessionId }), 20);
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
  const toolResult = (id, content, isError, toolUseResult) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError || undefined }] }, ...(toolUseResult ? { tool_use_result: toolUseResult } : {}), parent_tool_use_id: null, session_id: sessionId });
  // Messages sent with shouldQuery: false (shell mode's output) wait here for the next turn.
  let earlier = [];
  let suggestions = false; // initialize's promptSuggestions
  let fastMode = false;
  let backgroundNow = null; // Ctrl+B (background_tasks) for the foreground task running now
  let permissionMode = flagValue('--permission-mode') || 'default';

  const stopTask = new Map(); // task_id -> stop()
  const queuedUuids = new Set(); // messages waiting for their turn
  const cancelledUuids = new Set(); // messages taken back with cancel_async_message
  let turnsUnderWay = 0; // messages that start a turn and haven't finished it: running or waiting

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
    // Like the real CLI (2.1.281): the subagent's calls count in the running totals (modelUsage)
    // but not in the turn's own usage. The same 250 / 50 / 2000 as its transcript above.
    tokens = { ...tokens, inputTokens: tokens.inputTokens + 250, outputTokens: tokens.outputTokens + 50, cacheReadInputTokens: tokens.cacheReadInputTokens + 2000 };
    return result();
  }

  // A subagent Claude waits for (is_backgrounded false) that Ctrl+B can send to the background,
  // as the real CLI does (2.1.284): task_updated is_backgrounded, background_tasks_changed, and the
  // tool call returns at once so the turn carries on.
  async function delegateWait() {
    const input = { description: 'Wait check', prompt: 'wait', subagent_type: 'general-purpose', run_in_background: false };
    const id = toolUse('Agent', input);
    const taskId = `a${crypto.randomBytes(8).toString('hex')}`;
    const sys = (o) => out({ type: 'system', session_id: sessionId, ...o });
    sys({ subtype: 'task_started', task_id: taskId, tool_use_id: id, description: input.description, subagent_type: input.subagent_type, is_backgrounded: false, task_type: 'local_agent', prompt: input.prompt });
    const backgrounded = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      backgroundNow = () => { clearTimeout(timer); resolve(true); };
    });
    backgroundNow = null;
    const done = () => {
      sys({ subtype: 'task_updated', task_id: taskId, patch: { status: 'completed', end_time: Date.now() } });
      sys({ subtype: 'task_notification', task_id: taskId, tool_use_id: id, status: 'completed', summary: 'Waited.', usage: { total_tokens: 20, tool_uses: 0, duration_ms: 3000 } });
    };
    if (!backgrounded) {
      done();
      toolResult(id, 'Waited.');
      text('The helper finished.');
      return result();
    }
    sys({ subtype: 'background_tasks_changed', tasks: [{ task_id: taskId, task_type: 'local_agent', description: input.description }] });
    sys({ subtype: 'task_updated', task_id: taskId, patch: { is_backgrounded: true } });
    toolResult(id, [{ type: 'text', text: 'Async agent launched successfully.' }]);
    text('Carrying on while it runs.');
    setTimeout(() => { sys({ subtype: 'background_tasks_changed', tasks: [] }); done(); }, 800);
    return result();
  }

  async function handle(prompt, images, before = []) {
    // Local commands, in the message shapes the real CLI uses (2.1.281).
    if (prompt.trim() === '/clear') {
      out({ type: 'conversation_reset', new_conversation_id: crypto.randomUUID(), trigger: 'clear', session_id: sessionId });
      sessionId = crypto.randomUUID();
      cost = 0;
      tokens = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
      context = 5000;
      init();
      return result({ num_turns: 0, local_command: 'clear' }, false);
    }
    // /config, as the real CLI answers it in stream-json (2.1.301): with nothing after it, the list of
    // options; "key=value" sets one and replies "Set <label> to <value>", written to the user's
    // settings.json in CLAUDE_CONFIG_DIR. A few of the real options, trimmed.
    if (/^\/config(\s|$)/.test(prompt.trim())) {
      const OPTIONS = { theme: ['Theme', 'theme', ['auto', 'dark', 'light']], editor: ['Editor mode', 'editorMode', ['normal', 'vim']], verbose: ['Verbose output', 'verbose', ['true', 'false']], language: ['Language', 'language', null] };
      const rest = prompt.trim().slice('/config'.length).trim();
      let reply;
      if (!rest) {
        reply = `Usage: /config key=value [key=value ...]\n${Object.entries(OPTIONS).map(([k, [, , v]]) => `  ${k}=${v ? v.join('|') : '<value>'}`).join('\n')}`;
      } else {
        const m = /^(\w+)=(.*)$/.exec(rest);
        const opt = m && OPTIONS[m[1]];
        if (!m) reply = `Expected key=value, got "${rest}". Run /config to see what's available.`;
        else if (!opt) reply = `${m[1]} isn't a /config setting. Run /config to see what's available.`;
        else if (opt[2] && !opt[2].includes(m[2])) reply = `${opt[0]} takes one of: ${opt[2].join(', ')}.`;
        else {
          const file = path.join(process.env.CLAUDE_CONFIG_DIR || '.', 'settings.json');
          let s = {};
          try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
          s[opt[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : m[2];
          fs.writeFileSync(file, JSON.stringify(s, null, 2));
          reply = `Set ${opt[0]} to ${m[2]}`;
        }
      }
      text(reply);
      return result({ num_turns: 0, local_command: 'config', result: reply }, false);
    }
    if (prompt.trim() === '/compact') {
      out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId });
      const pre = context;
      context = 1500;
      out({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sessionId });
      init();
      out({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, compact_metadata: { trigger: 'manual', pre_tokens: pre, post_tokens: context } });
      // Summarizing is itself an API call, so it costs something too.
      cost += 0.01;
      tokens = { ...tokens, inputTokens: tokens.inputTokens + 100, outputTokens: tokens.outputTokens + 20, cacheReadInputTokens: tokens.cacheReadInputTokens + 1000 };
      return result({ num_turns: 0, local_command: 'compact' }, false);
    }
    init();
    if (images.length) {
      text(`Saw ${images.length} image${images.length === 1 ? '' : 's'} (${images.join(', ')})${prompt.trim() ? ` with: ${prompt.trim()}` : ''}.`);
      return result();
    }
    // Shapes from the real CLI (2.1.284): thinking as its own assistant message; an edit's result
    // with tool_use_result.structuredPatch; TodoWrite; TaskCreate's "Task #N created successfully";
    // ExitPlanMode asking with requires_user_interaction, and its setMode update.
    // An expired sign-in, in the shapes the real CLI sends when it can't authenticate (2.1.296): a
    // synthetic assistant message marked authentication_failed, then an error result.
    if (/expire my sign-in/i.test(prompt)) {
      const msg = 'Failed to authenticate: OAuth session expired and could not be refreshed';
      out({ type: 'assistant', message: { id: `msg_${++n}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: msg }] }, error: 'authentication_failed', parent_tool_use_id: null, session_id: sessionId });
      return result({ is_error: true, result: msg });
    }
    if (/show thinking/i.test(prompt)) {
      out({ type: 'assistant', message: { id: `msg_${++n}`, role: 'assistant', model: 'claude-fake', content: [{ type: 'thinking', thinking: 'Let me think about this for a moment.', signature: 'fake' }] }, parent_tool_use_id: null, session_id: sessionId });
      text('Thought it through.');
      return result();
    }
    if (/make an edit/i.test(prompt)) {
      const file = path.join(process.cwd(), 'edit-me.txt');
      const id = toolUse('Edit', { file_path: file, old_string: 'apples', new_string: 'oranges', replace_all: false });
      toolResult(id, `The file ${file} has been updated successfully.`, false, { filePath: file, oldString: 'apples', newString: 'oranges', originalFile: 'I like apples.\nAnd pears.\n', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-I like apples.', '+I like oranges.', ' And pears.'] }], userModified: false, replaceAll: false });
      text('Edited.');
      return result();
    }
    if (/keep a todo/i.test(prompt)) {
      const id = toolUse('TodoWrite', { todos: [{ content: 'Read the code', status: 'completed', activeForm: 'Reading the code' }, { content: 'Write the fix', status: 'in_progress', activeForm: 'Writing the fix' }, { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' }] });
      toolResult(id, 'Todos have been modified successfully.');
      text('Listed the steps.');
      return result();
    }
    if (/track tasks/i.test(prompt)) {
      toolResult(toolUse('TaskCreate', { subject: 'Write the tests', description: 'Cover it', activeForm: 'Writing the tests' }), 'Task #1 created successfully: Write the tests');
      toolResult(toolUse('TaskCreate', { subject: 'Ship it', description: 'Release', activeForm: 'Shipping it' }), 'Task #2 created successfully: Ship it');
      toolResult(toolUse('TaskUpdate', { taskId: '1', status: 'completed' }), 'Updated task #1 status');
      text('Tracking two tasks.');
      return result();
    }
    if (/plan it/i.test(prompt)) {
      const input = { plan: '## Plan\n\n1. Read `app.js`\n2. Add the **menu**' };
      const id = toolUse('ExitPlanMode', input);
      const r = await ask({ subtype: 'can_use_tool', tool_name: 'ExitPlanMode', display_name: 'ExitPlanMode', input, tool_use_id: id, requires_user_interaction: true });
      if (r.behavior === 'allow') {
        const set = (r.updatedPermissions || []).find((u) => u.type === 'setMode');
        if (set) permissionMode = set.mode;
        toolResult(id, 'User has approved exiting plan mode. You can now proceed.');
        text(`Plan approved; mode ${permissionMode}.`);
      } else {
        toolResult(id, r.message, true);
        text(`Still planning: ${r.message}`);
      }
      return result();
    }
    if (/show args/i.test(prompt)) {
      text(`Args: ${JSON.stringify(args)}`);
      return result();
    }
    if (/delegate wait/i.test(prompt)) return delegateWait();
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
    // Reports the effort the next request would use: --effort, as changed by apply_flag_settings.
    if (/which effort/i.test(prompt)) {
      text(`Effort: ${effort || 'default'}`);
      return result();
    }
    // Like the real CLI: what was sent with shouldQuery false goes with this message.
    text(`Echo: ${prompt}${before.length ? ` [with: ${before.join(' ')}]` : ''}`);
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
        // An interrupt can arrive in the same read as the message it's meant for, before that turn
        // has started. Like the real CLI, which latches it, still stop that turn: give it a moment
        // to start first. Without this the interrupt tests were flaky (fine locally, failed in CI).
        if (sub === 'interrupt') {
          if (interrupted) interrupted();
          else setImmediate(() => { if (interrupted) interrupted(); });
        }
        if (sub === 'stop_task' && stopTask.has(m.request.task_id)) stopTask.get(m.request.task_id)();
        // Like the real CLI: effortLevel changes the session's effort; null goes back to the default.
        if (sub === 'apply_flag_settings' && m.request.settings && 'effortLevel' in m.request.settings) effort = m.request.settings.effortLevel;
        if (sub === 'apply_flag_settings' && m.request.settings && 'fastMode' in m.request.settings) fastMode = m.request.settings.fastMode === true;
        if (sub === 'initialize') suggestions = m.request.promptSuggestions === true;
        if (sub === 'set_permission_mode') permissionMode = m.request.mode;
        if (sub === 'background_tasks' && backgroundNow) backgroundNow();
        let response = sub === 'initialize' ? { commands: [{ name: 'compact', description: 'Summarize the conversation', argumentHint: '' }, ...pluginCommands(sessionPlugins)], models: FAKE_MODELS, fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required' } : {};
        // Like the real CLI (2.1.301): an interrupt reports what stays queued, and Send now says
        // how the running turn made way: with a message waiting behind a turn under way (started,
        // or about to), the turn is stopped and the queue carries on; with nothing under way, nothing.
        if (sub === 'interrupt') response = { still_queued: [...queuedUuids], ...(m.request.send_now === true ? { send_now: turnsUnderWay > 1 ? 'stopped' : 'nothing_to_send' } : {}) };
        // Shapes from the real CLI (2.1.284).
        if (sub === 'file_suggestions') {
          const q = String(m.request.query || '').toLowerCase();
          response = { suggestions: ['src/app.js', 'src/server.js', 'README.md', 'src/'].filter((p) => p.toLowerCase().includes(q)).map((p) => ({ path: p })), cwd: process.cwd() };
        }
        if (sub === 'side_question') response = { response: `Aside: ${m.request.question}`, synthetic: false };
        if (sub === 'mcp_authenticate') {
          if (!mcpServers.some((s) => s.name === m.request.serverName)) {
            out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `Server not found: ${m.request.serverName}` } });
            continue;
          }
          response = { authUrl: `https://auth.example.com/authorize?server=${encodeURIComponent(m.request.serverName)}`, requiresUserAction: true, callbackExpected: true, redirectScheme: 'localhost', callbackPort: 51234 };
        }
        if (sub === 'reload_plugins') response = reloadPlugins(m.request, cost > 0);
        // Like the real CLI (2.1.281), with detail "summary": answered locally.
        if (sub === 'get_context_usage') response = { totalTokens: context, maxTokens: 200000, percentage: Math.round((context / 200000) * 100), categories: [], apiUsage: null };
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
        // Like the real CLI: drops a message still waiting in the queue (lifecycle "cancelled"),
        // or answers cancelled:false once it has started.
        if (sub === 'cancel_async_message') {
          const id = m.request.message_uuid;
          const waitingInLine = queuedUuids.has(id);
          if (waitingInLine) {
            queuedUuids.delete(id);
            cancelledUuids.add(id);
            out({ type: 'command_lifecycle', command_uuid: id, state: 'cancelled', session_id: sessionId });
          }
          response = { cancelled: waitingInLine };
        }
        if (sub === 'mcp_status') response = { mcpServers };
        if (sub === 'mcp_toggle' || sub === 'mcp_reconnect') {
          const r = mcpControl(m.request);
          if (r.error) {
            out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: r.error } });
            continue;
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
        if (m.uuid) queuedUuids.add(m.uuid);
        if (m.shouldQuery !== false) turnsUnderWay++;
        turn = turn.then(async () => {
          try {
            if (cancelledUuids.has(m.uuid)) return; // taken back before its turn
            queuedUuids.delete(m.uuid);
            lifecycle('started');
            // Like the real CLI (2.1.284): shouldQuery false adds it without a reply (a result
            // still arrives), and it goes along with the next message that does get one.
            if (m.shouldQuery === false) {
              earlier.push(prompt);
              resultNow({ num_turns: 0 }, false);
            } else {
              const before = earlier;
              earlier = [];
              await handle(prompt, images, before);
            }
            lifecycle('completed');
          } finally {
            if (m.shouldQuery !== false) turnsUnderWay--;
          }
        });
      }
    }
  });
  process.stdin.on('end', () => turn.then(() => process.exit(0)));
}

// ---- plugins ---------------------------------------------------------------------------------
// `claude plugin ...` with the output shapes claude.exe 2.1.281 prints (docs/CLAUDE-CODE-INTERNALS.md,
// "Plugins"), over a state file in CLAUDE_CONFIG_DIR. The catalog has a plugin with a slash command,
// one that adds tools (its reload is held mid-conversation), and one installed by a command the
// marketplace declares (refused until that command's sha256 is accepted).
function pluginStateFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || '.', 'fake-plugins.json');
}

function loadPluginState() {
  try {
    return JSON.parse(fs.readFileSync(pluginStateFile(), 'utf8'));
  } catch {
    return {
      marketplaces: [{ name: 'fake-market', source: 'github', repo: 'example/fake-market' }],
      catalog: [
        { id: 'hello@fake-market', description: 'Adds a /hello command.', category: 'productivity' },
        { id: 'tools@fake-market', description: 'Adds tools through an MCP server.', category: 'development', tools: true },
        { id: 'scripted@fake-market', description: 'Installed by a command the marketplace declares.', command: 'npx fake-plugin-installer', sha256: 'f00dfeed' },
      ],
      installed: {},
    };
  }
}

function enabledPlugins(state) {
  return Object.entries(state.installed).filter(([, p]) => p.enabled).map(([id, p]) => {
    const item = state.catalog.find((c) => c.id === id) || {};
    return { id, name: id.split('@')[0], installPath: p.installPath, version: p.version, tools: item.tools === true };
  });
}

function pluginCommands(plugins) {
  return plugins.filter((p) => p.id.startsWith('hello@')).map((p) => ({ name: `${p.name}:hello`, description: `(${p.name}) Say hello`, argumentHint: '' }));
}

function pluginMode() {
  const state = loadPluginState();
  const save = () => fs.writeFileSync(pluginStateFile(), JSON.stringify(state, null, 2));
  const [, cmd, ...rest] = args;
  const target = rest.find((a) => !a.startsWith('-'));
  const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
  const line = (o, code = 0) => { process.stdout.write(`${JSON.stringify(o)}\n`); process.exit(code); };
  const fail = (text) => { process.stderr.write(`× ${text}\n`); process.exit(1); };
  if (cmd === 'list') {
    const installed = Object.entries(state.installed).map(([id, p]) => ({ id, version: p.version, scope: p.scope, enabled: p.enabled, installPath: p.installPath, installedAt: p.installedAt, lastUpdated: p.installedAt }));
    const available = state.catalog.filter((c) => !state.installed[c.id]).map((c) => ({ pluginId: c.id, name: c.id.split('@')[0], description: c.description, marketplaceName: c.id.split('@')[1], source: `./plugins/${c.id.split('@')[0]}`, installCount: 42 }));
    process.stdout.write(`${JSON.stringify(rest.includes('--available') ? { installed, available } : installed, null, 2)}\n`);
    return;
  }
  if (cmd === 'enable' || cmd === 'disable') {
    const p = state.installed[target];
    if (!p) line({ command: cmd, outcome: 'failed', plugin: target, message: `Plugin "${target}" is not installed`, failureCode: 'not_installed' }, 1);
    p.enabled = cmd === 'enable';
    save();
    line({ command: cmd, outcome: 'ok', plugin: target, pluginId: target, scope: p.scope, message: `Successfully ${cmd}d plugin: ${target.split('@')[0]} (scope: ${p.scope})` });
  }
  if (cmd === 'install') {
    const item = state.catalog.find((c) => c.id === target);
    if (!item) line({ command: 'install', outcome: 'failed', plugin: target, message: `Plugin "${String(target).split('@')[0]}" not found in marketplace "fake-market".`, failureCode: 'not_found' }, 1);
    if (item.command && opt('--accept-command') !== item.sha256) {
      line({ command: 'install', outcome: 'failed', plugin: target, pluginId: target, message: 'This plugin is installed by running a command the marketplace declares.', failureCode: 'command_source_refused', shownCommand: { kind: 'command_source', pluginId: target, command: item.command, sha256: item.sha256 } }, 1);
    }
    const [name, market] = target.split('@');
    const installPath = path.join(process.env.CLAUDE_CONFIG_DIR || '.', 'plugins', 'cache', market, name, '1.0.0');
    fs.mkdirSync(path.join(installPath, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: item.description }));
    state.installed[target] = { enabled: true, scope: opt('--scope') || 'user', version: '1.0.0', installPath, installedAt: new Date().toISOString() };
    save();
    line({ command: 'install', outcome: 'ok', plugin: target, pluginId: target, scope: state.installed[target].scope, message: `Successfully installed plugin: ${target} (scope: user)` });
  }
  if (cmd === 'marketplace') {
    const [sub, ...more] = rest;
    const what = more.find((a) => !a.startsWith('-'));
    if (sub === 'list') {
      // Like the real CLI: each marketplace's own catalog, with categories, is in its installLocation.
      const home = path.join(process.env.CLAUDE_CONFIG_DIR || '.', 'plugins', 'marketplaces');
      for (const m of state.marketplaces) {
        const listed = state.catalog.filter((c) => c.id.endsWith(`@${m.name}`)).map((c) => ({ name: c.id.split('@')[0], description: c.description, source: `./plugins/${c.id.split('@')[0]}`, ...(c.category ? { category: c.category } : {}) }));
        fs.mkdirSync(path.join(home, m.name, '.claude-plugin'), { recursive: true });
        fs.writeFileSync(path.join(home, m.name, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: m.name, owner: { name: 'fake' }, plugins: listed }));
      }
      process.stdout.write(`${JSON.stringify(state.marketplaces.map((m) => ({ ...m, installLocation: path.join(home, m.name) })), null, 2)}\n`);
      return;
    }
    if (sub === 'add') {
      if (/does-not-exist/.test(what)) fail(`Path does not exist: ${what}`);
      const name = what.split(/[\\/]/).pop();
      state.marketplaces.push({ name, source: 'github', repo: what });
      save();
      // The real CLI prints progress lines first (a fresh GitHub add prints several).
      process.stdout.write(`Adding marketplace…Cloning repository (timeout: 120s): ${what}\nClone complete, validating marketplace…√ Successfully added marketplace: ${name} (declared in user settings)\n`);
      return;
    }
    if (sub === 'remove') {
      if (!state.marketplaces.some((m) => m.name === what)) fail(`Marketplace '${what}' not found`);
      state.marketplaces = state.marketplaces.filter((m) => m.name !== what);
      save();
      process.stdout.write(`√ Successfully removed marketplace: ${what}\n`);
      return;
    }
    if (sub === 'update') {
      const n = what ? 1 : state.marketplaces.length;
      process.stdout.write(`Updating marketplaces...√ Successfully updated ${n} marketplace${n === 1 ? '' : 's'}\n`);
      return;
    }
  }
  fail(`fake-claude: unsupported plugin command: ${args.join(' ')}`);
}
