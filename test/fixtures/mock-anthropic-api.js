'use strict';
// Local stand-in for the Anthropic Messages API, so the real claude.exe can be exercised end to
// end with zero cost. Nothing leaves the machine.
//
//   node test/fixtures/mock-anthropic-api.js [port=47990] [folder for Write calls]
//
// Run Claude (or the Claude Deck server) with:
//   ANTHROPIC_BASE_URL=http://127.0.0.1:47990  ANTHROPIC_API_KEY=sk-ant-mock  CLAUDE_CONFIG_DIR=<sandbox>
//   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
//
// Scripted replies, keyed on the latest prompt:
//   "please run ..."   -> Bash tool call (echo)       "please write ..." -> Write tool call
//   "please run slow"  -> Bash tool call that takes 3s
//   "please ask ..."   -> AskUserQuestion              "please slow ..."  -> text after 6s (try Interrupt)
//   "please delegate"  -> Agent tool call (the subagent then runs Bash)
//   "please delegate slow" -> a subagent whose reply takes 6s (try stopping it)
//   "please delegate foreground" -> a subagent Claude waits for; it runs the 3s Bash call
//   "please use tool <Name>" -> a call to that tool (unknown ones come back as errors)
//   "please stream" / "please stream thinking" -> a reply streamed in small pieces (after thinking)
//   a prompt with images -> "I can see N images (types)"
//   anything else      -> "Reply to: <prompt>"         after a tool result -> "Tool result seen: ..."

const http = require('http');

const port = Number(process.argv[2] || 47990);
const writeDir = process.argv[3] || process.cwd();
let n = 0;

// The real prompt in the current user turn. Claude Code adds <system-reminder> blocks and extra
// messages (a trailing system message; an "# Environment" message for subagents), so join the
// text of every message since the last assistant reply.
function latestPrompt(msgs) {
  const parts = [];
  for (let i = msgs.length - 1; i >= 0 && msgs[i].role !== 'assistant'; i--) {
    const c = Array.isArray(msgs[i].content) ? msgs[i].content : [{ type: 'text', text: String(msgs[i].content || '') }];
    const text = c.filter((b) => b.type === 'text' && !String(b.text).trim().startsWith('<')).map((b) => b.text).join(' ');
    if (text) parts.unshift(text);
  }
  // The prompt comes last in the turn; environment notes come first.
  return parts.filter((t) => !t.trim().startsWith('# Environment')).join(' ') || parts.join(' ');
}

function reply(body) {
  const msgs = body.messages || [];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user') || {};
  const content = Array.isArray(lastUser.content) ? lastUser.content : [];
  const toolResult = content.find((b) => b.type === 'tool_result');
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const text = latestPrompt(msgs);
  const tool = (name, input) => ({ kind: 'tool', block: { type: 'tool_use', id: `toolu_mock_${++n}`, name, input } });
  if (toolResult) {
    const t = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content);
    return { kind: 'text', text: `Tool result seen: ${t.slice(0, 160)}` };
  }
  if (hasTools) {
    // Calls any tool by name, even one Claude doesn't have (it answers with an error), to see how
    // a tool call is displayed.
    const named = text.match(/please use tool (\S+)/i);
    if (named) return tool(named[1], { note: 'display check' });
    // Streams a reply the way the real API does: many small text pieces ~60ms apart, optionally
    // after a thinking block.
    if (/please stream/i.test(text)) {
      const words = 'This reply arrives the way a real one does, a few words at a time, so you can watch it build up in the chat instead of landing all at once. '.repeat(3).trim().split(' ');
      const pieces = [];
      for (let i = 0; i < words.length; i += 2) pieces.push(`${words.slice(i, i + 2).join(' ')} `);
      return { kind: 'text', text: pieces.join(''), stream: { pieces, thinking: /thinking/i.test(text) } };
    }
    if (/please run slow/i.test(text)) return tool('Bash', { command: 'sleep 3 && echo slow-done', description: 'Wait, then print' });
    if (/please run/i.test(text)) return tool('Bash', { command: 'echo hello-from-mock', description: 'Print a test string' });
    if (/please write/i.test(text)) return tool('Write', { file_path: `${writeDir}\\mock-${n + 1}.txt`, content: 'written by the mock API\n' });
    if (/please ask/i.test(text)) return tool('AskUserQuestion', { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }], multiSelect: false }] });
    if (/please slow/i.test(text)) return { kind: 'text', text: 'Slow reply finished.', delayMs: 6000 };
    // Starts a subagent whose own first request says "please run", so it makes a tool call too.
    const agentTool = body.tools.find((t) => t.name === 'Agent' || t.name === 'Task');
    // Claude waits for this one (run_in_background: false) instead of carrying on.
    if (/please delegate foreground/i.test(text) && agentTool) return tool(agentTool.name, { description: 'Foreground check', prompt: 'please run slow for the check', subagent_type: 'general-purpose', run_in_background: false });
    if (/please delegate slow/i.test(text) && agentTool) return tool(agentTool.name, { description: 'Slow check', prompt: 'please slow reply for the check', subagent_type: 'general-purpose' });
    if (/please delegate/i.test(text) && agentTool) return tool(agentTool.name, { description: 'Check the echo command', prompt: 'please run the echo check', subagent_type: 'general-purpose' });
    const images = content.filter((b) => b.type === 'image').length;
    if (images) return { kind: 'text', text: `I can see ${images} image${images === 1 ? '' : 's'} (${content.filter((b) => b.type === 'image').map((b) => b.source && b.source.media_type).join(', ')}).` };
    return { kind: 'text', text: `Reply to: ${text.slice(0, 80)}` };
  }
  return { kind: 'text', text: 'Mock title' };
}

function writeSse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = req.url.split('?')[0];
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
    const blocks = lastUser && Array.isArray(lastUser.content) ? lastUser.content.map((b) => b.type).join(',') : '-';
    // Effort and thinking settings, so probes can see what Claude asked for.
    const effort = body.output_config ? JSON.stringify(body.output_config) : '-';
    const thinking = body.thinking ? JSON.stringify(body.thinking) : '-';
    console.log(`[mock] ${req.method} ${url} model=${body.model || '-'} tools=${(body.tools || []).length} last-user-blocks=${blocks} output_config=${effort} thinking=${thinking}`);
    if (url.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 42 }));
    }
    if (!url.endsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }));
    }
    const r = reply(body);
    const id = `msg_mock_${++n}`;
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const block = r.kind === 'tool' ? r.block : { type: 'text', text: r.text };
    const stopReason = r.kind === 'tool' ? 'tool_use' : 'end_turn';
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: stopReason, stop_sequence: null, usage }));
    }
    const events = [['message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }]];
    if (r.stream) {
      // Sent over time: [delayMs, event] pairs.
      const timed = events.map((e) => [0, e]);
      let index = 0;
      if (r.stream.thinking) {
        timed.push([0, ['content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }]]);
        for (const t of ['Let me think ', 'about this for ', 'a moment.']) timed.push([60, ['content_block_delta', { index, delta: { type: 'thinking_delta', thinking: t } }]]);
        timed.push([0, ['content_block_delta', { index, delta: { type: 'signature_delta', signature: 'mock-signature' } }]]);
        timed.push([0, ['content_block_stop', { index }]]);
        index++;
      }
      timed.push([0, ['content_block_start', { index, content_block: { type: 'text', text: '' } }]]);
      for (const p of r.stream.pieces) timed.push([60, ['content_block_delta', { index, delta: { type: 'text_delta', text: p } }]]);
      timed.push([0, ['content_block_stop', { index }]]);
      timed.push([0, ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }]]);
      timed.push([0, ['message_stop', {}]]);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      (async () => {
        for (const [wait, [type, data]] of timed) {
          if (wait) await new Promise((ok) => setTimeout(ok, wait));
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        }
        res.end();
      })();
      return undefined;
    }
    if (r.kind === 'tool') {
      events.push(['content_block_start', { index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }]);
      events.push(['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }]);
    } else {
      events.push(['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { index: 0, delta: { type: 'text_delta', text: r.text } }]);
    }
    events.push(['content_block_stop', { index: 0 }]);
    events.push(['message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }]);
    events.push(['message_stop', {}]);
    if (r.delayMs) setTimeout(() => writeSse(res, events), r.delayMs);
    else writeSse(res, events);
  });
}).listen(port, '127.0.0.1', () => console.log(`[mock] listening on http://127.0.0.1:${port}`));
