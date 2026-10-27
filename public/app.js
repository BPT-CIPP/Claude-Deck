'use strict';
// Claude Deck dashboard: the session list and detail view with in-app chat, history, launcher,
// palette, preferences.

(function () {
  const { h, $, $$, api, clear, ago, when, dayGroup, money, shortPath, copy, toast, richText, duration } = Deck;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(`deck-${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`deck-${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const S = {
    boot: null,
    prefs: null,
    live: { sessions: [], external: [] },
    view: store.get('view', 'sessions'),
    selected: null,
    opening: null, // { key, until } while a just-created session waits for its first state update
    filter: '',
    history: { sessions: [], live: [], folderNames: {}, loaded: false },
    historySel: null,
    historyLimit: 150,
    historyView: store.get('historyView', 'folders'), // 'folders': one per working directory; 'list': all, newest first
    historyOpen: new Set(store.get('historyOpen', [])), // folder keys opened in the folder view
    historyReveal: null, // a session id whose folder opens on the next render (chosen elsewhere)
    historyFolderLimits: {}, // folder key -> how many of its conversations to show
    historyDrag: null, // { sessionId, folderKey } while a conversation is being dragged
    folders: { favorites: [], recent: [] },
    detailKey: null,
    headSig: null,
    convo: { key: null, stamp: null, sessionId: null },
    chat: null, // the chat shown in the focus view: { id, loaded, items: Map, past, commands, buffer }
    drafts: {},
    attachments: {}, // chat id -> images waiting to be sent
    pastes: {}, // chat id -> { texts: { id: text }, last: id }: long pastes shown as [Pasted text #id]
    openPastes: new Set(), // "chat id:item n:paste id" of pastes shown in full in the conversation
    sending: {}, // chat id -> true while a message is on its way
    showTasks: {}, // chat id -> subagents panel open
    tasksSeen: {}, // chat id -> how many subagents it had when last shown, to open the panel for new ones
    showChanges: {}, // session key -> changes shown instead of the conversation
    agentView: null, // { chatId, taskId }: a subagent's detail shown instead of the conversation
    week: null, // { data, loading, fetchedAt }: tokens by conversation this week (the pinned usage view)
    term: null, // the terminal in the window being shown (mountTerminal)
  };

  const LANES = [
    { key: 'waiting', label: 'Needs you' },
    { key: 'working', label: 'Working' },
    { key: 'idle', label: 'Idle' },
    { key: 'ended', label: 'Ended' },
  ];
  const COLOR_NAMES = { slate: 'Slate', cyan: 'Cyan', amber: 'Amber', sage: 'Sage', rose: 'Rose', violet: 'Violet', sand: 'Sand' };
  // Same ids as FONTS in src/prefs.js: fonts that ship with Windows, so nothing is downloaded.
  // `face` is checked to tell whether this PC has it; 'default' is each role's own font.
  const FONT_CHOICES = {
    default: { label: 'Default', face: null, stack: null },
    segoe: { label: 'Segoe UI', face: 'Segoe UI', stack: '"Segoe UI", system-ui, sans-serif' },
    aptos: { label: 'Aptos', face: 'Aptos', stack: 'Aptos, "Segoe UI", sans-serif' },
    calibri: { label: 'Calibri', face: 'Calibri', stack: 'Calibri, "Segoe UI", sans-serif' },
    verdana: { label: 'Verdana', face: 'Verdana', stack: 'Verdana, "Segoe UI", sans-serif' },
    tahoma: { label: 'Tahoma', face: 'Tahoma', stack: 'Tahoma, "Segoe UI", sans-serif' },
    trebuchet: { label: 'Trebuchet MS', face: 'Trebuchet MS', stack: '"Trebuchet MS", "Segoe UI", sans-serif' },
    georgia: { label: 'Georgia', face: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
    bahnschrift: { label: 'Bahnschrift', face: 'Bahnschrift', stack: 'Bahnschrift, "Segoe UI", sans-serif' },
    cascadia: { label: 'Cascadia Code', face: 'Cascadia Code', stack: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
    consolas: { label: 'Consolas', face: 'Consolas', stack: 'Consolas, "Cascadia Mono", monospace' },
  };
  const FONT_DEFAULTS = { fontText: 'Segoe UI Variable', fontLabels: 'Bahnschrift' };

  // Whether this PC has a font: text set in it measures differently from the fallbacks.
  const fontSeen = new Map();
  function fontInstalled(face) {
    if (!face) return true;
    if (fontSeen.has(face)) return fontSeen.get(face);
    const ctx = document.createElement('canvas').getContext('2d');
    const sample = 'Claude Deck mmmmwwwwiiii 0123456789';
    const width = (font) => { ctx.font = `20px ${font}`; return ctx.measureText(sample).width; };
    const has = ['monospace', 'serif', 'sans-serif'].some((fallback) => width(`"${face}", ${fallback}`) !== width(fallback));
    fontSeen.set(face, has);
    return has;
  }

  // Same ids as THEMES in src/prefs.js; each has a :root[data-theme] block in app.css.
  const THEME_GROUPS = [
    ['Standard', [['system', 'Match Windows'], ['dark', 'Dark'], ['light', 'Light']]],
    ['Dark', [['claude', 'Claude'], ['midnight', 'Midnight'], ['graphite', 'Graphite'], ['nord', 'Nord'], ['dracula', 'Dracula'], ['forest', 'Forest'], ['ocean', 'Ocean'], ['solarized-dark', 'Solarized Dark'], ['high-contrast', 'High Contrast']]],
    ['Light', [['sepia', 'Sepia'], ['solarized-light', 'Solarized Light'], ['rose', 'Rose']]],
  ];

  // ---- session model -------------------------------------------------------------------------
  function laneOf(s) {
    if (s.deck) {
      if (s.state === 'failed' || s.state === 'exited') return 'ended';
      if (s.state === 'starting' || s.status === 'starting') return 'working';
    }
    if (s.status === 'waiting') return 'waiting';
    if (s.status === 'busy') return 'working';
    return 'idle';
  }

  function statusLabel(s) {
    if (s.deck) {
      if (s.state === 'failed') return "Didn't start";
      if (s.state === 'exited') return s.exitCode ? `Ended with exit code ${s.exitCode}` : 'Ended';
      if (s.state === 'starting' || s.status === 'starting') return 'Starting';
    }
    if (s.status === 'waiting') return s.waitingFor ? `Needs you: ${s.waitingFor}` : 'Needs you';
    if (s.status === 'busy') return 'Working';
    return 'Idle';
  }

  function allItems() {
    const out = S.live.sessions.map((s) => ({ ...s, deck: true, key: `d:${s.id}` }));
    for (const x of S.live.external) out.push({ ...x, deck: false, kind: 'external', key: `x:${x.pid}` });
    for (const it of out) it.lane = laneOf(it);
    return out;
  }

  const isChat = (it) => it && it.kind === 'chat';
  const isTerminal = (it) => it && it.kind === 'terminal';
  const isEmbedded = (it) => it && it.kind === 'embedded'; // a terminal in the window
  // Claude Deck Preferences: whether "here in Claude Deck" starts a chat or a terminal in the window.
  const hereIsTerminal = () => Boolean(S.prefs && S.prefs.runHereAs === 'terminal');

  function heading(it) {
    return it.name || it.title || (isTerminal(it) ? it.tabTitle : null) || shortPath(it.cwd, 1) || 'Claude session';
  }

  function matches(fields, q) {
    if (!q) return true;
    const hay = fields.filter(Boolean).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function visibleItems() {
    const q = S.filter;
    const list = allItems().filter((it) => matches([it.name, it.title, it.lastPrompt, it.lastReply, it.cwd, it.gitBranch, it.sessionId], q));
    const order = [];
    for (const lane of LANES) {
      const inLane = list.filter((it) => it.lane === lane.key);
      inLane.sort((a, b) => {
        if (a.deck !== b.deck) return a.deck ? -1 : 1;
        // Longest-waiting first where attention is needed; most recent activity first elsewhere.
        return lane.key === 'waiting' ? (a.statusSince || 0) - (b.statusSince || 0) : (b.statusSince || 0) - (a.statusSince || 0);
      });
      order.push({ lane, items: inLane });
    }
    return order;
  }

  function findItem(key) {
    return allItems().find((it) => it.key === key) || null;
  }

  function resumeCommand(it) {
    if (!it.sessionId) return null;
    const cwd = it.cwd ? `cd '${it.cwd.replace(/'/g, "''")}'; ` : '';
    return `${cwd}claude --resume ${it.sessionId}`;
  }

  // ---- actions -------------------------------------------------------------------------------
  async function run(label, fn) {
    try {
      return await fn();
    } catch (err) {
      toast(`${label}: ${err.message}`, 'error');
      return null;
    }
  }

  // Open a session: chats open in the focus view, terminal sessions switch to their tab.
  function openSession(it) {
    if (!it) return;
    if (isChat(it)) openChat(it.id);
    else if (isEmbedded(it)) {
      if (canResumeEmbedded(it)) resumeEmbedded(it, true);
      else openTerminal(it.id);
    } else if (isTerminal(it)) {
      if (it.state === 'exited') resumeTerminal(it);
      else run("Couldn't open the terminal", () => api('POST', `/api/sessions/${it.id}/focus`));
    } else showDetails(it.key);
  }

  function openChat(id, focusComposer = true) {
    S.selected = `d:${id}`;
    S.agentView = null; // opening a chat shows its conversation
    S.opening = { key: S.selected, until: Date.now() + 8000 };
    if (S.view !== 'sessions') setView('sessions');
    else renderSessions();
    if (focusComposer) setTimeout(() => { const ta = $('#focus-detail .composer-input'); if (ta && !ta.disabled) ta.focus(); }, 60);
  }

  // Open a terminal in the window and put the cursor in it.
  function openTerminal(id) {
    S.selected = `d:${id}`;
    S.agentView = null;
    S.opening = { key: S.selected, until: Date.now() + 8000 };
    if (S.view !== 'sessions') setView('sessions');
    else renderSessions();
    setTimeout(() => { if (S.term && S.term.id === id) S.term.xterm.focus(); }, 80);
  }

  // Esc from a reply box: to the selected session in the list, where the arrow keys move between sessions.
  function focusSessionList() {
    const el = S.selected && document.querySelector(`#focus-list [data-key="${CSS.escape(S.selected)}"]`);
    if (el) el.focus({ preventScroll: false });
  }

  // quick (Ctrl+W on a chat): no confirm unless Claude is mid-task or waiting on you; ending an
  // idle chat offers Undo, which resumes it. Returns true if the session was ended or removed.
  async function endSession(it, { quick = false } = {}) {
    const active = it.status === 'busy' || it.status === 'waiting';
    const ended = it.state === 'exited' || it.state === 'failed';
    let title;
    let body;
    let ok;
    if (it.kind === 'external') {
      title = 'End this session?';
      body = 'This stops Claude in the terminal where it was started. The conversation stays in History, so you can resume it here later.';
      ok = 'End session';
    } else if (ended) {
      title = isTerminal(it) ? 'Close this tab?' : isChat(it) ? 'Remove this chat from the list?' : 'Remove this terminal from the list?';
      body = 'The conversation stays in History.';
      ok = isTerminal(it) ? 'Close tab' : 'Remove';
    } else {
      title = 'End this session?';
      body = `Claude stops${active ? ' mid-task' : ''}${isTerminal(it) ? ' and its tab closes' : ''}. The conversation stays in History, so you can resume it later.`;
      ok = 'End session';
    }
    const ask = !quick || active || it.kind === 'external';
    if (ask && !(await Deck.confirm({ title, body, ok, danger: active || it.kind === 'external' }))) return false;
    const path = isChat(it) ? `/api/chats/${it.id}/end` : isEmbedded(it) ? `/api/terminals/${it.id}/end` : isTerminal(it) ? `/api/sessions/${it.id}/close` : `/api/external/${it.pid}/end`;
    // A terminal in the window always stays listed as ended (its screen stays too); a chat does on
    // Ctrl+W's first press.
    const keep = !ended && (isEmbedded(it) || (quick && isChat(it)));
    const payload = isEmbedded(it) ? (ended ? { remove: true } : {}) : keep ? { keep: true } : undefined;
    const res = await run("Couldn't end the session", () => api('POST', path, payload));
    if (!res) return false;
    if (keep) {
      // Still listed (as ended) and still selected, so a second Ctrl+W removes it.
      toast(isChat(it) ? 'Chat ended' : 'Terminal ended', 'info', { label: 'Undo', ms: 8000, run: () => (isChat(it) ? resumeChat(it) : resumeEmbedded(it)) });
      return true;
    }
    toast(ended ? 'Removed' : 'Session ended');
    if (S.selected === it.key) S.selected = null;
    return true;
  }

  async function resumeTerminal(it) {
    const res = await run("Couldn't resume", () => api('POST', `/api/sessions/${it.id}/resume`));
    if (res) toast(res.inPlace ? 'Resumed in the same tab' : 'Resumed in a new tab');
  }

  async function resumeChat(it) {
    const res = await run("Couldn't resume", () => api('POST', `/api/chats/${it.id}/resume`));
    if (res) toast('Resumed');
    return Boolean(res);
  }

  // Resuming a terminal in the window is `claude --resume`, which needs a conversation on disk: one
  // that only ran /config or /mcp and never had a prompt has nothing to resume.
  const canResumeEmbedded = (it) => it.state === 'exited' && Boolean(it.sessionId) && it.userTurns > 0;

  // A terminal in the window: the same conversation, a new run. open: show it too (Enter on it in the list).
  async function resumeEmbedded(it, open = false) {
    const res = await run("Couldn't resume", () => api('POST', `/api/terminals/${it.id}/resume`));
    if (res) {
      toast('Resumed');
      if (open) openTerminal(it.id);
    }
    return Boolean(res);
  }

  // Enter on an ended chat: resume it, show it, and put the cursor in its reply box once it's live.
  async function resumeAndFocus(it) {
    if (!(await resumeChat(it))) return;
    openChat(it.id, false);
    for (let i = 0; i < 40; i++) {
      const now = findItem(it.key);
      const ta = $('#focus-detail .composer-input');
      if (now && now.state !== 'exited' && ta && !ta.disabled) { ta.focus(); return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Continue a terminal or outside session as a chat here (same conversation).
  async function continueHere(it) {
    const external = it.kind === 'external';
    const ok = await Deck.confirm({
      title: 'Continue this conversation here?',
      body: external
        ? 'Claude is stopped in the terminal where it was started, then the same conversation continues here in Claude Deck.'
        : 'Its Windows Terminal tab closes, then the same conversation continues here in Claude Deck.',
      ok: 'Continue here',
    });
    if (!ok) return;
    const path = external ? `/api/external/${it.pid}/to-chat` : `/api/sessions/${it.id}/to-chat`;
    const c = await run("Couldn't move the session", () => api('POST', path));
    if (!c) return;
    if (c.kind === 'embedded') openTerminal(c.id);
    else openChat(c.id);
  }

  async function continueInTerminal(it) {
    const ok = await Deck.confirm({ title: 'Continue in Windows Terminal?', body: 'This chat ends here and the same conversation opens in a Windows Terminal tab, with the full terminal interface.', ok: 'Open in terminal' });
    if (!ok) return;
    const res = await run("Couldn't move the chat", () => api('POST', `/api/chats/${it.id}/to-terminal`));
    if (res) toast('Continuing in Windows Terminal');
  }

  // A terminal in the window, continued elsewhere: in a Windows Terminal tab, or as a chat.
  async function moveEmbedded(it, target) {
    const toTab = target === 'terminal';
    const ok = await Deck.confirm({
      title: toTab ? 'Continue in Windows Terminal?' : 'Continue as a chat?',
      body: toTab ? 'This terminal ends here and the same conversation opens in a Windows Terminal tab.' : "This terminal ends and the same conversation continues as a chat here, with the dashboard's own reply box.",
      ok: toTab ? 'Open in terminal' : 'Continue as a chat',
    });
    if (!ok) return;
    const res = await run("Couldn't move the session", () => api('POST', `/api/terminals/${it.id}/${toTab ? 'to-terminal' : 'to-chat'}`));
    if (!res) return;
    if (toTab) toast('Continuing in Windows Terminal');
    else openChat(res.id);
  }

  async function dismiss(it) {
    await run("Couldn't dismiss", () => api('POST', `/api/sessions/${it.id}/dismiss`));
  }

  // The name plate is edited where it sits: Enter saves, Esc puts it back. Without the header on
  // screen (another session selected), it asks in a small dialog instead.
  async function rename(it) {
    const base = isChat(it) ? '/api/chats' : isEmbedded(it) ? '/api/terminals' : '/api/sessions';
    const save = (name) => run("Couldn't rename", () => api('PATCH', `${base}/${it.id}`, { name }));
    const plate = S.selected === it.key ? $('#focus-detail .head-title h2') : null;
    if (!plate) {
      const name = await Deck.promptText({ title: 'Rename session', label: 'Name shown in Claude Deck', value: it.name || '' });
      if (name !== null) await save(name);
      return;
    }
    const input = h('input', { type: 'text', class: 'rename-input', value: it.name || heading(it), 'aria-label': 'Session name', spellcheck: 'false' });
    let done = false;
    const finish = async (keep) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      input.replaceWith(plate);
      if (keep && name !== (it.name || '')) await save(name);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    plate.replaceWith(input);
    input.focus();
    input.select();
  }

  async function recolor(it, color) {
    const base = isChat(it) ? '/api/chats' : isEmbedded(it) ? '/api/terminals' : '/api/sessions';
    await run("Couldn't change the color", () => api('PATCH', `${base}/${it.id}`, { color }));
  }

  function openFolder(p) {
    if (p) run("Couldn't open the folder", () => api('POST', '/api/open-folder', { path: p }));
  }

  // Answer a permission prompt or question for a chat.
  async function answer(chatId, requestId, decision) {
    return run("Couldn't send the answer", () => api('POST', `/api/chats/${chatId}/respond`, { requestId, ...decision }));
  }

  // ---- session list --------------------------------------------------------------------------
  // Claude's own title for the conversation, when it adds something beyond the name.
  function subtitle(it) {
    return it.name && it.title && it.title.trim().toLowerCase() !== it.name.trim().toLowerCase() ? it.title : null;
  }

  function emptyState() {
    return h('div', { class: 'empty' },
      h('h2', null, 'No Claude sessions running'),
      h('p', null, "Start one here and reply to it right from the dashboard, in Claude Deck's own chat or Claude Code's own interface. Sessions you start in other terminals show up here too."),
      h('button', { class: 'primary', onclick: () => openLaunch() }, 'New session'),
      h('p', { class: 'faint', style: { marginTop: '14px' } }, 'Or pick up an old conversation from History.'));
  }

  // ---- usage by session ----------------------------------------------------------------------
  // Which conversations used the most tokens this week, from their transcripts (src/history.js).
  // Pinned at the top of the session list; shown in the detail pane. Refreshed at most once a
  // minute while it's shown.
  const USAGE_KEY = 'usage';
  const WEEK_TOP = 10;
  const WEEK_REFRESH_MS = 60000;

  function loadWeekUsage() {
    if (S.week && (S.week.loading || Date.now() - S.week.fetchedAt < WEEK_REFRESH_MS)) return;
    S.week = { ...(S.week || { data: null }), loading: true, fetchedAt: Date.now() };
    api('GET', '/api/usage/sessions')
      .then((data) => { S.week = { data, loading: false, fetchedAt: Date.now() }; })
      .catch(() => { S.week = { ...S.week, loading: false }; })
      .finally(() => { if (S.view === 'sessions' && S.selected === USAGE_KEY) renderFocusDetail(); });
  }

  function weekSinceText(d) {
    return d.basis === 'plan' ? `Since your plan's weekly limit reset, ${when(d.since)}` : 'The last 7 days';
  }

  // A conversation from the list: the live session if it's in the session list, otherwise History.
  function openUsageSession(r) {
    const it = allItems().find((x) => x.sessionId === r.sessionId);
    if (it) {
      if (isChat(it)) openChat(it.id);
      else showDetails(it.key);
      return;
    }
    S.historySel = r.sessionId;
    S.historyReveal = r.sessionId;
    $('#history-search').value = '';
    $('#history-folder').value = '';
    setView('history');
  }

  function weekRow(r, i, max) {
    const it = allItems().find((x) => x.sessionId === r.sessionId);
    const running = r.open || Boolean(it && it.state !== 'exited' && it.state !== 'failed');
    return h('li', null, h('button', { type: 'button', class: 'week-row', onclick: () => openUsageSession(r), title: `${r.tokens.toLocaleString()} tokens. ${it ? 'Show the session' : 'Show it in History'}` },
      h('span', { class: 'week-rank faint' }, String(i + 1)),
      h('span', { class: 'week-text' },
        h('span', { class: 'week-title' }, (it && heading(it)) || r.title || 'Untitled conversation'),
        h('span', { class: 'week-sub faint' },
          running ? h('span', { class: 'live' }, 'Open now') : null,
          h('span', { class: 'path', title: r.cwd || '' }, shortPath(r.cwd)),
          r.updatedAt ? h('span', null, ago(r.updatedAt)) : null)),
      h('span', { class: 'week-bar', 'aria-hidden': 'true' }, h('span', { class: 'week-fill', style: { width: `${Math.max(2, Math.round((r.tokens / max) * 100))}%` } })),
      h('span', { class: 'week-tokens' }, tokenText(r.tokens))));
  }

  function weekList(rows) {
    const max = rows.length ? rows[0].tokens : 1;
    return h('ol', { class: 'week-list' }, rows.map((r, i) => weekRow(r, i, max)));
  }

  function weekPanel() {
    const d = S.week && S.week.data;
    const rows = d ? d.sessions : [];
    const total = rows.reduce((n, r) => n + r.tokens, 0);
    return h('section', { class: 'lane week-usage', 'aria-label': 'Most tokens this week' },
      h('div', { class: 'lane-head' },
        h('h2', null, 'Most tokens this week'),
        d ? h('span', { class: 'faint small', title: 'Tokens from every conversation\'s transcript, subagents included' }, `${weekSinceText(d)} · ${tokenText(total)} tokens across ${rows.length} conversation${rows.length === 1 ? '' : 's'}`) : null,
        h('span', { class: 'spacer' }),
        rows.length > WEEK_TOP ? h('button', { type: 'button', class: 'ghost small', onclick: showWeekDialog }, `Show all ${rows.length}`) : null),
      !d ? h('p', { class: 'faint small' }, S.week && S.week.loading ? 'Adding up this week\'s usage…' : 'Usage by session isn\'t available right now.')
        : !rows.length ? h('p', { class: 'faint small' }, 'No Claude Code usage this week yet.')
          : weekList(rows.slice(0, WEEK_TOP)));
  }

  function showWeekDialog() {
    const d = S.week && S.week.data;
    if (!d) return;
    const search = h('input', { type: 'search', placeholder: 'Filter by title or folder', 'aria-label': 'Filter conversations' });
    const body = h('div', { class: 'week-all' });
    const fill = () => {
      clear(body);
      const q = search.value.trim();
      const max = d.sessions.length ? d.sessions[0].tokens : 1;
      const rows = d.sessions.map((r, i) => ({ r, i })).filter(({ r }) => matches([r.title, r.cwd, r.sessionId], q));
      if (!rows.length) body.appendChild(h('p', { class: 'faint small' }, 'Nothing matches.'));
      else body.appendChild(h('ol', { class: 'week-list' }, rows.map(({ r, i }) => weekRow(r, i, max))));
    };
    search.addEventListener('input', fill);
    const dlg = h('dialog', { class: 'dialog week-dialog', 'aria-label': 'Tokens by conversation this week' },
      h('h2', null, 'Tokens by conversation this week'),
      h('p', { class: 'faint small' }, `${weekSinceText(d)}. Tokens from each conversation's transcript, subagents included.`),
      search,
      body,
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'primary', onclick: () => dlg.close() }, 'Close')));
    // Opening a conversation from the list closes the list.
    body.addEventListener('click', (e) => { if (e.target.closest('.week-row')) dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    fill();
    dlg.showModal();
  }

  // ---- focus layout --------------------------------------------------------------------------
  // The trash button on a session's row: what it does depends on the session.
  function rowRemoval(it) {
    const ended = it.state === 'exited' || it.state === 'failed';
    if (isTerminal(it) && it.state === 'failed') return { title: 'Dismiss this session', run: () => dismiss(it) };
    if (ended) return { title: isTerminal(it) ? 'Close this tab' : `Remove this ${isChat(it) ? 'chat' : 'terminal'} from the list (the conversation stays in History)`, run: () => endSession(it) };
    return { title: 'End this session (asks first while Claude is working)', run: () => endSession(it) };
  }

  function renderFocusList() {
    const list = $('#focus-list');
    const scroll = list.scrollTop;
    // The list is rebuilt on every update; keyboard focus goes back to the same row or trash button.
    const active = list.contains(document.activeElement) ? document.activeElement : null;
    const activeItem = active && active.closest('.focus-item');
    const refocus = activeItem ? { key: activeItem.querySelector('[data-key]').dataset.key, del: active.classList.contains('fr-del') } : null;
    clear(list);
    const groups = visibleItems();
    if (!groups.some((g) => g.items.length)) {
      list.appendChild(h('p', { class: 'faint', style: { padding: '12px' } }, allItems().length ? 'No sessions match that filter.' : 'No sessions running.'));
      restoreListFocus(list, refocus);
      return;
    }
    for (const { lane, items } of groups) {
      if (!items.length) continue;
      list.appendChild(h('div', { class: 'focus-group', role: 'heading', 'aria-level': '2' }, h('span', { class: `lamp ${lane.key}` }), `${lane.label} (${items.length})`));
      for (const it of items) {
        const removal = rowRemoval(it);
        list.appendChild(h('div', { class: 'focus-item' },
          h('button', {
            // route-set: this line was just picked, so its plate runs into the reading shelf once.
            class: `focus-row${S.routeSet === it.key ? ' route-set' : ''}`,
            title: heading(it),
            'aria-current': S.selected === it.key ? 'true' : null,
            dataset: { key: it.key },
            style: it.deck ? { '--tag': `var(--c-${it.color || 'slate'})` } : null,
            onclick: () => select(it.key),
            ondblclick: () => openSession(it),
          },
          h('span', { class: `lamp ${it.lane}` }),
          h('span', { class: 'fr-text' },
            h('div', { class: 'fr-title' }, heading(it)),
            h('div', { class: 'fr-sub' }, h('span', null, isChat(it) ? 'Chat' : isEmbedded(it) ? 'Terminal' : isTerminal(it) ? 'Windows Terminal' : 'Outside'), h('span', null, shortPath(it.cwd, 1)), it.statusSince ? h('span', null, ago(it.statusSince)) : null))),
          h('button', { type: 'button', class: 'ghost icon fr-del', title: removal.title, 'aria-label': `${removal.title}: ${heading(it)}`, onclick: removal.run }, trashIcon())));
      }
    }
    list.scrollTop = scroll;
    restoreListFocus(list, refocus);
  }

  function restoreListFocus(list, refocus) {
    if (!refocus) return;
    const row = list.querySelector(`[data-key="${CSS.escape(refocus.key)}"]`);
    const target = row && refocus.del ? row.parentElement.querySelector('.fr-del') : row;
    if (target) target.focus({ preventScroll: true });
    else list.focus({ preventScroll: true }); // that session is gone; stay in the list
  }

  function fact(label, value, mono) {
    if (value === null || value === undefined || value === '') return null;
    return h('div', null, h('dt', null, label), h('dd', { class: mono ? 'mono' : null }, value instanceof Node ? value : String(value)));
  }

  // What's in the ▾ menu beside a session's title, top to bottom. Tag color opens a fly-out.
  function sessionMenuItems(it) {
    const items = [];
    const cmd = resumeCommand(it);
    const changes = it.sessionId ? { label: S.showChanges[it.key] ? 'Back to the conversation' : 'Changes', title: 'Files Claude changed in each turn, with diffs and restore', run: () => toggleChanges(it) } : null;
    if (it.deck && !(isTerminal(it) && it.state === 'failed')) {
      items.push({ label: 'Rename', run: () => rename(it) });
      items.push({ label: 'Tag color', colors: true });
    }
    if (changes && !(isTerminal(it) && it.state === 'failed')) items.push(changes);
    if (isChat(it)) {
      if (it.sessionId) items.push({ label: 'Continue in terminal', title: 'Continue this conversation in a Windows Terminal tab', run: () => continueInTerminal(it) });
      if (it.state !== 'exited') items.push({ label: 'Go back to an earlier message…', title: 'Claude forgets everything from one of your messages on, and the message comes back to the reply box (Esc Esc)', run: () => { if (S.rewindHere && S.rewindHere.chatId === it.id) S.rewindHere.run(); } });
      items.push({ label: S.showTasks[it.id] ? 'Hide subagents' : it.taskCount ? `Subagents (${it.taskCount})` : 'Subagents', title: 'Subagents Claude started in this chat', run: () => setTasksPanel(it.id, !S.showTasks[it.id]) });
      if (it.state !== 'exited') items.push({ label: 'Config…', title: "Claude Code's /config options: theme, editor mode, auto-compact and the rest", run: () => openConfig(it) });
    } else if (isEmbedded(it)) {
      if (it.sessionId) {
        items.push({ label: 'Continue in Windows Terminal', title: 'Continue this conversation in a Windows Terminal tab', run: () => moveEmbedded(it, 'terminal') });
        items.push({ label: 'Continue as a chat', title: "Continue this conversation as a chat, with the dashboard's own reply box", run: () => moveEmbedded(it, 'chat') });
      }
      if (cmd) items.push({ label: 'Copy resume command', run: () => copy(cmd, 'Resume command copied') });
    } else {
      if (isTerminal(it) && it.state !== 'failed' && it.sessionId) items.push({ label: 'Continue here', title: 'Close the tab and continue this conversation here', run: () => continueHere(it) });
      if (cmd) items.push({ label: 'Copy resume command', run: () => copy(cmd, 'Resume command copied') });
    }
    return items;
  }

  // The menu lives on <body>, like the plugins menu, because the header is rebuilt whenever the
  // session's status changes.
  const headMenu = { el: null, btn: null, key: null };

  function closeHeadMenu() {
    if (!headMenu.el) return;
    headMenu.el.remove();
    if (headMenu.btn) headMenu.btn.setAttribute('aria-expanded', 'false');
    headMenu.el = null;
    headMenu.key = null;
  }

  function toggleHeadMenu(it, btn) {
    if (headMenu.key === it.key) { closeHeadMenu(); return; }
    closeHeadMenu();
    const menuItem = (label, onclick, extra = {}) => h('button', { type: 'button', role: 'menuitem', class: 'hm-item', onclick, ...extra }, label);
    const colors = () => h('div', { class: 'hm-menu hm-sub', role: 'menu', 'aria-label': 'Tag color' },
      Object.entries(COLOR_NAMES).map(([k, v]) => menuItem([h('span', { class: 'hm-swatch', style: { '--tag': `var(--c-${k})` } }), v, k === (it.color || 'slate') ? h('span', { class: 'hm-check' }, Deck.icon('check', { size: 12 })) : null],
        () => { closeHeadMenu(); recolor(it, k); }, { role: 'menuitemradio', 'aria-checked': String(k === (it.color || 'slate')) })));
    const el = h('div', { class: 'hm-menu', role: 'menu', 'aria-label': 'Session actions' },
      sessionMenuItems(it).map((m) => {
        if (!m.colors) return menuItem(m.label, () => { closeHeadMenu(); m.run(); }, { title: m.title || null });
        const wrap = h('div', { class: 'hm-flyout' });
        const open = () => { if (!wrap.querySelector('.hm-sub')) wrap.appendChild(colors()); };
        const trigger = menuItem([m.label, h('span', { class: 'hm-arrow' }, Deck.icon('right', { size: 12 }))], (e) => { e.stopPropagation(); open(); const first = wrap.querySelector('.hm-sub .hm-item'); if (first) first.focus(); }, { 'aria-haspopup': 'menu' });
        wrap.appendChild(trigger);
        wrap.addEventListener('mouseenter', open);
        wrap.addEventListener('mouseleave', () => { const sub = wrap.querySelector('.hm-sub'); if (sub && !sub.contains(document.activeElement)) sub.remove(); });
        wrap.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' && e.target === trigger) { e.preventDefault(); trigger.click(); }
          if (e.key === 'ArrowLeft' && e.target !== trigger) { e.preventDefault(); e.stopPropagation(); const sub = wrap.querySelector('.hm-sub'); if (sub) sub.remove(); trigger.focus(); }
        });
        return wrap;
      }));
    el.addEventListener('click', (e) => e.stopPropagation());
    // Up and down move between the items of the (sub)menu that has focus.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const menu = document.activeElement && document.activeElement.closest('.hm-menu');
      if (!menu) return;
      const list = [...menu.querySelectorAll(':scope > .hm-item, :scope > .hm-flyout > .hm-item')];
      const i = list.indexOf(document.activeElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
    });
    document.body.appendChild(el);
    Object.assign(headMenu, { el, btn, key: it.key });
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    el.style.top = `${Math.round(r.bottom + 4)}px`;
    el.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)))}px`;
    const first = el.querySelector('.hm-item');
    if (first) first.focus();
  }

  document.addEventListener('click', closeHeadMenu);
  window.addEventListener('resize', closeHeadMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !headMenu.el) return;
    e.stopPropagation();
    const b = headMenu.btn;
    closeHeadMenu();
    if (b && b.isConnected) b.focus();
  }, true);

  // Claude Code's /config options for a running chat, read and changed through the chat's own Claude
  // Code (src/claude-config.js): its own list, so new options appear as Claude Code adds them.
  const CONFIG_WHERE = { user: 'All sessions', global: 'All sessions', local: 'This folder only' };
  async function openConfig(it) {
    const list = h('div', { class: 'config-list' }, h('p', { class: 'muted' }, 'Asking Claude Code for its options…'));
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const saveBtn = h('button', { type: 'button', class: 'primary', disabled: true }, 'Save');
    const dlg = h('dialog', { class: 'dialog config-dialog', 'aria-labelledby': 'config-title' },
      h('h2', { id: 'config-title' }, 'Claude Code config'),
      h('p', { class: 'muted' }, "The options Claude Code's /config command offers. Claude Code saves each change itself, in its own settings. Some only take effect in new or resumed sessions."),
      list,
      error,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'Close'),
        saveBtn));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();

    const changes = {};
    const showError = (msg) => { error.textContent = msg; error.hidden = !msg; };
    const row = (o) => {
      const mark = (v) => {
        if (v === (o.value || '')) delete changes[o.key]; else changes[o.key] = v;
        r.classList.toggle('changed', o.key in changes);
        saveBtn.disabled = !Object.keys(changes).length;
      };
      // A choice from Claude Code's own values; "Not set" stands for its default, which /config can't go back to.
      // Nor can a free-text option be emptied: clearing the box leaves its value as it is.
      const control = o.values
        ? h('select', { 'aria-label': o.label, onchange: (e) => mark(e.target.value) },
          o.value === null ? h('option', { value: '', selected: true, disabled: true }, 'Not set (default)') : null,
          o.value !== null && !o.values.includes(o.value) ? h('option', { value: o.value, selected: true }, o.value) : null,
          o.values.map((v) => h('option', { value: v, selected: v === o.value }, v)))
        : h('input', {
          type: 'text',
          value: o.value || '',
          placeholder: o.value === null ? 'Not set (default)' : '',
          title: o.value === null ? null : "Claude Code can't unset an option: leaving this empty keeps the current value",
          'aria-label': o.label,
          oninput: (e) => mark(e.target.value.trim() || o.value || ''),
        });
      const r = h('div', { class: 'config-row' },
        h('div', null,
          h('div', { class: 'config-label' }, o.label),
          h('div', { class: 'config-where' }, `${o.key}${o.where ? ` · ${CONFIG_WHERE[o.where]}` : ''}`)),
        control);
      return r;
    };
    const load = async () => {
      try {
        const res = await api('GET', `/api/chats/${it.id}/config`);
        for (const k of Object.keys(changes)) delete changes[k];
        saveBtn.disabled = true;
        clear(list).append(...res.options.map(row));
      } catch (err) {
        clear(list).append(h('p', { class: 'muted' }, "Couldn't read Claude Code's options."));
        showError(err.message);
      }
    };
    saveBtn.addEventListener('click', async () => {
      showError('');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const res = await api('POST', `/api/chats/${it.id}/config`, { changes });
        const problems = res.lines.filter((l) => !/^Set /.test(l));
        if (problems.length) showError(problems.join('\n'));
        else toast(res.lines.length === 1 ? res.lines[0] : `Saved ${res.lines.length} changes`);
      } catch (err) {
        showError(err.message);
      } finally {
        saveBtn.textContent = 'Save';
      }
      await load();
    });
    await load();
  }

  function setTasksPanel(chatId, open) {
    S.showTasks[chatId] = open;
    S.headSig = null;
    renderFocusDetail();
    renderTasksPanel();
  }

  function detailHead(it) {
    // The one or two buttons that stay out of the menu, with End on the right of the controls.
    const acts = [];
    if (isChat(it)) {
      if (it.state === 'exited') acts.push(h('button', { class: 'primary small', onclick: () => resumeChat(it) }, 'Resume'));
      acts.push(h('button', { class: 'danger small', onclick: () => endSession(it) }, it.state === 'exited' ? 'Remove' : 'End session'));
    } else if (isEmbedded(it)) {
      if (canResumeEmbedded(it)) acts.push(h('button', { class: 'primary small', onclick: () => resumeEmbedded(it) }, 'Resume'));
      acts.push(h('button', { class: 'danger small', onclick: () => endSession(it) }, it.state === 'running' ? 'End session' : 'Remove'));
    } else if (isTerminal(it)) {
      if (it.state !== 'failed') acts.push(h('button', { class: 'primary small', onclick: () => openSession(it) }, it.state === 'exited' ? 'Resume' : 'Open terminal'));
      if (it.state === 'failed') acts.push(h('button', { class: 'ghost small', onclick: () => dismiss(it) }, 'Dismiss'));
      else acts.push(h('button', { class: 'danger small', onclick: () => endSession(it) }, it.state === 'exited' ? 'Close tab' : 'End session'));
    } else {
      if (it.sessionId && it.cwd) acts.push(h('button', { class: 'primary small', onclick: () => continueHere(it) }, 'Continue here'));
      acts.push(h('button', { class: 'danger small', onclick: () => endSession(it) }, 'End session'));
    }

    // Running chats get pickers; everything else shows what's known as text.
    let modelFact = it.model;
    let effortFact = isChat(it) ? it.requestedEffort || null : null;
    let modeFact = isChat(it) ? it.permissionMode || null : null;
    if (isChat(it) && it.state !== 'exited') {
      // "claude-" left off the default's name, to keep the control row on one line.
      modelFact = Deck.modelPicker(S.boot.models, it.requestedModel || '',(m) => run("Couldn't change the model", () => api('POST', `/api/chats/${it.id}/model`, { model: m })), `Default (${it.model ? it.model.replace(/^claude-/, '') : 'from settings'})`);
      effortFact = h('select', { class: 'small', 'aria-label': 'Effort', onchange: (e) => run("Couldn't change the effort", () => api('POST', `/api/chats/${it.id}/effort`, { effort: e.target.value })) },
        h('option', { value: '' }, 'Default'),
        S.boot.enums.efforts.map((v) => h('option', { value: v, selected: v === it.requestedEffort }, v)));
      const modes = ['default', ...S.boot.enums.permissionModes.filter((m) => m !== 'manual')];
      modeFact = h('select', { class: 'small', 'aria-label': 'Permission mode', onchange: (e) => run("Couldn't change the permission mode", () => api('POST', `/api/chats/${it.id}/mode`, { mode: e.target.value })) },
        modes.map((m) => h('option', { value: m, selected: m === (it.permissionMode || 'default') }, m)));
    }
    // One row of controls and meters under the title.
    // Cost and tokens read like the context meter: the value, and what the latest turn added.
    const reading = (value, change) => (value === null || value === undefined || value === '' ? null : h('span', { class: 'reading' }, value, change));
    const costNow = money(it.costUSD);
    const controls = [fact('Model', modelFact), fact('Effort', effortFact), isChat(it) && it.fast ? fact('Fast mode', fastToggle(it)) : null, fact('Permissions', modeFact), isChat(it) ? fact('Plugins', pluginsButton(it)) : null,
      isChat(it) && it.state !== 'exited' ? fact('MCP servers', mcpButton(it)) : null,
      contextFact(it),
      fact('Current cost', reading(costNow, costNow ? turnChange(it, 'cost', it.costUSD, money) : null)),
      fact('Current total tokens', reading(tokensFact(it.tokens), turnChange(it, 'tokens', tokenSum(it.tokens), tokenText)))].filter(Boolean);
    const menuItems = sessionMenuItems(it);
    const menuBtn = menuItems.length ? h('button', {
      type: 'button',
      class: 'ghost icon head-menu-btn',
      title: 'Session actions',
      'aria-label': 'Session actions',
      'aria-haspopup': 'menu',
      'aria-expanded': String(headMenu.key === it.key),
      onclick: (e) => { e.stopPropagation(); toggleHeadMenu(it, menuBtn); },
    }, Deck.icon('down')) : null;
    if (menuBtn && headMenu.key === it.key) headMenu.btn = menuBtn;
    const extra = [
      it.gitBranch && it.gitBranch !== 'HEAD' ? h('span', { class: 'head-id head-branch', title: `Git branch: ${it.gitBranch}` }, Deck.icon('branch', { size: 12 }), it.gitBranch) : null,
      it.userTurns ? h('span', { class: 'head-id' }, `${it.userTurns} prompt${it.userTurns === 1 ? '' : 's'}`) : null,
      isTerminal(it) && it.windowName ? h('span', { class: 'head-id' }, `Window ${it.windowName}`) : null,
      it.kind === 'external' && it.pid ? h('span', { class: 'head-id' }, `Process ${it.pid}`) : null,
    ];

    const iconBtn = (name, title, onclick) => h('button', { type: 'button', class: 'ghost icon small', title, 'aria-label': title, onclick }, Deck.icon(name, { size: 13 }));
    return h('div', { class: 'detail-head' },
      // The line plate: its lamp and name, what it's doing, then branch, prompt count and the like.
      h('div', { class: 'head-title' },
        h('span', { class: `lamp ${it.lane}` }),
        h('h2', { title: it.deck ? 'Double-click to rename (F2)' : null, ondblclick: it.deck ? () => rename(it) : null }, heading(it)),
        menuBtn,
        h('span', { class: `status-text ${it.lane}` }, statusLabel(it)),
        it.statusSince ? h('span', { class: 'faint head-since', 'data-since': String(it.statusSince) }, sinceText(it.statusSince)) : null,
        isChat(it) && it.runningTasks ? h('button', { type: 'button', class: 'head-badge', title: 'Show the subagents', onclick: () => setTasksPanel(it.id, true) }, `${it.runningTasks} subagent${it.runningTasks === 1 ? '' : 's'} active`) : null,
        h('span', { class: 'head-extra' }, extra)),
      // Where the session is, on the same line: the folder gets the rest of it.
      it.cwd || it.sessionId ? h('div', { class: 'head-meta' },
        it.cwd ? h('span', { class: 'head-id row-path head-folder' },
          // Cut from the start if it doesn't fit, so the folder's own name stays visible.
          h('span', { class: 'path-text', title: it.cwd }, h('bdi', null, it.cwd)),
          iconBtn('copy', 'Copy folder path', () => copy(it.cwd, 'Folder path copied')),
          iconBtn('open', 'Open folder in Explorer', () => openFolder(it.cwd))) : null,
        it.sessionId ? h('span', { class: 'head-id row-path' },
          h('span', { class: 'mono', title: 'Session ID' }, it.sessionId),
          // No Stop button here: the reply box's Interrupt stops Claude (with nothing typed, it just stops).
          iconBtn('copy', 'Copy session ID', () => copy(it.sessionId, 'Session ID copied'))) : null) : null,
      // Resume, End and the like close the line, leaving the instrument row to controls and meters.
      h('div', { class: 'head-cta' }, acts),
      subtitle(it) ? h('div', { class: 'muted' }, subtitle(it)) : null,
      it.note ? h('p', { class: 'faint', style: { margin: '6px 0 0' } }, it.note) : null,
      it.kind === 'external' ? h('p', { class: 'faint', style: { margin: '6px 0 0' } }, 'Started outside Claude Deck. Choose Continue here to reply to it from the dashboard.') : null,
      it.state === 'failed' && it.launchError ? h('p', { class: 'error' }, it.launchError) : null,
      controls.length ? h('div', { class: 'head-controls' }, h('dl', { class: 'facts' }, controls)) : h('div', { class: 'head-gap' }));
  }

  // Fast mode, as Claude Code's /fast: faster replies, billed as extra usage on top of the plan, so
  // it can only be turned on with Allow API billing (Claude Deck Preferences → Billing).
  function fastToggle(it) {
    const on = it.fast.state === 'on' || it.fast.state === 'cooldown';
    const allowed = on || S.prefs.allowApiBilling;
    const title = !allowed
      ? 'Fast mode is billed as extra usage, on top of your plan. Turn on Allow API billing in Claude Deck Preferences to use it.'
      : it.fast.state === 'cooldown' ? 'Fast mode is cooling down after a rate limit; replies use the normal speed for now.' : 'Faster replies, billed as extra usage on top of your plan';
    return h('label', { class: 'check fast-toggle', title },
      h('input', { type: 'checkbox', checked: on, disabled: !allowed, 'aria-label': 'Fast mode', onchange: (e) => run("Couldn't change fast mode", () => api('POST', `/api/chats/${it.id}/fast`, { on: e.target.checked })) }),
      it.fast.state === 'cooldown' ? 'Cooling down' : on ? 'On' : 'Off');
  }

  // ---- cost, tokens and context (chat header) ------------------------------------------------
  // Current cost and Current total tokens are the current conversation's; both start again after
  // /clear, which starts a new conversation.
  function tokenBreakdown(t) {
    return `Input ${t.input.toLocaleString()} · Output ${t.output.toLocaleString()} · Cache read ${t.cacheRead.toLocaleString()} · Cache write ${t.cacheWrite.toLocaleString()}`;
  }

  const tokenSum = (t) => (t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0);

  // What a reading gained (or lost) since the page last saw it change, shown beside it like an
  // instrument's trend: "+1.2k". Nothing until it has changed once while the page was open.
  function turnChange(it, key, value, fmt) {
    if (typeof value !== 'number') return null;
    S.readings = S.readings || {};
    const k = `${it.id}:${key}`;
    const seen = S.readings[k];
    if (!seen || seen.value !== value) S.readings[k] = { value, delta: seen ? value - seen.value : 0 };
    const d = S.readings[k].delta;
    // A change too small to show (a fraction of a cent) isn't worth a "+$0.00".
    if (!d || fmt(Math.abs(d)) === fmt(0)) return null;
    return h('span', { class: `ctx-delta${d < 0 ? ' down' : ''}`, title: d > 0 ? 'Added by the latest turn' : 'Since the last reading' }, `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}`);
  }

  function tokensFact(t) {
    if (!tokenSum(t)) return null;
    return h('span', { title: `The current conversation's tokens. ${tokenBreakdown(t)}. Subagents included.` }, tokenText(tokenSum(t)));
  }

  // The whole Context fact: Compact sits in its label line, above the meter.
  function contextFact(it) {
    const c = it.context;
    if (!c) return null;
    const pct = c.max ? (typeof c.percent === 'number' ? c.percent : Math.round((c.tokens / c.max) * 100)) : null;
    const level = pct === null ? 'ok' : pct >= 90 ? 'over' : pct >= 75 ? 'warn' : 'ok';
    const label = c.max ? `${tokenText(c.tokens)} / ${tokenText(c.max)} (${pct}%)` : tokenText(c.tokens);
    const canCompact = isChat(it) && it.state !== 'exited' && it.sessionId;
    // Like an instrument, the meter shows the change as well as the value: what the latest turn
    // added (or compacting took away), and the needle moves there from where it was.
    S.ctxSeen = S.ctxSeen || {};
    const seen = S.ctxSeen[it.id];
    if (!seen || seen.tokens !== c.tokens) S.ctxSeen[it.id] = { tokens: c.tokens, delta: seen ? c.tokens - seen.tokens : 0, pct: seen ? seen.pct : pct };
    const now = S.ctxSeen[it.id];
    const from = now.pct === null || now.pct === undefined ? pct : now.pct;
    const needle = (p) => `scaleX(${Math.min(100, Math.max(0, p)) / 100})`;
    const fill = h('span', { class: 'ufill', style: { transform: needle(from) } });
    if (from !== pct) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.transform = needle(pct); now.pct = pct; }));
    const delta = now.delta ? h('span', { class: `ctx-delta${now.delta < 0 ? ' down' : ''}`, title: now.delta > 0 ? 'Added by the latest turn' : 'Freed since the last reading' }, `${now.delta > 0 ? '+' : '−'}${tokenText(Math.abs(now.delta))}`) : null;
    return h('div', { class: 'ctx-fact' },
      h('dt', null, 'Context',
        canCompact ? h('button', { type: 'button', class: 'ghost small ctx-compact', disabled: it.status === 'busy', title: it.status === 'busy' ? 'Wait for Claude to finish, then compact' : 'Summarize the conversation so far to free up context (/compact)', onclick: () => compactChat(it) }, 'Compact') : null),
      h('dd', { class: 'ctx-meter', title: c.max ? `${c.tokens.toLocaleString()} of ${c.max.toLocaleString()} tokens in Claude's context window` : `${c.tokens.toLocaleString()} tokens in the context window as of the latest reply` },
        c.max ? h('span', { class: `ubar ${level}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': `Context ${pct}% full` },
          fill) : null,
        h('span', null, label),
        delta));
  }

  async function compactChat(it) {
    const ok = await Deck.confirm({
      title: 'Compact this conversation?',
      body: 'Claude replaces the conversation so far with a summary, which frees up context. Details from earlier turns may be left out of the summary.',
      ok: 'Compact',
    });
    if (ok) await run("Couldn't compact the conversation", () => api('POST', `/api/chats/${it.id}/compact`));
  }

  // ---- plugins menu (chat header) ------------------------------------------------------------
  // Claude Code's plugins, through its own CLI (src/plugins.js). A change applies to every Claude
  // Code session; the chat whose menu it is picks it up at once (reload_plugins). The menu lives on
  // <body>, not in the header, because the header is rebuilt whenever the chat's status changes.
  const plugins = { byCwd: new Map(), loading: new Map(), pop: null, search: '', openCategories: new Set(), card: null };
  const PLUGIN_CARD_DELAY_MS = 300;

  // A plugin's full name and description, beside the menu, while its row is hovered or focused
  // (the row itself shows two lines of the description).
  function withPluginCard(rowEl, pl) {
    let timer = null;
    const show = () => {
      hidePluginCard();
      const pop = plugins.pop && plugins.pop.el;
      if (!pop || !rowEl.isConnected) return;
      const facts = [
        pl.marketplace,
        pl.category ? pl.category.charAt(0).toUpperCase() + pl.category.slice(1) : null,
        pl.installCount ? `${pl.installCount.toLocaleString()} installs` : null,
        pl.version ? `version ${pl.version}` : null,
      ].filter(Boolean).join(' · ');
      const card = h('div', { class: 'pp-card', role: 'tooltip' },
        h('strong', null, pl.name),
        facts ? h('small', { class: 'faint' }, facts) : null,
        h('p', null, pl.description || 'No description.'),
        h('code', null, pl.id));
      document.body.appendChild(card);
      const box = pop.getBoundingClientRect();
      const row = rowEl.getBoundingClientRect();
      let left = box.left - card.offsetWidth - 8;
      if (left < 8) left = Math.min(box.right + 8, window.innerWidth - card.offsetWidth - 8);
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(Math.max(8, Math.min(row.top, window.innerHeight - card.offsetHeight - 8)))}px`;
      plugins.card = card;
    };
    const hide = () => { clearTimeout(timer); hidePluginCard(); };
    rowEl.addEventListener('mouseenter', () => { clearTimeout(timer); timer = setTimeout(show, PLUGIN_CARD_DELAY_MS); });
    rowEl.addEventListener('mouseleave', hide);
    rowEl.addEventListener('focusin', show);
    rowEl.addEventListener('focusout', hide);
    return rowEl;
  }

  function hidePluginCard() {
    if (plugins.card) plugins.card.remove();
    plugins.card = null;
  }

  function pluginSummary(list) {
    if (!list) return 'Plugins';
    const on = list.installed.filter((p) => p.enabled).length;
    return list.installed.length ? `${on} of ${list.installed.length} on` : 'None installed';
  }

  function loadPlugins(cwd, refresh) {
    const key = cwd || '';
    if (!refresh && plugins.loading.has(key)) return plugins.loading.get(key);
    const req = api('GET', `/api/plugins?cwd=${encodeURIComponent(key)}${refresh ? '&refresh=1' : ''}`)
      .then((list) => { plugins.byCwd.set(key, list); return list; })
      .finally(() => plugins.loading.delete(key));
    plugins.loading.set(key, req);
    return req;
  }

  function updatePluginButtons() {
    for (const b of $$('.plugin-btn')) clear(b).append(pluginSummary(plugins.byCwd.get(b.dataset.cwd)), Deck.icon('down', { size: 12 }));
  }

  async function refreshPlugins(cwd) {
    try { await loadPlugins(cwd, true); } catch (err) { if (plugins.pop) plugins.pop.error = err.message; }
    updatePluginButtons();
    renderPluginsMenu();
  }

  function pluginsButton(it) {
    const key = it.cwd || '';
    const btn = h('button', {
      type: 'button',
      class: 'ghost small plugin-btn',
      dataset: { cwd: key },
      'aria-haspopup': 'dialog',
      'aria-expanded': String(Boolean(plugins.pop && plugins.pop.chatId === it.id)),
      title: "Claude Code's plugins: turn them on or off, or install more",
      onclick: (e) => { e.stopPropagation(); togglePluginsMenu(it, btn); },
    }, pluginSummary(plugins.byCwd.get(key)), Deck.icon('down', { size: 12 }));
    if (!plugins.byCwd.has(key)) loadPlugins(key).then(updatePluginButtons).catch(() => {});
    if (plugins.pop && plugins.pop.chatId === it.id) plugins.pop.btn = btn;
    return btn;
  }

  function closePluginsMenu() {
    const p = plugins.pop;
    hidePluginCard();
    if (!p) return;
    p.el.remove();
    if (p.btn) p.btn.setAttribute('aria-expanded', 'false');
    plugins.pop = null;
  }

  function togglePluginsMenu(it, btn) {
    if (plugins.pop && plugins.pop.chatId === it.id) { closePluginsMenu(); return; }
    closePluginsMenu();
    closeMcpMenu();
    const el = h('div', { class: 'plugin-pop', role: 'dialog', 'aria-label': 'Plugins' });
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('scroll', hidePluginCard);
    document.body.appendChild(el);
    plugins.pop = { el, btn, chatId: it.id, cwd: it.cwd || '', busy: new Set(), error: null };
    btn.setAttribute('aria-expanded', 'true');
    renderPluginsMenu();
    const r = btn.getBoundingClientRect();
    el.style.top = `${Math.round(r.bottom + 6)}px`;
    el.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)))}px`;
    refreshPlugins(it.cwd);
  }

  function renderPluginsMenu() {
    const p = plugins.pop;
    if (!p) return;
    const list = plugins.byCwd.get(p.cwd);
    hidePluginCard();
    const el = clear(p.el);
    el.appendChild(h('div', { class: 'pp-head' },
      h('strong', null, 'Plugins'),
      h('small', { class: 'faint' }, 'Changes apply to all your Claude Code sessions. This chat picks them up right away.')));
    if (p.error) el.appendChild(h('p', { class: 'error pp-empty' }, p.error));
    if (!list) {
      if (!p.error) el.appendChild(h('p', { class: 'faint pp-empty' }, 'Loading…'));
      return;
    }
    el.appendChild(h('div', { class: 'pp-section' }, 'Installed'));
    if (!list.installed.length) el.appendChild(h('p', { class: 'faint pp-empty' }, 'No plugins installed yet. Install one from the marketplace below.'));
    for (const pl of list.installed) {
      el.appendChild(withPluginCard(h('label', { class: 'pp-row' },
        h('span', { class: 'pp-name' }, pl.name, h('small', { class: 'faint' }, pl.marketplace)),
        pl.description ? h('span', { class: 'pp-desc' }, pl.description) : null,
        h('input', { type: 'checkbox', class: 'pp-control', checked: pl.enabled, disabled: p.busy.has(pl.id), 'aria-label': `Turn ${pl.name} on`, onchange: (e) => setPluginEnabled(pl, e.target.checked) })), pl));
    }
    el.appendChild(h('div', { class: 'pp-section' }, 'Marketplace'));
    const search = h('input', { type: 'search', class: 'pp-search', value: plugins.search, placeholder: `Search ${list.available.length} plugin${list.available.length === 1 ? '' : 's'}`, spellcheck: 'false', 'aria-label': 'Search the marketplace' });
    const results = h('div', { class: 'pp-results' });
    const row = (pl) => {
      const busy = p.busy.has(pl.id);
      return withPluginCard(h('div', { class: 'pp-row' },
        h('span', { class: 'pp-name' }, pl.name, h('small', { class: 'faint' }, pl.marketplace)),
        pl.description ? h('span', { class: 'pp-desc' }, pl.description) : null,
        h('button', { type: 'button', class: 'ghost small pp-control', disabled: busy, onclick: () => installPlugin(pl) }, busy ? 'Installing…' : 'Install')), pl);
    };
    // Grouped by the category each marketplace gives its plugins (plain list if none have one).
    // Groups start closed; a search opens every group with a match.
    const fill = () => {
      const q = plugins.search.trim().toLowerCase();
      const hits = list.available.filter((pl) => !q || `${pl.name} ${pl.description} ${pl.marketplace} ${pl.category || ''}`.toLowerCase().includes(q));
      hidePluginCard();
      clear(results);
      if (!list.available.length) results.appendChild(h('p', { class: 'faint pp-empty' }, 'Nothing more to install. Add marketplaces in Claude Code Settings.'));
      else if (!hits.length) results.appendChild(h('p', { class: 'faint pp-empty' }, 'No plugins match.'));
      const groups = new Map();
      for (const pl of hits) {
        const k = pl.category || '';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(pl);
      }
      if (groups.size === 1 && groups.has('')) {
        for (const pl of hits) results.appendChild(row(pl));
        return;
      }
      const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
      for (const k of keys) {
        const items = groups.get(k);
        const group = h('details', { class: 'pp-group', open: Boolean(q) || plugins.openCategories.has(k) },
          h('summary', null, k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Uncategorized', h('small', { class: 'faint' }, String(items.length))),
          items.map(row));
        group.addEventListener('toggle', () => {
          if (q) return; // opened for the search, not by the person
          if (group.open) plugins.openCategories.add(k);
          else plugins.openCategories.delete(k);
        });
        results.appendChild(group);
      }
    };
    search.addEventListener('input', () => { plugins.search = search.value; fill(); });
    fill();
    el.appendChild(search);
    el.appendChild(results);
    el.appendChild(h('div', { class: 'pp-foot' },
      h('button', { type: 'button', class: 'link', onclick: () => { closePluginsMenu(); setView('settings'); Deck.SettingsUI.showMarketplaces(); } }, 'Manage marketplaces in Claude Code Settings')));
  }

  // What happened in the chat the change was made from.
  async function afterPluginChange(chatId, pl, what, on, reload) {
    const later = `${what}. This chat picks it up when it starts again.`;
    if (!reload || reload.reason === 'ended') return toast(later);
    if (reload.applied) return toast(`${what}, in this chat too.`);
    if (!reload.held) return toast(later);
    const ok = await Deck.confirm({
      title: 'Apply it to this chat now?',
      body: `${pl.name} changes the tools Claude has. Applying that mid-conversation makes Claude's next reply re-read the whole conversation instead of using its cache, which uses more of your plan (or costs more with an API key). Otherwise this chat picks it up when it starts again.`,
      ok: 'Apply now',
    });
    if (!ok) return toast(later);
    const r = await run("Couldn't apply it to this chat", () => api('POST', `/api/chats/${chatId}/reload-plugins`, { pluginId: pl.id, enabled: on, force: true }));
    if (r) toast(r.applied ? `${what}, in this chat too.` : later);
    return undefined;
  }

  async function setPluginEnabled(pl, on) {
    const p = plugins.pop;
    if (!p) return;
    const { chatId, cwd } = p;
    p.busy.add(pl.id);
    renderPluginsMenu();
    const res = await run(`Couldn't turn ${on ? 'on' : 'off'} ${pl.name}`, () => api('POST', '/api/plugins/enabled', { id: pl.id, enabled: on, cwd, chatId }));
    p.busy.delete(pl.id);
    await refreshPlugins(cwd);
    if (res) afterPluginChange(chatId, pl, `${pl.name} is ${on ? 'on' : 'off'}`, on, res.reload);
  }

  // Some marketplaces install a plugin by running a command; Claude Code won't until a person has
  // seen it, so it's shown here and accepted by its checksum (exactly that command, nothing else).
  async function installPlugin(pl) {
    const p = plugins.pop;
    if (!p) return;
    const { chatId, cwd } = p;
    const install = (acceptCommand) => run(`Couldn't install ${pl.name}`, () => api('POST', '/api/plugins/install', { id: pl.id, cwd, chatId, acceptCommand }));
    p.busy.add(pl.id);
    renderPluginsMenu();
    let res = await install();
    if (res && res.needsConfirmation) {
      const ok = await Deck.confirm({
        title: `Run this command to install ${pl.name}?`,
        body: 'This marketplace installs the plugin by running a command on this PC, as you. Only continue if you trust it.',
        extra: h('pre', { class: 'pp-command' }, res.command),
        ok: 'Run it and install',
        danger: true,
      });
      res = ok ? await install(res.sha256) : null;
      if (res && res.needsConfirmation) {
        toast("The marketplace's command changed while you were deciding. Try installing again to see the new one.", 'error');
        res = null;
      }
    }
    p.busy.delete(pl.id);
    await refreshPlugins(cwd);
    if (res && res.ok) afterPluginChange(chatId, pl, `${pl.name} is installed and on`, true, res.reload);
  }

  document.addEventListener('click', closePluginsMenu);
  window.addEventListener('resize', closePluginsMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !plugins.pop) return;
    e.stopPropagation();
    const b = plugins.pop.btn;
    closePluginsMenu();
    if (b && b.isConnected) b.focus();
  }, true);

  // ---- MCP servers menu (chat header) --------------------------------------------------------
  // The chat's MCP servers, as /mcp lists them, through its own Claude Code (src/chat.js). Turning
  // one off is remembered for the folder, like /mcp. Lives on <body>, like the plugins menu.
  const mcp = { pop: null };
  const MCP_POLL_MS = 2000;
  const MCP_STATUS = { connected: 'Connected', pending: 'Connecting…', failed: 'Failed', 'needs-auth': 'Needs sign-in', disabled: 'Off' };
  const MCP_SCOPE = { claudeai: 'claude.ai', user: 'user', project: 'project', local: 'local', plugin: 'plugin', managed: 'managed', enterprise: 'managed', dynamic: 'this session' };

  function mcpSummary(list) {
    if (!list) return 'Checking…';
    if (!list.length) return 'None set up';
    return `${list.filter((s) => s.status === 'connected').length} of ${list.length} connected`;
  }

  function mcpButton(it) {
    const btn = h('button', {
      type: 'button',
      class: 'ghost small mcp-btn',
      'aria-haspopup': 'dialog',
      'aria-expanded': String(Boolean(mcp.pop && mcp.pop.chatId === it.id)),
      title: 'The MCP servers this chat can use: see their status, turn them on or off, or reconnect one (like /mcp)',
      onclick: (e) => { e.stopPropagation(); toggleMcpMenu(it, btn); },
    }, mcpSummary(it.mcp), Deck.icon('down', { size: 12 }));
    if (mcp.pop && mcp.pop.chatId === it.id) mcp.pop.btn = btn;
    return btn;
  }

  function closeMcpMenu() {
    const p = mcp.pop;
    if (!p) return;
    clearTimeout(p.timer);
    p.el.remove();
    if (p.btn) p.btn.setAttribute('aria-expanded', 'false');
    mcp.pop = null;
  }

  function toggleMcpMenu(it, btn) {
    if (mcp.pop && mcp.pop.chatId === it.id) { closeMcpMenu(); return; }
    closeMcpMenu();
    closePluginsMenu();
    const el = h('div', { class: 'plugin-pop', role: 'dialog', 'aria-label': 'MCP servers' });
    el.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(el);
    mcp.pop = { el, btn, chatId: it.id, servers: null, busy: new Set(), error: null, timer: null };
    btn.setAttribute('aria-expanded', 'true');
    renderMcpMenu();
    const r = btn.getBoundingClientRect();
    el.style.top = `${Math.round(r.bottom + 6)}px`;
    el.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)))}px`;
    refreshMcp();
  }

  // Reads the list again while the menu is open and a server is still connecting.
  async function refreshMcp() {
    const p = mcp.pop;
    if (!p) return;
    clearTimeout(p.timer);
    try {
      p.servers = (await api('GET', `/api/chats/${p.chatId}/mcp`)).servers;
      p.error = null;
    } catch (err) {
      p.error = err.message;
    }
    if (mcp.pop !== p) return;
    renderMcpMenu();
    const waiting = p.watchUntil && Date.now() < p.watchUntil && p.servers && p.servers.some((s) => s.status === 'needs-auth');
    if (p.servers && (waiting || p.servers.some((s) => s.status === 'pending'))) p.timer = setTimeout(refreshMcp, MCP_POLL_MS);
  }

  function mcpDetail(s) {
    if (s.status === 'connected') {
      const n = s.tools ? s.tools.length : 0;
      return [`${n} tool${n === 1 ? '' : 's'}`, s.version ? `version ${s.version}` : null].filter(Boolean).join(' · ');
    }
    if (s.status === 'failed') return s.error || "Couldn't connect.";
    if (s.status === 'needs-auth') return 'Sign in to use it.';
    return null;
  }

  // Signing in, as /mcp does: Claude Code gives the address to open, and finishes the sign-in when
  // the browser comes back to it (a claude.ai connector is connected on claude.ai instead). The
  // list keeps checking for a few minutes, until the server connects.
  const MCP_SIGN_IN_WAIT_MS = 3 * 60 * 1000;
  async function signInMcp(s) {
    const p = mcp.pop;
    if (!p) return;
    const res = await run(`Couldn't start signing in to ${s.name}`, () => api('POST', `/api/chats/${p.chatId}/mcp/authenticate`, { name: s.name }));
    if (!res) return;
    if (res.authUrl) window.open(res.authUrl, '_blank', 'noopener');
    if (res.authUrl && res.callbackExpected) toast(`Finish signing in to ${s.name} in the browser window. This list updates when it connects.`, 'info', { label: 'OK', run: () => {}, ms: 10000 });
    else if (res.authUrl) toast(`Connect ${s.name} on claude.ai in the window that opened, then reconnect it here.`, 'info', { label: 'OK', run: () => {}, ms: 10000 });
    else toast(`${s.name} is signed in.`);
    if (mcp.pop === p) {
      p.watchUntil = Date.now() + MCP_SIGN_IN_WAIT_MS;
      refreshMcp();
    }
  }

  function renderMcpMenu() {
    const p = mcp.pop;
    if (!p) return;
    const el = clear(p.el);
    el.appendChild(h('div', { class: 'pp-head' },
      h('strong', null, 'MCP servers'),
      h('small', { class: 'faint' }, 'Turning a server off applies to new sessions in this folder too, as /mcp does.')));
    if (p.error) el.appendChild(h('p', { class: 'error pp-empty' }, p.error));
    if (!p.servers) {
      if (!p.error) el.appendChild(h('p', { class: 'faint pp-empty' }, 'Loading…'));
      return;
    }
    if (!p.servers.length) el.appendChild(h('p', { class: 'faint pp-empty' }, 'This chat has no MCP servers. Add them with claude mcp add, in settings, or with a plugin.'));
    for (const s of p.servers) {
      const busy = p.busy.has(s.name);
      const where = MCP_SCOPE[s.source] || MCP_SCOPE[s.scope] || s.source || s.scope;
      const detail = mcpDetail(s);
      const canReconnect = s.status === 'failed';
      el.appendChild(h('div', { class: 'pp-row', title: s.tools && s.tools.length ? `Tools: ${s.tools.join(', ')}` : null },
        h('span', { class: 'pp-name' }, s.name, where ? h('small', { class: 'faint' }, where) : null),
        h('span', { class: `pp-desc mcp-state mcp-${s.status}` }, h('span', { class: 'mcp-status' }, busy ? 'Working…' : MCP_STATUS[s.status] || s.status), detail ? ` · ${detail}` : null),
        h('span', { class: 'pp-control mcp-controls' },
          canReconnect ? h('button', { type: 'button', class: 'ghost small', disabled: busy, onclick: () => reconnectMcp(s) }, 'Reconnect') : null,
          s.status === 'needs-auth' ? h('button', { type: 'button', class: 'ghost small', disabled: busy, onclick: () => signInMcp(s) }, 'Sign in') : null,
          h('input', { type: 'checkbox', checked: s.status !== 'disabled', disabled: busy, 'aria-label': `Turn ${s.name} on`, onchange: (e) => setMcpEnabled(s, e.target.checked) }))));
    }
  }

  async function mcpChange(s, what) {
    const p = mcp.pop;
    if (!p) return;
    p.busy.add(s.name);
    renderMcpMenu();
    const res = await what(p.chatId);
    p.busy.delete(s.name);
    if (mcp.pop !== p) return;
    if (res) p.servers = res.servers;
    renderMcpMenu();
    refreshMcp();
  }

  const setMcpEnabled = (s, on) => mcpChange(s, (chatId) => run(`Couldn't turn ${on ? 'on' : 'off'} ${s.name}`, () => api('POST', `/api/chats/${chatId}/mcp/enabled`, { name: s.name, enabled: on })));
  const reconnectMcp = (s) => mcpChange(s, (chatId) => run(`Couldn't reconnect ${s.name}`, () => api('POST', `/api/chats/${chatId}/mcp/reconnect`, { name: s.name })));

  document.addEventListener('click', closeMcpMenu);
  window.addEventListener('resize', closeMcpMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !mcp.pop) return;
    e.stopPropagation();
    const b = mcp.pop.btn;
    closeMcpMenu();
    if (b && b.isConnected) b.focus();
  }, true);

  const sinceText = (t) => `for ${ago(t).replace('just now', 'a moment')}`;

  // Only rebuild the header when something it shows changed, so dropdowns aren't reset mid-use.
  // "For 3m" changes every minute on its own, so it's updated in place instead (see below).
  function headSignature(it) {
    return JSON.stringify([it.key, it.state, it.status, it.waitingFor, heading(it), it.title, it.name, it.model, it.requestedModel, it.requestedEffort, it.permissionMode,
      it.costUSD, it.tokens, it.context, it.sessionId, it.color, it.gitBranch, it.cwd, it.exitCode, it.note, it.userTurns, it.statusSince,
      it.runningTasks, it.taskCount, it.mcp, it.fast, Boolean(S.showTasks[it.id]), Boolean(S.showChanges[it.key])]);
  }

  // Someone is using one of the header's controls (typing a model ID, a dropdown open): rebuilding
  // now would throw that away, so it waits until they're done.
  function headInUse(pane) {
    const head = pane.querySelector('.detail-head');
    const a = document.activeElement;
    // The model menu is on <body>, so it counts while it's open.
    return Boolean(head && ((a && head.contains(a) && a.matches('input, select, textarea')) || document.querySelector('.model-menu')));
  }
  // ...and catches up as soon as they're done.
  document.addEventListener('focusout', (e) => {
    if (e.target && e.target.closest && e.target.closest('.detail-head')) setTimeout(() => { if (S.view === 'sessions') renderFocusDetail(); }, 0);
  });

  function renderFocusDetail() {
    const pane = $('#focus-detail');
    // The usage view, rebuilt only when its numbers change, so its scroll position is kept.
    if (S.selected === USAGE_KEY) {
      loadWeekUsage(); // refreshes once the numbers are a minute old
      const sig = `${S.week ? S.week.fetchedAt : ''}|${S.week && S.week.loading}`;
      if (S.detailKey !== USAGE_KEY || pane.dataset.usageSig !== sig) {
        closePluginsMenu();
        closeHeadMenu();
        S.chat = null;
        S.detailKey = USAGE_KEY;
        const old = pane.querySelector('.usage-view');
        const top = old ? old.scrollTop : 0;
        const view = h('div', { class: 'usage-view' }, weekPanel());
        clearPane(pane).appendChild(view);
        view.scrollTop = top;
        pane.dataset.usageSig = sig;
      }
      return;
    }
    const flat = visibleItems().flatMap((g) => g.items);
    let it = S.selected ? flat.find((x) => x.key === S.selected) : null;
    if (!it && S.opening && S.opening.key === S.selected && Date.now() < S.opening.until) {
      clearPane(pane).appendChild(h('div', { class: 'empty' }, h('p', null, 'Starting the session…')));
      S.detailKey = null;
      return;
    }
    if (!it && flat.length) {
      it = flat[0];
      S.selected = it.key;
    }
    if (!it) {
      clearPane(pane);
      S.detailKey = null;
      S.chat = null;
      pane.appendChild(allItems().length ? h('div', { class: 'empty' }, h('p', null, 'Select a session.')) : emptyState());
      return;
    }
    if (S.opening && S.opening.key === it.key) S.opening = null;
    // The subagents panel opens by itself when Claude starts one (or when a chat is opened with some
    // running); once closed it stays closed until another starts.
    if (isChat(it)) {
      const seen = S.tasksSeen[it.id];
      if (seen === undefined ? it.runningTasks > 0 : it.taskCount > seen) S.showTasks[it.id] = true;
      S.tasksSeen[it.id] = it.taskCount;
    }

    // A terminal in the window shows its screen while it runs and after it ends; once the server
    // has restarted there's no screen left, and the conversation comes from the transcript instead.
    const showTerm = isEmbedded(it) && (it.state === 'running' || it.screen);
    const fresh = S.detailKey !== it.key || !pane.querySelector(showTerm ? '.term-pane' : '.convo');
    if (fresh) {
      if (plugins.pop && plugins.pop.chatId !== it.id) closePluginsMenu();
      if (headMenu.key !== it.key) closeHeadMenu();
      clearPane(pane);
      S.detailKey = it.key;
      S.headSig = headSignature(it);
      S.convo = { key: null, stamp: null, sessionId: null };
      pane.appendChild(detailHead(it));
      if (isChat(it)) pane.appendChild(h('div', { class: 'tasks-panel', hidden: true }));
      pane.appendChild(h('div', { class: 'changes-panel', hidden: true }));
      if (isChat(it)) pane.appendChild(h('div', { class: 'changes-panel agent-panel', hidden: true }));
      // A terminal in the window is the conversation and the reply box in one.
      if (showTerm) pane.appendChild(terminalPane(it));
      else pane.appendChild(h('div', { class: 'convo' }, h('div', { class: 'convo-inner' })));
      if (isChat(it)) {
        pane.appendChild(composer(it));
        loadChat(it);
      } else {
        S.chat = null;
        if (showTerm) mountTerminal(it);
      }
    } else if (headSignature(it) !== S.headSig && !headInUse(pane)) {
      S.headSig = headSignature(it);
      pane.replaceChild(detailHead(it), pane.querySelector('.detail-head'));
    }
    for (const el of pane.querySelectorAll('.head-since')) el.textContent = sinceText(Number(el.dataset.since));
    if (isChat(it)) {
      updateComposer(it);
      renderTasksPanel(); // keeps the running times current
    } else if (showTerm) {
      updateTerminal(it);
    } else {
      loadConversation(it, pane.querySelector('.convo'));
    }
    renderSpinner(it);
    renderAltViews(it);
  }

  // Read-only conversation for terminal and outside sessions, from the transcript on disk.
  async function loadConversation(it, box) {
    const inner = box.querySelector('.convo-inner');
    if (!it.sessionId) {
      clear(inner).appendChild(h('p', { class: 'convo-note' }, 'The conversation shows up here after the first prompt.'));
      return;
    }
    const stamp = it.transcriptStamp || 'none';
    if (S.convo.key === it.key && S.convo.sessionId === it.sessionId && S.convo.stamp === stamp) return;
    // Remembered only once it has loaded, so a failed read is tried again on the next update
    // rather than only when the transcript next changes.
    S.convo = { key: it.key, sessionId: it.sessionId, stamp: null };
    try {
      const data = await api('GET', `/api/transcript/${it.sessionId}?limit=150`);
      if (S.convo.key !== it.key || S.convo.sessionId !== it.sessionId) return;
      S.convo.stamp = stamp;
      renderConversation(box, data.items);
    } catch (err) {
      if (S.convo.key !== it.key) return;
      clear(inner).appendChild(h('p', { class: 'convo-note' }, err.status === 404 ? 'No transcript has been written for this session yet.' : `Couldn't load the conversation: ${err.message}`));
    }
  }

  // When a message was sent or written, shown at its top right; the full date and time on hover.
  // Yours sits in the "You" label's line (with a Queued or Not delivered tag before it); Claude's
  // floats beside the reply's first line.
  function msgTime(ts) {
    return ts ? h('time', { class: 'msg-time', datetime: new Date(ts).toISOString(), title: new Date(ts).toLocaleString() }, when(ts)) : null;
  }

  function transcriptNode(m) {
    if (m.kind === 'user') {
      const onlyImages = /^\[\d+ images?\]$/.test(m.text);
      return h('div', { class: 'msg msg-user' },
        m.ts ? h('div', { class: 'msg-head' }, msgTime(m.ts)) : null,
        m.images ? h('div', { class: 'faint small' }, `${m.images} image${m.images === 1 ? '' : 's'} attached`) : null,
        onlyImages ? null : h('div', { class: 'msg-text' }, m.text));
    }
    if (m.kind === 'assistant') {
      const div = h('div', { class: 'msg msg-assistant' }, msgTime(m.ts));
      div.appendChild(richText(m.text));
      return div;
    }
    return h('div', { class: 'msg-tool line' }, h('span', { class: 'tname' }, m.name), m.detail ? h('span', { class: 'tdetail', title: m.detail }, m.detail) : null);
  }

  function renderConversation(box, items) {
    const inner = box.querySelector('.convo-inner');
    const first = !inner.dataset.rendered;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    clear(inner);
    inner.dataset.rendered = '1';
    if (!items.length) {
      inner.appendChild(h('p', { class: 'convo-note' }, 'No messages yet.'));
      return;
    }
    if (items.length >= 150) inner.appendChild(h('p', { class: 'convo-note' }, 'Showing the most recent part of the conversation.'));
    for (const m of items) inner.appendChild(transcriptNode(m));
    markClaudeTurns(inner);
    if (first || atBottom) box.scrollTop = box.scrollHeight;
  }

  // ---- chat ----------------------------------------------------------------------------------
  async function loadChat(it) {
    S.chat = { id: it.id, loaded: false, items: new Map(), past: [], commands: [], buffer: [], tasks: [] };
    try {
      const d = await api('GET', `/api/chats/${it.id}`);
      if (!S.chat || S.chat.id !== it.id) return;
      S.chat.past = d.past || [];
      S.chat.earlierPrompts = d.earlierPrompts || [];
      S.chat.commands = d.commands || [];
      S.chat.tasks = d.tasks || [];
      renderTasksPanel();
      for (const item of d.items) S.chat.items.set(item.n, item);
      for (const e of S.chat.buffer) if (e.seq > d.seq && e.item) S.chat.items.set(e.item.n, e.item);
      S.chat.buffer = [];
      S.chat.loaded = true;
      renderChat(true);
    } catch (err) {
      // Only into this chat's pane, if it's still the one showing. Events aren't collected for a
      // chat that didn't load; Try again (or the next reconnect) loads it afresh.
      if (!S.chat || S.chat.id !== it.id || S.detailKey !== it.key) return;
      S.chat.failed = true;
      S.chat.buffer = [];
      const inner = $('#focus-detail .convo-inner');
      if (inner) {
        clear(inner).appendChild(h('p', { class: 'convo-note' }, `Couldn't load the chat: ${err.message} `,
          h('button', { type: 'button', class: 'ghost small', onclick: () => loadChat(it) }, 'Try again')));
      }
    }
  }

  function onChatEvent(e) {
    if (!S.chat || e.id !== S.chat.id) return;
    if (e.reset) {
      const it = findItem(`d:${e.id}`);
      if (it) loadChat(it);
      return;
    }
    // Only the slash commands changed (Claude started, or plugins were reloaded): the conversation
    // on screen stays as it is.
    if (e.meta) {
      const id = e.id;
      api('GET', `/api/chats/${id}`).then((d) => { if (S.chat && S.chat.id === id) S.chat.commands = d.commands || []; }).catch(() => {});
      return;
    }
    if (S.chat.failed) return;
    if (!S.chat.loaded) {
      S.chat.buffer.push(e);
      return;
    }
    S.chat.items.set(e.item.n, e.item);
    upsertChatNode(e.item);
    // A message joining or leaving the queue changes the reply box's hint.
    if (e.item.kind === 'user') { const it = findItem(`d:${e.id}`); if (it) updateComposer(it); }
  }

  function onChatTasks(e) {
    if (!S.chat || e.id !== S.chat.id) return;
    S.chat.tasks = e.tasks;
    renderTasksPanel();
  }

  // ---- subagents panel -----------------------------------------------------------------------
  const TASK_LANE = { running: 'working', completed: 'idle' };

  const tokenText = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M` : n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString());

  function taskStatusText(t) {
    const took = duration((t.endedAt || Date.now()) - t.startedAt);
    return t.status === 'running' ? `Running for ${took}` : `${t.status.charAt(0).toUpperCase()}${t.status.slice(1)} after ${took}`;
  }

  function stopSubagent(chatId, t) {
    return run("Couldn't stop the subagent", () => api('POST', `/api/chats/${chatId}/tasks/${encodeURIComponent(t.taskId)}/stop`));
  }

  // One entry per subagent; click it for the detail view.
  function taskNode(t, chatId) {
    const lane = TASK_LANE[t.status] || 'ended';
    const stats = [t.subagentType, t.model, t.toolUses ? `${t.toolUses} tool call${t.toolUses === 1 ? '' : 's'}` : null, t.tokens ? `${tokenText(t.tokens)} tokens` : null, t.background ? 'in the background' : null].filter(Boolean);
    const open = () => openSubagent(chatId, t.taskId);
    return h('div', {
      class: `task ${lane} clickable`,
      role: 'button',
      tabindex: '0',
      title: 'Show what this subagent is doing',
      onclick: open,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
    },
    h('div', { class: 'task-head' },
      h('span', { class: `lamp ${lane}` }),
      h('strong', { class: 'task-title' }, t.description || 'Subagent'),
      h('span', { class: `status-text ${lane} small`, dataset: t.status === 'running' ? { since: String(t.startedAt) } : {} }, taskStatusText(t)),
      t.status === 'running' ? h('button', { type: 'button', class: 'danger small', onclick: (e) => { e.stopPropagation(); stopSubagent(chatId, t); } }, 'Stop') : null),
    stats.length ? h('div', { class: 'task-stats' }, stats.map((s) => h('span', null, s))) : null,
    t.status === 'running' && t.activity ? h('div', { class: 'task-activity' }, t.activity) : null,
    t.summary ? h('div', { class: 'task-summary clamp' }, richText(t.summary)) : null,
    h('div', { class: 'task-open faint small' }, 'Details'));
  }

  function renderTasksPanel() {
    const panel = $('#focus-detail .tasks-panel');
    if (!panel || !S.chat) return;
    // A subagent's detail takes the list's place; Back brings the list back.
    const open = S.showTasks[S.chat.id] && !(S.agentView && S.agentView.chatId === S.chat.id);
    panel.hidden = !open;
    if (!open) return;
    // Rebuilt only when a subagent changed; running times are updated in place (see the timer
    // below). Rebuilding every second lost clicks on Stop and any text being selected.
    const sig = JSON.stringify([S.chat.id, S.chat.tasks]);
    if (panel.dataset.sig === sig) return;
    panel.dataset.sig = sig;
    const focused = document.activeElement && panel.contains(document.activeElement) ? $$('.task', panel).indexOf(document.activeElement) : -1;
    clear(panel);
    const tasks = S.chat.tasks || [];
    const running = tasks.filter((t) => t.status === 'running').length;
    panel.appendChild(h('div', { class: 'tasks-head' },
      h('h3', null, 'Subagents'),
      h('span', { class: 'faint small' }, running ? `${running} running` : 'None running'),
      h('span', { class: 'spacer' }),
      // Closed until another subagent starts, or reopened from the session menu.
      h('button', { type: 'button', class: 'ghost icon small', title: 'Close (reopen it from the menu beside the title)', 'aria-label': 'Close the subagents panel', onclick: () => setTasksPanel(S.chat.id, false) }, Deck.icon('close'))));
    if (!tasks.length) panel.appendChild(h('p', { class: 'faint small' }, 'No subagents since this chat last started. Subagents appear here when Claude hands off work to one.'));
    tasks.forEach((t) => panel.appendChild(taskNode(t, S.chat.id)));
    if (focused >= 0 && $$('.task', panel)[focused]) $$('.task', panel)[focused].focus();
  }

  // ---- subagent detail -----------------------------------------------------------------------
  // Replaces the conversation (like Changes): what the subagent was asked, every step it took, and
  // its token usage. Refreshes while it runs.
  function openSubagent(chatId, taskId) {
    S.agentView = { chatId, taskId };
    delete S.showChanges[`d:${chatId}`];
    S.headSig = null;
    renderFocusDetail();
  }

  function closeSubagent() {
    S.agentView = null;
    S.headSig = null;
    renderFocusDetail();
  }

  function subagentView(chatId, taskId) {
    const root = h('div', { class: 'changes agent-view' });
    let timer = null;
    const load = async () => {
      clearTimeout(timer);
      if (!root.isConnected && root.dataset.loaded) return;
      try {
        const d = await api('GET', `/api/chats/${chatId}/tasks/${encodeURIComponent(taskId)}`);
        renderSubagent(root, chatId, d);
        if (d.status === 'running') timer = setTimeout(load, 1500);
      } catch (err) {
        clear(root).appendChild(h('div', { class: 'tasks-head' }, h('button', { type: 'button', class: 'ghost small', onclick: closeSubagent }, Deck.icon('left', { size: 12 }), 'Back')));
        root.appendChild(h('p', { class: 'convo-note' }, err.status === 404 ? 'That subagent is no longer listed. The list starts fresh when a chat restarts.' : `Couldn't load the subagent: ${err.message}`));
      }
      root.dataset.loaded = '1';
    };
    load();
    return root;
  }

  function renderSubagent(root, chatId, t) {
    // Opens at the top; after that, follows new steps if you're at the bottom.
    const scroller = root.closest('.agent-panel');
    const stick = Boolean(scroller && root.dataset.loaded && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80);
    const lane = TASK_LANE[t.status] || 'ended';
    const u = t.usage;
    // Refreshed every 1.5 s while it runs: nothing to do if nothing changed, and an "Asked to"
    // section someone opened or closed stays that way.
    const sig = JSON.stringify(t);
    if (root.dataset.sig === sig) return;
    root.dataset.sig = sig;
    const prior = root.querySelector('.agent-prompt');
    const promptOpen = prior ? prior.open : t.prompt && t.prompt.length < 600;
    clear(root);
    root.appendChild(h('div', { class: 'tasks-head' },
      h('button', { type: 'button', class: 'ghost small', onclick: closeSubagent }, Deck.icon('left', { size: 12 }), 'Back'),
      h('span', { class: 'spacer' }),
      t.status === 'running' ? h('button', { type: 'button', class: 'danger small', onclick: () => stopSubagent(chatId, t) }, 'Stop') : null));
    root.appendChild(h('div', { class: 'card-status' },
      h('span', { class: `lamp ${lane}` }),
      h('span', { class: `status-text ${lane}`, dataset: t.status === 'running' ? { since: String(t.startedAt) } : {} }, taskStatusText(t))));
    root.appendChild(h('h2', { class: 'agent-title' }, t.description || 'Subagent'));
    root.appendChild(h('dl', { class: 'facts' },
      fact('Type', t.subagentType || null),
      fact('Model', t.model || null),
      fact('Tool calls', t.toolUses || null),
      fact('Tokens', t.tokens ? t.tokens.toLocaleString() : null),
      fact('Started', when(t.startedAt)),
      fact('Runs', t.background ? 'In the background' : 'Claude waits for it')));
    if (u && u.calls) {
      root.appendChild(h('div', { class: 'usage-break' },
        [['Input', u.input], ['Output', u.output], ['Cache read', u.cacheRead], ['Cache write', u.cacheWrite]].map(([k, v]) => h('span', null, h('span', { class: 'faint' }, `${k} `), v.toLocaleString())),
        h('span', { class: 'faint' }, `over ${u.calls} API call${u.calls === 1 ? '' : 's'}`)));
      if (t.status !== 'running' && t.reportedTokens && t.reportedTokens !== u.total) root.appendChild(h('p', { class: 'faint small' }, `Claude Code's summary reported ${t.reportedTokens.toLocaleString()} tokens.`));
    }
    if (t.prompt) {
      root.appendChild(h('details', { class: 'agent-prompt', open: promptOpen },
        h('summary', { class: 'faint small' }, 'Asked to'),
        h('div', { class: 'task-prompt-text' }, t.prompt)));
    }
    root.appendChild(h('h3', { class: 'agent-section' }, 'Activity'));
    if (!t.steps.length) {
      root.appendChild(h('p', { class: 'convo-note' }, t.status === 'running' ? 'Starting… Steps appear here as the subagent works.' : 'No steps were recorded for this subagent.'));
    }
    for (const s of t.steps) {
      if (s.kind === 'tool') {
        root.appendChild(h('div', { class: `agent-step agent-tool${s.isError ? ' err' : ''}` },
          h('div', { class: 'step-line' },
            h('span', { class: 'tname' }, s.name),
            s.detail ? h('span', { class: 'tdetail', title: s.detail }, s.detail) : null,
            s.ts ? h('span', { class: 'faint small step-time' }, when(s.ts)) : null),
          s.result === null && t.status === 'running' ? h('div', { class: 'step-result faint' }, 'Running…') : null,
          s.result ? h('div', { class: 'step-result' }, s.result) : null));
      } else {
        const div = h('div', { class: 'agent-step task-text' });
        div.appendChild(richText(s.text));
        root.appendChild(div);
      }
    }
    if (t.status === 'running' && t.steps.length) root.appendChild(h('p', { class: 'faint small working-note' }, 'Working…'));
    if (t.summary && t.status !== 'running') {
      root.appendChild(h('h3', { class: 'agent-section' }, 'Result'));
      const div = h('div', { class: 'task-summary' });
      div.appendChild(richText(t.summary));
      root.appendChild(div);
    }
    if (scroller && stick) scroller.scrollTop = scroller.scrollHeight;
  }

  function renderAgentPanel(it) {
    const pane = $('#focus-detail');
    const panel = pane && pane.querySelector('.agent-panel');
    if (!panel) return false;
    const open = Boolean(S.agentView && isChat(it) && S.agentView.chatId === it.id);
    const key = open ? S.agentView.taskId : '';
    if (panel.dataset.key !== key || panel.hidden === open) {
      panel.dataset.key = key;
      panel.hidden = !open;
      clear(panel);
      if (open) panel.appendChild(subagentView(it.id, S.agentView.taskId));
    }
    return open;
  }

  // Running times tick while a subagent runs.
  setInterval(() => {
    for (const el of $$('#focus-detail .agent-panel [data-since], #focus-detail .tasks-panel [data-since]')) el.textContent = `Running for ${duration(Date.now() - Number(el.dataset.since))}`;
  }, 1000);

  // ---- change timeline -----------------------------------------------------------------------
  // The files each turn changed (from Claude Code's own file checkpoints), with diffs, and
  // restoring files to how they were before a turn.
  const CHANGE_LABEL = { created: 'Created', edited: 'Edited', deleted: 'Deleted' };
  const ACTION_LABEL = { restore: 'Put back', recreate: 'Recreate', delete: 'Delete' };
  const ACTION_CLASS = { restore: 'edited', recreate: 'created', delete: 'deleted' };
  const undoBySession = {}; // session id -> undo id of the last restore

  function relTo(cwd, p) {
    return cwd && p.toLowerCase().startsWith(`${cwd.toLowerCase()}\\`) ? p.slice(cwd.length + 1) : p;
  }

  function diffStat(added, removed) {
    if (added === null || added === undefined) return null;
    return h('span', { class: 'dstat' }, h('span', { class: 'plus' }, `+${added}`), h('span', { class: 'minus' }, `−${removed}`));
  }

  function changesView(sessionId, onHide) {
    const root = h('div', { class: 'changes' });
    const reload = async () => {
      if (!root.firstChild) root.appendChild(h('p', { class: 'convo-note' }, 'Loading changes…'));
      try {
        renderChanges(root, await api('GET', `/api/timeline/${sessionId}`), reload, onHide);
      } catch (err) {
        clear(root).appendChild(changesHead(sessionId, reload, onHide));
        root.appendChild(h('p', { class: 'convo-note' }, err.status === 404 ? 'No transcript has been written for this session yet.' : `Couldn't load the changes: ${err.message}`));
      }
    };
    reload();
    return root;
  }

  function changesHead(sessionId, reload, onHide) {
    const undoId = undoBySession[sessionId];
    return h('div', { class: 'tasks-head' },
      h('h3', null, 'Changes'),
      h('span', { class: 'faint small' }, 'Files Claude changed, by turn'),
      h('span', { class: 'spacer' }),
      undoId ? h('button', { type: 'button', class: 'ghost small', onclick: () => undoRestore(sessionId, reload) }, 'Undo last restore') : null,
      h('button', { type: 'button', class: 'ghost small', onclick: reload }, 'Refresh'),
      onHide ? h('button', { type: 'button', class: 'ghost small', onclick: onHide }, 'Back to conversation') : null);
  }

  function renderChanges(root, data, reload, onHide) {
    const open = new Set($$('.tl-file', root).filter((d) => d.open).map((d) => d.dataset.id));
    clear(root).appendChild(changesHead(data.sessionId, reload, onHide));
    root.appendChild(h('p', { class: 'faint small tl-note' }, 'Tracks files Claude changed with its edit tools. Changes made by shell commands don\'t show here, and files changed by hand between turns are marked as changed outside Claude.'));
    if (!data.checkpoints) {
      root.appendChild(h('p', { class: 'convo-note' }, 'No file checkpoints in this conversation yet. Claude Code records one each time you send a prompt. Chats started in Claude Deck before this feature have none; new turns will.'));
      return;
    }
    const turns = data.turns.filter((t) => t.files.length);
    if (!turns.length) root.appendChild(h('p', { class: 'convo-note' }, 'No files changed yet.'));
    for (const t of turns) root.appendChild(turnNode(data, t, reload, open));
    const quiet = data.turns.length - turns.length;
    if (quiet && turns.length) root.appendChild(h('p', { class: 'faint small' }, `${quiet} turn${quiet === 1 ? '' : 's'} without file changes not shown.`));
  }

  function turnNode(data, t, reload, open) {
    const n = t.files.length;
    return h('div', { class: 'turn' },
      h('div', { class: 'turn-head' },
        h('div', { class: 'turn-prompt', title: t.prompt }, t.prompt),
        h('div', { class: 'turn-meta' },
          t.ts ? h('span', { class: 'faint', title: new Date(t.ts).toLocaleString() }, when(t.ts)) : null,
          h('span', { class: 'muted' }, `${n} file${n === 1 ? '' : 's'}`),
          diffStat(t.added, t.removed),
          t.latest ? h('span', { class: 'faint' }, 'latest turn, compared with the files now') : null,
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'ghost small', title: 'Put every file this turn or a later one changed back the way it was before this prompt', onclick: () => restoreTurn(data, t, reload) }, 'Restore to before this turn'))),
      h('div', { class: 'turn-files' }, t.files.map((f) => fileNode(data.sessionId, t, f, open))));
  }

  function fileNode(sessionId, t, f, open) {
    const id = `${t.messageId}|${f.key}`;
    const body = h('div', { class: 'diff' });
    const d = h('details', {
      class: 'tl-file',
      dataset: { id },
      ontoggle: () => { if (d.open && !body.dataset.loaded) loadDiff(sessionId, t, f, body); },
    },
    h('summary', null,
      h('span', { class: `chg chg-${f.change}` }, CHANGE_LABEL[f.change]),
      h('span', { class: 'tl-path', title: f.path }, f.rel),
      f.outside ? h('span', { class: 'faint small', title: 'The file changed during this turn, but not through Claude\'s edit tools (for example by hand, a shell command, or a restore)' }, 'changed outside Claude') : null,
      f.binary ? h('span', { class: 'faint small' }, 'binary') : f.unknown ? h('span', { class: 'faint small' }, 'checkpoint missing') : diffStat(f.added, f.removed)),
    body);
    if (open.has(id)) d.open = true;
    return d;
  }

  async function loadDiff(sessionId, t, f, body) {
    body.dataset.loaded = '1';
    clear(body).appendChild(h('p', { class: 'faint small' }, 'Loading diff…'));
    try {
      const d = await api('GET', `/api/timeline/${sessionId}/diff?turn=${encodeURIComponent(t.messageId)}&file=${encodeURIComponent(f.key)}`);
      clear(body);
      if (d.unknown) body.appendChild(h('p', { class: 'faint small' }, 'The checkpoint for this file is missing, so there is no diff to show.'));
      else if (d.binary) body.appendChild(h('p', { class: 'faint small' }, 'Binary file. No line diff.'));
      else if (d.large) body.appendChild(h('p', { class: 'faint small' }, 'This file is too large to show a diff.'));
      else if (!d.hunks.length) body.appendChild(h('p', { class: 'faint small' }, 'Only line endings changed.'));
      d.hunks.forEach((hunk, i) => {
        if (i) body.appendChild(h('div', { class: 'dl dl-gap' }, h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 'dt' }, '⋯')));
        for (const l of hunk.lines) {
          body.appendChild(h('div', { class: `dl ${l.t === '+' ? 'dl-add' : l.t === '-' ? 'dl-del' : ''}` },
            h('span', { class: 'ln' }, l.o === null ? '' : String(l.o)),
            h('span', { class: 'ln' }, l.n === null ? '' : String(l.n)),
            h('span', { class: 'dt' }, `${l.t} ${l.s}`)));
        }
      });
    } catch (err) {
      delete body.dataset.loaded;
      clear(body).appendChild(h('p', { class: 'error small' }, `Couldn't load the diff: ${err.message}`));
    }
  }

  async function restoreTurn(data, t, reload) {
    const sid = data.sessionId;
    const pre = await run("Couldn't check what would change", () => api('POST', `/api/timeline/${sid}/restore`, { messageId: t.messageId, preview: true }));
    if (!pre) return;
    if (pre.owner === 'terminal') {
      toast('This conversation is open in Windows Terminal. Use /rewind there, or close that session and try again.', 'error');
      return;
    }
    if (!pre.files.length) {
      toast('The files already match how they were before this turn.');
      return;
    }
    const n = pre.files.length;
    const ok = await Deck.confirm({
      title: 'Restore files to before this turn?',
      body: `${n} file${n === 1 ? '' : 's'} go back to how they were before "${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? '…' : ''}". That undoes this turn's file changes and every later turn's. The conversation isn't changed, and you can undo the restore.`,
      extra: h('ul', { class: 'restore-list' }, pre.files.map((f) => h('li', null,
        h('span', { class: `chg chg-${ACTION_CLASS[f.action]}` }, ACTION_LABEL[f.action]),
        h('span', { class: 'tl-path', title: f.path }, relTo(data.cwd, f.path))))),
      ok: 'Restore files',
      danger: true,
    });
    if (!ok) return;
    const res = await run("Couldn't restore the files", () => api('POST', `/api/timeline/${sid}/restore`, { messageId: t.messageId }));
    if (!res) return;
    if (res.undoId) undoBySession[sid] = res.undoId;
    toast(`Restored ${res.restored} file${res.restored === 1 ? '' : 's'}`, 'info', res.undoId ? { label: 'Undo', run: () => undoRestore(sid, reload) } : null);
    reload();
  }

  async function undoRestore(sessionId, reload) {
    const undoId = undoBySession[sessionId];
    if (!undoId) return;
    const res = await run("Couldn't undo the restore", () => api('POST', '/api/timeline/undo', { undoId }));
    delete undoBySession[sessionId];
    if (res) toast('Restore undone');
    reload();
  }

  function renderChangesPanel(it, suppressed) {
    const pane = $('#focus-detail');
    const panel = pane && pane.querySelector('.changes-panel');
    if (!panel) return false;
    const open = Boolean(S.showChanges[it.key] && it.sessionId && !suppressed);
    if (open === !panel.hidden && panel.dataset.sid === (it.sessionId || '')) return open;
    panel.hidden = !open;
    panel.dataset.sid = it.sessionId || '';
    clear(panel);
    if (open) panel.appendChild(changesView(it.sessionId, () => toggleChanges(it)));
    return open;
  }

  // The focus view shows the conversation, or in its place a subagent's detail or the changes.
  function renderAltViews(it) {
    const agent = renderAgentPanel(it);
    const changes = renderChangesPanel(it, agent);
    const convo = $('#focus-detail .convo, #focus-detail .term-pane');
    if (convo) convo.hidden = agent || changes;
  }

  function toggleChanges(it) {
    S.showChanges[it.key] = !S.showChanges[it.key];
    S.agentView = null;
    S.headSig = null;
    renderFocusDetail();
  }

  function nearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }

  // ---- tool icons ----------------------------------------------------------------------------
  // One per tool call in a chat, by what the tool does, drawn in the same stroke as the page's other
  // icons (Deck.icon). Claude Code's own tools by name; anything else (MCP tools are named
  // mcp__<server>__<action>) by words in its action; a plug otherwise.
  const TOOL_ICONS = {
    Bash: 'terminal', PowerShell: 'terminal', BashOutput: 'terminal', KillShell: 'stop', KillBash: 'stop', TaskStop: 'stop',
    Read: 'file', Write: 'pen', Edit: 'pen', MultiEdit: 'pen', NotebookEdit: 'pen', NotebookRead: 'file',
    Glob: 'folder', Grep: 'search', LS: 'folder',
    WebFetch: 'globe', WebSearch: 'globe',
    Agent: 'agent', Task: 'agent', SendMessage: 'agent', ListAgents: 'agent',
    TodoWrite: 'list', TaskCreate: 'list', TaskUpdate: 'list', TaskList: 'list', TaskGet: 'list',
    AskUserQuestion: 'question', EnterPlanMode: 'list', ExitPlanMode: 'list',
    Skill: 'plug', SlashCommand: 'terminal', ToolSearch: 'search', Monitor: 'clock',
    ScheduleWakeup: 'clock', CronCreate: 'clock', CronDelete: 'clock', CronList: 'clock',
    EnterWorktree: 'branch', ExitWorktree: 'branch', Workflow: 'branch', Artifact: 'file',
  };
  const TOOL_ICON_WORDS = [
    [/click|hover|drag|tap|press_key|type_text|keyboard|\bfill/, 'pointer'],
    [/navigate|new_page|select_page|open_url|browse|goto/, 'globe'],
    [/evaluate|script|execute|exec|run/, 'terminal'],
    [/search|query|find|lookup/, 'search'],
    [/create|write|update|upload|edit|set|send|post/, 'pen'],
    [/list|get|read|fetch|download|view|screenshot|snapshot/, 'file'],
    [/file|folder|drive|sharepoint|document/, 'folder'],
    [/calendar|event|meeting|availability|trace|performance/, 'clock'],
  ];

  function toolIcon(name) {
    const n = String(name || '');
    const action = (n.startsWith('mcp__') ? n.split('__').slice(2).join('_') : n).toLowerCase();
    const word = TOOL_ICON_WORDS.find(([re]) => re.test(action));
    return Deck.icon(TOOL_ICONS[n] || (word ? word[1] : 'plug'), { size: 13 });
  }

  // Your message with each long paste as Claude Code shows it, "[Pasted text #1 +123 lines]": click
  // one to show its text (it stays open when the message is redrawn).
  function pastedPieces(it) {
    return Deck.pastedText.pieces(it.text, it.pasted).map((p) => {
      if (!p.id) return p.text;
      const key = `${S.chat ? S.chat.id : ''}:${it.n}:${p.id}`;
      const body = h('span', { class: 'paste-body', hidden: !S.openPastes.has(key) }, p.text);
      const chip = h('button', {
        type: 'button',
        class: 'paste-chip',
        'aria-expanded': String(S.openPastes.has(key)),
        title: S.openPastes.has(key) ? 'Hide the pasted text' : 'Show the pasted text',
        onclick: () => {
          const open = body.hidden;
          body.hidden = !open;
          chip.setAttribute('aria-expanded', String(open));
          chip.title = open ? 'Hide the pasted text' : 'Show the pasted text';
          if (open) S.openPastes.add(key);
          else S.openPastes.delete(key);
        },
      }, p.label);
      return [chip, body];
    });
  }

  function chatNode(it) {
    const n = String(it.n);
    switch (it.kind) {
      case 'user': {
        // Taken back out of the queue to edit (↑): it's in the reply box now, not the conversation.
        if (it.withdrawn) return h('div', { dataset: { n }, hidden: true });
        const node = h('div', { class: `msg msg-user${it.queued ? ' queued' : ''}`, dataset: { n } });
        node.appendChild(h('div', { class: 'msg-head' },
          it.queued ? h('span', { class: 'msg-tag waiting', title: 'Claude reads this when it finishes what it is doing now. Press ↑ in an empty reply box to take it back and edit it.' }, 'Queued')
            : it.undelivered ? h('span', { class: 'msg-tag ended', title: 'The chat ended before Claude read this message' }, 'Not delivered') : null,
          msgTime(it.ts)));
        if (it.images && it.images.length) node.appendChild(h('div', { class: 'msg-images' }, it.images.map((src) => h('img', { src, alt: 'Attached image', class: 'msg-thumb' }))));
        else if (it.imageCount) node.appendChild(h('div', { class: 'faint small' }, `${it.imageCount} image${it.imageCount === 1 ? '' : 's'} attached`));
        if (it.text && it.text.trim()) node.appendChild(h('div', { class: 'msg-text' }, it.pasted ? pastedPieces(it) : it.text));
        return node;
      }
      case 'assistant': {
        const div = h('div', { class: 'msg msg-assistant', dataset: { n } }, msgTime(it.ts));
        div.appendChild(richText(it.text));
        return div;
      }
      case 'tool': {
        const state = it.result === undefined ? h('span', { class: 'tstate' }, 'running') : it.isError ? h('span', { class: 'tstate err' }, 'failed') : null;
        const tool = h('details', { class: `msg-tool${it.isError ? ' err' : ''}`, dataset: it.diff ? null : { n } },
          h('summary', null, h('span', { class: 'ticon', 'aria-hidden': 'true' }, toolIcon(it.name)), h('span', { class: 'tname' }, it.name), it.detail ? h('span', { class: 'tdetail', title: it.detail }, it.detail) : null, state),
          h('div', { class: 'tool-body' },
            h('div', { class: 'faint small' }, 'Input'), h('pre', { class: 'code small' }, it.input),
            it.result !== undefined ? [h('div', { class: 'faint small' }, it.isError ? 'Error' : 'Result'), h('pre', { class: 'code small' }, it.result || '(empty)')] : null));
        // An edit shows its change under the line, as Claude Code shows it.
        return it.diff ? h('div', { class: 'tool-with-diff', dataset: { n } }, tool, diffView(it.diff)) : tool;
      }
      case 'thinking':
        // Collapsed, as Claude Code shows thinking until Ctrl+O.
        return h('details', { class: 'msg-tool msg-thinking', dataset: { n } },
          h('summary', null, h('span', { class: 'tname' }, 'Thinking')),
          h('div', { class: 'thinking-text' }, it.text));
      case 'shell':
        return shellNode(it);
      case 'plan':
        return planCard(it);
      case 'permission':
        return permissionCard(it);
      case 'question':
        return questionCard(it);
      case 'note':
        return h('div', { class: 'msg-note', dataset: { n } }, it.text);
      case 'error':
        return h('div', { class: 'msg-error', dataset: { n }, role: 'alert' }, it.text);
      // How to sign Claude Code in again (src/chat.js signInHelp), with the command to copy.
      case 'signin':
        return h('div', { class: 'msg-signin', dataset: { n }, role: 'alert' },
          h('div', null, it.text),
          h('div', { class: 'signin-command' },
            h('code', null, it.command),
            h('button', { class: 'ghost small', onclick: () => copy(it.command, 'Command copied') }, 'Copy command')));
      case 'result':
        return it.aborted || it.isError ? h('span', { dataset: { n }, hidden: true }) : h('div', { class: 'msg-result', dataset: { n } },
          it.durationMs ? `Done in ${duration(it.durationMs)}` : 'Done',
          tokenSum(it.tokens) ? h('span', { title: `Tokens this reply used, subagents included. ${tokenBreakdown(it.tokens)}` },
            ` · ${tokenText(tokenSum(it.tokens))} tokens${it.subagentTokens ? `, ${tokenText(it.subagentTokens)} from subagents` : ''}`) : null);
      default:
        return h('span', { dataset: { n }, hidden: true });
    }
  }

  // An edit's change, as Claude Code shows it under the tool line: removed lines and added lines
  // with their line numbers, a gap between the parts of the file that changed.
  function diffView(d) {
    const rows = [];
    let adds = 0;
    let dels = 0;
    for (const hunk of d.hunks) {
      if (rows.length) rows.push(h('div', { class: 'diff-gap', 'aria-hidden': 'true' }, '⋯'));
      let oldN = hunk.oldStart;
      let newN = hunk.newStart;
      for (const line of hunk.lines) {
        const sign = line[0];
        const kind = sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx';
        let num;
        if (kind === 'add') { num = newN++; adds++; } else if (kind === 'del') { num = oldN++; dels++; } else { num = newN++; oldN++; }
        rows.push(h('div', { class: `diff-line ${kind}` },
          h('span', { class: 'diff-num' }, String(num)),
          h('span', { class: 'diff-sign', 'aria-label': kind === 'add' ? 'added' : kind === 'del' ? 'removed' : null }, kind === 'ctx' ? ' ' : sign),
          h('span', { class: 'diff-text' }, line.slice(1))));
      }
    }
    const what = d.created ? `Created ${shortPath(d.file || '', 2)}` : `Updated ${shortPath(d.file || '', 2)}`;
    return h('div', { class: 'msg-diff' },
      h('div', { class: 'diff-head' }, what, h('span', { class: 'dstat' }, adds ? h('span', { class: 'plus' }, ` +${adds}`) : null, dels ? h('span', { class: 'minus' }, ` −${dels}`) : null), d.truncated ? h('span', { class: 'faint' }, ' (first 400 lines)') : null),
      h('div', { class: 'diff-body' }, rows));
  }

  // "!command": what ran in PowerShell and what it printed, as Claude Code shows shell mode.
  function shellNode(it) {
    const state = it.running ? h('span', { class: 'tstate' }, 'running') : it.exitCode ? h('span', { class: 'tstate err' }, `exit code ${it.exitCode}`) : null;
    return h('div', { class: 'msg-shell', dataset: { n: String(it.n) } },
      h('div', { class: 'shell-cmd' }, h('span', { class: 'shell-bang', 'aria-label': 'Shell command' }, '!'), h('span', { class: 'shell-text' }, it.command), state),
      it.stdout ? h('pre', { class: 'code small shell-out' }, it.stdout) : null,
      it.stderr ? h('pre', { class: 'code small shell-err' }, it.stderr) : null);
  }

  // The end of plan mode, as Claude Code asks it: the plan in full, then go ahead (Claude making its
  // edits without asking, or asking before each), or keep planning with what to change.
  function planCard(it) {
    const pending = it.status === 'pending';
    const chatId = S.chat && S.chat.id;
    const body = h('div', { class: 'plan-body' });
    body.appendChild(richText(it.plan || '(No plan text.)'));
    const card = h('div', { class: `req plan-card${pending ? ' pending' : ''}`, dataset: { n: String(it.n) } },
      h('div', { class: 'req-head' }, h('span', { class: `lamp ${pending ? 'waiting' : 'ended'}` }), h('strong', null, pending ? 'Claude has a plan. Go ahead?' : `Plan: ${it.outcome || it.status}`)),
      pending ? body : h('details', null, h('summary', { class: 'faint small' }, 'Show the plan'), body));
    if (pending) {
      const msg = h('input', { type: 'text', placeholder: 'Or tell Claude what to change, and keep planning', 'aria-label': 'What to change in the plan' });
      const keep = () => answer(chatId, it.requestId, { action: 'deny', message: msg.value });
      msg.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); keep(); } });
      card.appendChild(h('div', { class: 'req-actions' },
        h('button', { class: 'primary small', onclick: () => answer(chatId, it.requestId, { action: 'allow', mode: 'acceptEdits' }) }, 'Yes, and make the edits without asking'),
        h('button', { class: 'small', onclick: () => answer(chatId, it.requestId, { action: 'allow', mode: 'default' }) }, 'Yes, and ask before each edit'),
        h('button', { class: 'ghost small', onclick: keep }, 'Keep planning')));
      card.appendChild(msg);
    }
    return card;
  }

  function permissionCard(it) {
    const pending = it.status === 'pending';
    const chatId = S.chat && S.chat.id;
    const card = h('div', { class: `req${pending ? ' pending' : ''}`, dataset: { n: String(it.n) } },
      h('div', { class: 'req-head' },
        h('span', { class: `lamp ${pending ? 'waiting' : 'ended'}` }),
        h('strong', null, pending ? `Claude wants to use ${it.displayName}` : `${it.displayName}: ${it.outcome || it.status}`)),
      it.detail ? h('code', { class: 'req-detail' }, it.detail) : null,
      it.reason ? h('p', { class: 'muted small' }, it.reason) : null,
      it.blockedPath ? h('p', { class: 'muted small' }, `Outside the allowed folders: ${it.blockedPath}`) : null,
      h('details', null, h('summary', { class: 'faint small' }, 'Show the full request'), h('pre', { class: 'code small' }, it.input)));
    if (pending) {
      const msg = h('input', { type: 'text', placeholder: 'Optional: tell Claude what to do instead (sent if you deny)', 'aria-label': 'Message for Claude' });
      const buttons = [
        h('button', { class: 'primary small', onclick: () => answer(chatId, it.requestId, { action: 'allow' }) }, 'Allow once'),
        ...(it.suggestions || []).map((s, i) => h('button', { class: 'small', onclick: () => answer(chatId, it.requestId, { action: 'always', suggestion: i }) }, s)),
        h('button', { class: 'danger small', onclick: () => answer(chatId, it.requestId, { action: 'deny', message: msg.value }) }, 'Deny'),
      ];
      msg.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); answer(chatId, it.requestId, { action: 'deny', message: msg.value }); } });
      card.appendChild(h('div', { class: 'req-actions' }, buttons));
      card.appendChild(msg);
    }
    return card;
  }

  function questionCard(it) {
    const pending = it.status === 'pending';
    const chatId = S.chat && S.chat.id;
    const card = h('div', { class: `req${pending ? ' pending' : ''}`, dataset: { n: String(it.n) } },
      h('div', { class: 'req-head' }, h('span', { class: `lamp ${pending ? 'waiting' : 'ended'}` }), h('strong', null, pending ? 'Claude has a question for you' : `Question: ${it.outcome || it.status}`)));
    if (!pending) return card;
    const picks = {};
    const others = {};
    for (const q of it.questions || []) {
      picks[q.question] = new Set();
      const opts = h('div', { class: 'q-options' });
      const draw = () => {
        clear(opts);
        for (const o of q.options) {
          opts.appendChild(h('button', {
            type: 'button',
            class: 'q-option',
            'aria-pressed': String(picks[q.question].has(o.label)),
            onclick: () => {
              const set = picks[q.question];
              if (q.multiSelect) { if (set.has(o.label)) set.delete(o.label); else set.add(o.label); } else { set.clear(); set.add(o.label); }
              draw();
            },
          }, h('span', { class: 'q-label' }, o.label), o.description ? h('span', { class: 'q-desc' }, o.description) : null));
        }
      };
      draw();
      const other = h('input', { type: 'text', placeholder: 'Or type your own answer', 'aria-label': `Your own answer to: ${q.question}` });
      others[q.question] = other;
      card.appendChild(h('fieldset', { class: 'q' },
        h('legend', null, q.header ? h('span', { class: 'q-header' }, q.header) : null, q.question, q.multiSelect ? h('span', { class: 'faint small' }, '  (choose any)') : null),
        opts, other));
    }
    card.appendChild(h('div', { class: 'req-actions' },
      h('button', { class: 'primary small', onclick: () => {
        const answers = {};
        for (const q of it.questions || []) {
          const typed = others[q.question].value.trim();
          const chosen = [...picks[q.question]];
          if (q.multiSelect) { const all = [...chosen, ...(typed ? [typed] : [])]; if (all.length) answers[q.question] = all.join(', '); }
          else if (typed || chosen[0]) answers[q.question] = typed || chosen[0];
        }
        answer(chatId, it.requestId, { action: 'allow', answers });
      } }, 'Send answer'),
      h('button', { class: 'ghost small', onclick: () => answer(chatId, it.requestId, { action: 'deny' }) }, 'Dismiss')));
    return card;
  }

  // "Claude" over the first thing Claude does after each of your turns (a reply, a tool, a question
  // or the working spinner), as "You" marks yours. Run again whenever the conversation changes:
  // what comes first after your turn can change as messages arrive or the spinner hides.
  function markClaudeTurns(list) {
    if (!list) return;
    const keep = new Set();
    let want = false;
    for (const el of [...list.children]) {
      // Notes are Claude Deck's, and a ! command's output is yours, not Claude's.
      if (el.classList.contains('turn-claude') || el.hidden || el.classList.contains('msg-note') || el.classList.contains('msg-shell')) continue;
      if (el.classList.contains('msg-user')) { want = true; continue; }
      if (!want) continue;
      want = false;
      let mark = el.previousElementSibling;
      if (!mark || !mark.classList.contains('turn-claude')) {
        mark = h('div', { class: 'turn-claude' }, 'Claude');
        list.insertBefore(mark, el);
      }
      keep.add(mark);
    }
    for (const m of list.querySelectorAll(':scope > .turn-claude')) if (!keep.has(m)) m.remove();
  }

  function renderChat(scrollToEnd) {
    const box = $('#focus-detail .convo');
    if (!box || !S.chat) return;
    const inner = clear(box.querySelector('.convo-inner'));
    if (S.chat.past.length) {
      inner.appendChild(h('p', { class: 'convo-note' }, 'Earlier in this conversation'));
      const past = h('div', { class: 'past' });
      for (const m of S.chat.past) past.appendChild(transcriptNode(m));
      markClaudeTurns(past);
      inner.appendChild(past);
      inner.appendChild(h('hr', { class: 'past-rule' }));
    }
    const items = [...S.chat.items.values()].sort((a, b) => a.n - b.n);
    if (!items.length && !S.chat.past.length) inner.appendChild(h('p', { class: 'convo-note chat-empty' }, 'Say what you want Claude to do. Replies appear here as they are written.'));
    for (const it of items) inner.appendChild(chatNode(it));
    inner.appendChild(h('div', { class: 'chat-spinner', hidden: true, 'aria-hidden': 'true' },
      h('span', { class: 'spin-glyph' }), h('span', { class: 'spin-verb' }), h('span', { class: 'spin-time faint' })));
    markClaudeTurns(inner);
    if (scrollToEnd) box.scrollTop = box.scrollHeight;
  }

  // ---- working spinner -----------------------------------------------------------------------
  // Like Claude Code's terminal spinner: a pulsing star, a verb (public/spinner-verbs.js) that
  // changes every few seconds, and how long Claude has been at it. Shown while the chat is busy,
  // hidden while it waits for you.
  const SPIN_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const SPIN_FRAME_MS = 120;
  const SPIN_VERB_MS = 6000;
  const SPIN_STILL = window.matchMedia('(prefers-reduced-motion: reduce)');
  const spin = { chatId: null, timer: null, frame: 0, verb: '', verbAt: 0, since: 0 };

  function pickVerb(prev) {
    const all = Deck.SPINNER_VERBS && Deck.SPINNER_VERBS.length ? Deck.SPINNER_VERBS : ['Working'];
    let v;
    do v = all[Math.floor(Math.random() * all.length)]; while (all.length > 1 && `${v}…` === prev);
    return /[.?!…]$/.test(v) ? v : `${v}…`;
  }

  function stopSpinner() {
    clearInterval(spin.timer);
    spin.timer = null;
    spin.chatId = null;
    const el = $('#focus-detail .chat-spinner');
    if (el && !el.hidden) {
      el.hidden = true;
      markClaudeTurns(el.parentElement);
    }
  }

  function spinTick() {
    const it = spin.chatId ? findItem(`d:${spin.chatId}`) : null;
    if (!it || it.status !== 'busy' || it.state !== 'running' || !S.chat || S.chat.id !== spin.chatId) return stopSpinner();
    const el = $('#focus-detail .chat-spinner');
    if (!el) return; // the chat is still loading
    const box = el.closest('.convo');
    const stick = el.hidden && box && nearBottom(box);
    if (Date.now() - spin.verbAt > SPIN_VERB_MS) { spin.verb = pickVerb(spin.verb); spin.verbAt = Date.now(); }
    spin.frame = (spin.frame + 1) % SPIN_GLYPHS.length;
    // Write only what changed: the star each frame, the verb and the time when they change.
    const write = (sel, text) => { const n = el.querySelector(sel); if (n.textContent !== text) n.textContent = text; };
    write('.spin-glyph', SPIN_STILL.matches ? '✻' : SPIN_GLYPHS[spin.frame]);
    write('.spin-verb', spin.verb);
    write('.spin-time', `(${duration(Date.now() - spin.since)})`);
    if (el.hidden) {
      el.hidden = false;
      markClaudeTurns(el.parentElement);
    }
    if (stick) box.scrollTop = box.scrollHeight;
  }

  function renderSpinner(it) {
    const busy = isChat(it) && it.state === 'running' && it.status === 'busy';
    if (!busy) {
      if (spin.chatId === it.id || !isChat(it)) stopSpinner();
      return;
    }
    if (spin.chatId === it.id && spin.timer) {
      // The server moves statusSince forward after the PC sleeps, so sleep isn't counted as working.
      if (it.statusSince) spin.since = it.statusSince;
      return;
    }
    stopSpinner();
    Object.assign(spin, { chatId: it.id, frame: 0, verb: pickVerb(), verbAt: Date.now(), since: it.statusSince || Date.now() });
    spin.timer = setInterval(spinTick, SPIN_FRAME_MS);
    spinTick();
  }

  function upsertChatNode(item) {
    const box = $('#focus-detail .convo');
    if (!box) return;
    const inner = box.querySelector('.convo-inner');
    const stick = nearBottom(box);
    const empty = inner.querySelector('.chat-empty');
    if (empty) empty.remove();
    const node = chatNode(item);
    const existing = inner.querySelector(`[data-n="${item.n}"]`);
    if (existing) {
      // Keep an expanded tool call expanded when its result arrives (an edit's comes with its diff).
      const details = (el) => (el.tagName === 'DETAILS' ? el : el.querySelector(':scope > details'));
      const was = details(existing);
      const now = details(node);
      if (was && now && was.open) now.open = true;
      existing.replaceWith(node);
    } else {
      // New messages go above the working spinner, which stays last.
      inner.insertBefore(node, inner.querySelector('.chat-spinner'));
    }
    markClaudeTurns(inner);
    if (stick || item.kind === 'user') box.scrollTop = box.scrollHeight;
  }

  async function stopTurn(it) {
    const res = await run("Couldn't stop Claude", () => api('POST', `/api/chats/${it.id}/interrupt`));
    if (res) toast('Stopping…');
  }

  // Your earlier messages in the open chat, newest first, for ↑ in the reply box: { text, pasted }
  // (where its long pastes are, to show them as placeholders again). Queued ones are left out: ↑
  // takes those back out of the queue instead.
  function sentMessages() {
    if (!S.chat) return [];
    const live = [...S.chat.items.values()].filter((x) => x.kind === 'user' && !x.withdrawn && !x.queued).sort((a, b) => b.n - a.n).map((x) => ({ text: x.text, pasted: x.pasted }));
    const past = (S.chat.past || []).filter((x) => x.kind === 'user').map((x) => ({ text: x.text })).reverse();
    // From before a /clear that emptied the chat.
    const earlier = [...(S.chat.earlierPrompts || [])].reverse().map((t) => ({ text: t }));
    const out = [];
    for (const m of [...live, ...past, ...earlier]) {
      const t = m.text;
      if (t && t.trim() && !/^\[\d+ images?\]$/.test(t) && (!out.length || out[out.length - 1].text !== t)) out.push(m);
    }
    return out;
  }

  const hasQueued = () => Boolean(S.chat && [...S.chat.items.values()].some((x) => x.kind === 'user' && x.queued && !x.withdrawn));

  function composer(it) {
    const ta = h('textarea', { class: 'composer-input', rows: '1', placeholder: 'Reply to Claude', 'aria-label': 'Message to Claude', spellcheck: 'true' });
    ta.value = S.drafts[it.id] || '';
    const slash = h('div', { class: 'slash', role: 'listbox', hidden: true });
    let slashItems = [];
    let slashIndex = 0;

    const autosize = () => {
      ta.style.height = 'auto';
      const max = window.innerHeight * 0.4;
      ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
      // A scrollbar only once the message is taller than the box can grow.
      ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
    };
    // The /command being typed at the cursor, anywhere in the message as in Claude Code: a / at the
    // start or after a space, with the cursor at the end of that word. Claude runs one at the start
    // itself; one later in the message is for Claude to run (the Skill tool takes /<name> as asking).
    const slashWord = () => {
      if (ta.selectionStart !== ta.selectionEnd) return null;
      const at = ta.selectionStart;
      const m = /(^|\s)\/(\S*)$/.exec(ta.value.slice(0, at));
      if (!m || /^\S/.test(ta.value.slice(at))) return null;
      return { start: m.index + m[1].length, end: at, query: m[2] };
    };
    // @ at the cursor, as in Claude Code: files in the chat's folder, from Claude Code's own file
    // index (file_suggestions). The index builds on first use, so an empty first answer is asked
    // again once.
    const atWord = () => {
      if (ta.selectionStart !== ta.selectionEnd) return null;
      const at = ta.selectionStart;
      const m = /(^|\s)@("[^"]*|\S*)$/.exec(ta.value.slice(0, at));
      if (!m || /^\S/.test(ta.value.slice(at))) return null;
      return { start: m.index + m[1].length, end: at, query: m[2].replace(/^"/, '') };
    };
    const atFiles = { query: null, list: [], timer: null, warmed: false };
    const fetchFiles = (q) => {
      clearTimeout(atFiles.timer);
      atFiles.timer = setTimeout(async () => {
        let list;
        try { list = (await api('GET', `/api/chats/${it.id}/files?q=${encodeURIComponent(q)}`)).suggestions; } catch { return; }
        if (!list.length && !atFiles.warmed) {
          atFiles.warmed = true;
          atFiles.timer = setTimeout(() => fetchFiles(q), FILE_INDEX_WAIT_MS);
          return;
        }
        atFiles.warmed = true;
        Object.assign(atFiles, { query: q, list });
        drawSlash();
      }, FILE_QUERY_DELAY_MS);
    };
    // A path with spaces goes in quoted, as Claude Code writes it: @"My Folder/file.txt".
    const atText = (p) => (/\s/.test(p) ? `@"${p}"` : `@${p}`);
    const drawSlash = () => {
      // Not while ↑ steps through earlier messages: the list would take the next ↑.
      const w = browsing() ? null : slashWord();
      const a = w || browsing() ? null : atWord();
      const commands = (S.chat && S.chat.commands) || [];
      if (w) {
        slashItems = commands.filter((c) => c.name.toLowerCase().startsWith(w.query.toLowerCase())).slice(0, 8)
          .map((c) => ({ word: `/${c.name} `, label: `/${c.name}`, hint: c.argumentHint, desc: c.description }));
      } else if (a) {
        if (atFiles.query !== a.query) fetchFiles(a.query);
        // A folder ends with a separator and keeps the list open, to go on into it.
        slashItems = atFiles.query === a.query ? atFiles.list.slice(0, 8).map((p) => ({ word: /[\\/]$/.test(p) ? atText(p) : `${atText(p)} `, label: p, file: true })) : [];
      } else {
        slashItems = [];
      }
      slashIndex = Math.min(slashIndex, Math.max(0, slashItems.length - 1));
      clear(slash);
      slash.hidden = !slashItems.length;
      slashItems.forEach((c, i) => {
        slash.appendChild(h('button', { type: 'button', class: `slash-item${c.file ? ' slash-file' : ''}`, role: 'option', 'aria-selected': String(i === slashIndex), onmousedown: (e) => { e.preventDefault(); pick(i); } },
          c.file ? Deck.icon(/[\\/]$/.test(c.label) ? 'folder' : 'file', { size: 13 }) : null,
          h('span', { class: 'slash-name' }, c.label), c.hint ? h('span', { class: 'faint' }, ` ${c.hint}`) : null, c.desc ? h('span', { class: 'slash-desc' }, c.desc) : null));
      });
    };
    const pick = (i) => {
      const c = slashItems[i];
      const w = slashWord() || atWord();
      if (!c || !w) return;
      // Only the word being typed is replaced; the rest of the message stays.
      const rest = ta.value.slice(w.end).replace(/^ /, '');
      ta.value = ta.value.slice(0, w.start) + c.word + rest;
      ta.setSelectionRange(w.start + c.word.length, w.start + c.word.length);
      S.drafts[it.id] = ta.value;
      autosize();
      drawSlash();
      ta.focus();
    };
    // Attached images waiting to be sent, and long pastes shown as placeholders, kept per chat so
    // switching chats doesn't lose them.
    S.attachments[it.id] = S.attachments[it.id] || [];
    const pasted = Deck.pastedText;
    S.pastes[it.id] = S.pastes[it.id] || { texts: {}, last: null };
    const pastes = S.pastes[it.id];
    const tray = h('div', { class: 'attach-tray', hidden: true });
    const drawTray = () => {
      const list = S.attachments[it.id];
      clear(tray);
      tray.hidden = !list.length;
      list.forEach((a, i) => {
        tray.appendChild(h('div', { class: 'attach', title: `${a.name} (${Math.round(a.bytes / 1024)} KB${a.resized ? ', resized' : ''})` },
          h('img', { src: a.thumb, alt: a.name }),
          h('button', { type: 'button', class: 'attach-remove', 'aria-label': `Remove ${a.name}`, onclick: () => { list.splice(i, 1); drawTray(); } }, Deck.icon('close', { size: 12 }))));
      });
    };
    const addFiles = async (files) => {
      for (const f of files) {
        try {
          S.attachments[it.id].push(await prepareImage(f));
        } catch (err) {
          toast(err.message, 'error');
        }
      }
      drawTray();
      ta.focus();
    };
    // Any other dropped file: Claude Deck keeps a copy and types its path at the cursor (quoted if it
    // has spaces), as dropping a file into Claude Code's terminal does. Claude reads it from there.
    const insertText = (text) => {
      const before = ta.value.slice(0, ta.selectionStart);
      const after = ta.value.slice(ta.selectionEnd);
      const typed = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${/^\s/.test(after) ? '' : ' '}`;
      ta.value = before + typed + after;
      ta.setSelectionRange(before.length + typed.length, before.length + typed.length);
      S.drafts[it.id] = ta.value;
      autosize();
    };
    const addOtherFiles = async (files) => {
      for (const f of files) {
        try {
          if (f.size > MAX_FILE_BYTES) throw new Error('It is larger than 40 MB. Put it in the project folder and name it in your message instead.');
          const data = (await readAsDataUrl(f)).replace(/^data:[^,]*,/, '');
          const res = await api('POST', `/api/chats/${it.id}/files`, { name: f.name, data });
          insertText(/\s/.test(res.path) ? `"${res.path}"` : res.path);
        } catch (err) {
          toast(`Couldn't attach ${f.name}: ${err.message}`, 'error');
        }
      }
      ta.focus();
    };

    // ↑ in an empty reply box, as in Claude Code's terminal: queued messages come back out of the
    // queue to edit; otherwise it steps back through your earlier messages (↓ steps forward, back
    // to an empty box). A draft you've typed is never replaced: ↑ then just moves the cursor.
    let recall = null; // { list, index, draft, shown } while stepping through earlier messages
    const show = (text) => {
      ta.value = text;
      S.drafts[it.id] = text;
      autosize();
      drawSlash();
      ta.setSelectionRange(text.length, text.length);
    };
    // A sent message back in the box, its long pastes as placeholders again, as Claude Code's ↑ does.
    const showSent = (m) => {
      const { value, texts } = pasted.collapse(m.text, m.pasted);
      pastes.texts = texts;
      pastes.last = null;
      show(value);
      return value;
    };
    const onFirstLine = () => ta.selectionStart === ta.selectionEnd && !ta.value.slice(0, ta.selectionStart).includes('\n');
    const onLastLine = () => ta.selectionStart === ta.selectionEnd && !ta.value.slice(ta.selectionEnd).includes('\n');
    const browsing = () => Boolean(recall && ta.value === recall.shown);
    const recallOlder = async () => {
      if (!browsing()) {
        recall = null;
        if (hasQueued()) {
          const res = await run("Couldn't take the queued messages back", () => api('POST', `/api/chats/${it.id}/unqueue`));
          if (res && res.messages.length) {
            // One after another in the box, each one's pastes moved along with it.
            let text = '';
            const ranges = [];
            for (const m of res.messages.filter((x) => x.text && x.text.trim())) {
              if (text) text += '\n\n';
              for (const [start, end] of m.pasted || []) ranges.push([start + text.length, end + text.length]);
              text += m.text;
            }
            showSent({ text, pasted: ranges });
            for (const m of res.messages) {
              for (const img of m.images) {
                S.attachments[it.id].push({ name: 'Image', bytes: Math.round(img.data.length * 0.75), mediaType: img.mediaType, data: img.data, thumb: img.thumb || `data:${img.mediaType};base64,${img.data}` });
              }
            }
            drawTray();
            toast(res.messages.length === 1 ? 'Queued message is back in the reply box' : `${res.messages.length} queued messages are back in the reply box`);
            return;
          }
          // Claude had already picked them up; carry on to earlier messages.
        }
        recall = { list: sentMessages(), index: -1, draft: ta.value, draftPastes: pastes.texts, shown: null };
      }
      if (recall.index + 1 >= recall.list.length) return;
      recall.index++;
      recall.shown = showSent(recall.list[recall.index]);
    };
    const recallNewer = () => {
      if (recall.index <= 0) {
        const { draft, draftPastes } = recall;
        recall = null;
        pastes.texts = draftPastes;
        pastes.last = null;
        show(draft);
        return;
      }
      recall.index--;
      recall.shown = showSent(recall.list[recall.index]);
    };

    // Long pastes, as in Claude Code: the box shows "[Pasted text #1 +123 lines]" and the text is
    // sent in its place (public/pasted-text.js). Pasting the same text again straight after expands
    // it where it is. Typing goes through the browser's own editing, so Ctrl+Z still undoes it.
    const replaceRange = (start, end, text) => {
      ta.focus();
      ta.setSelectionRange(start, end);
      if (!document.execCommand('insertText', false, text)) {
        ta.setRangeText(text, start, end, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    };
    // Shown for a few seconds in place of the usual hint, which updateComposer keeps up to date.
    const hint = h('div', { class: 'composer-hint' }, 'Enter sends. Shift+Enter adds a line. Type / for commands. Ctrl+V or Alt+V pastes an image. Esc goes to the session list.');
    const pasteHint = h('div', { class: 'composer-hint-paste', role: 'status', hidden: true });
    let hintTimer = null;
    // sticky: stays until taken down (shell mode's note, while the message starts with !).
    const flashHint = (text, sticky = false) => {
      pasteHint.textContent = text;
      pasteHint.hidden = false;
      hint.hidden = true;
      clearTimeout(hintTimer);
      if (sticky) pasteHint.dataset.sticky = '1';
      else {
        delete pasteHint.dataset.sticky;
        hintTimer = setTimeout(() => { pasteHint.hidden = true; hint.hidden = false; }, PASTE_HINT_MS);
      }
    };
    const pasteText = (raw) => {
      const text = pasted.normalize(raw);
      const again = pastes.last !== null && pastes.texts[pastes.last] === text ? pasted.find(ta.value, pastes.last) : null;
      if (again) {
        delete pastes.texts[pastes.last];
        pastes.last = null;
        replaceRange(again.start, again.end, text);
        return true;
      }
      if (!pasted.collapses(text)) return false;
      const id = pasted.nextId(ta.value);
      pastes.texts[id] = text;
      pastes.last = id;
      replaceRange(ta.selectionStart, ta.selectionEnd, pasted.placeholder(id, text));
      if (text.length <= PASTE_EXPAND_MAX) flashHint('Paste again to expand it in the reply box.');
      return true;
    };

    // Clears what was just used from the box (and its pastes), leaving anything typed meanwhile.
    const takeOut = (text) => {
      const rest = ta.value.startsWith(text) ? ta.value.slice(text.length).replace(/^\s+/, '') : ta.value;
      ta.value = rest;
      if (rest) S.drafts[it.id] = rest;
      else delete S.drafts[it.id];
      const kept = new Set(pasted.idsIn(rest).map(String));
      for (const id of Object.keys(pastes.texts)) if (!kept.has(id)) delete pastes.texts[id];
      if (!kept.has(String(pastes.last))) pastes.last = null;
      autosize();
      drawSlash();
      drawMode();
    };

    // "!command": runs it now, in PowerShell, without Claude; Claude sees it and its output with
    // your next message (src/shell-mode.js), as Claude Code's shell mode does.
    const runShell = async (text) => {
      const command = pasted.expand(text.replace(/^\s*!/, ''), pastes.texts).text.trim();
      if (!command) { toast('Type a command after the !.'); return; }
      S.sending[it.id] = true;
      takeOut(text);
      try {
        await run("Couldn't run the command", () => api('POST', `/api/chats/${it.id}/shell`, { command }));
      } finally {
        delete S.sending[it.id];
      }
    };

    // "/btw question": asked aside, answered here, and kept out of the conversation, as Claude
    // Code's /btw does.
    const aside = h('div', { class: 'side-answer', role: 'status', hidden: true });
    const closeAside = () => { aside.hidden = true; clear(aside); };
    const askAside = async (text, question) => {
      takeOut(text);
      clear(aside).append(h('div', { class: 'side-q' }, h('span', { class: 'side-label' }, 'By the way'), question), h('p', { class: 'faint' }, 'Asking…'));
      aside.hidden = false;
      const res = await run("Couldn't ask the side question", () => api('POST', `/api/chats/${it.id}/side`, { question }));
      if (!res) { closeAside(); return; }
      const answer = h('div', { class: 'side-a' });
      answer.appendChild(richText(res.answer || 'No answer.'));
      clear(aside).append(
        h('div', { class: 'side-q' }, h('span', { class: 'side-label' }, 'By the way'), res.question,
          h('button', { type: 'button', class: 'ghost icon small side-close', title: 'Dismiss (Esc)', 'aria-label': 'Dismiss the answer', onclick: () => { closeAside(); ta.focus(); } }, Deck.icon('close', { size: 12 }))),
        answer,
        h('p', { class: 'faint small' }, 'Not part of the conversation; Claude won\'t remember it.'));
    };

    // sendNow: Claude Code's Send now (Ctrl+Enter, or Ctrl+X then Ctrl+S): while Claude works, it
    // takes the message next instead of after the turn; with nothing typed, what's queued goes now.
    const submit = async (interrupt, sendNow = false) => {
      // One send at a time: a second Enter while the first is on its way would send it twice.
      if (S.sending[it.id]) return;
      recall = null;
      const text = ta.value;
      const list = S.attachments[it.id];
      if (!text.trim() && !list.length) {
        if (interrupt) stopTurn(it);
        else if (sendNow && hasQueued()) sendQueuedNow();
        return;
      }
      if (!list.length && /^\s*!/.test(text)) { runShell(text); return; }
      const btw = /^\s*\/btw\s+([\s\S]+)$/.exec(text);
      if (!list.length && btw) { askAside(text, pasted.expand(btw[1], pastes.texts).text.trim()); return; }
      const images = list.map((a) => ({ mediaType: a.mediaType, data: a.data, thumb: a.thumb }));
      S.sending[it.id] = true;
      let res;
      try {
        const sent = pasted.expand(text, pastes.texts);
        res = await run("Couldn't send", () => api('POST', `/api/chats/${it.id}/send`, { text: sent.text, pasted: sent.ranges, images, interrupt: interrupt === true, sendNow: sendNow === true }));
      } finally {
        delete S.sending[it.id];
      }
      if (res) {
        // Only what was sent is cleared. Sending can wait on Claude (after Interrupt, say), and
        // anything typed or attached meanwhile stays (with its pastes).
        takeOut(text);
        S.attachments[it.id] = (S.attachments[it.id] || []).filter((a) => !list.includes(a));
        drawTray();
      }
    };

    // Send now with nothing typed: the messages already waiting in Claude's queue go now.
    const sendQueuedNow = async () => {
      S.sending[it.id] = true;
      try {
        const res = await run("Couldn't send the queued messages now", () => api('POST', `/api/chats/${it.id}/send`, { text: '', sendNow: true }));
        if (res) toast('Claude takes the queued messages next.');
      } finally {
        delete S.sending[it.id];
      }
    };

    // Ctrl+X starts a two-key chord, as in Claude Code: Ctrl+S sends now, Enter queues.
    const CHORD_MS = 2000;
    let chordAt = 0;
    let chordTimer = null;
    const endChord = () => {
      chordAt = 0;
      clearTimeout(chordTimer);
      if (pasteHint.dataset.chord) { delete pasteHint.dataset.chord; pasteHint.hidden = true; hint.hidden = false; }
    };
    const startChord = () => {
      chordAt = Date.now();
      flashHint('Ctrl+X: now Ctrl+S sends now, Enter queues, Esc cancels');
      pasteHint.dataset.chord = '1';
      clearTimeout(chordTimer);
      chordTimer = setTimeout(endChord, CHORD_MS);
    };

    // A message starting with ! is a shell command, as in Claude Code: the box says so.
    const drawMode = () => {
      const shell = /^\s*!/.test(ta.value);
      box.classList.toggle('shell-mode', shell);
      if (shell) flashHint('Shell mode: Enter runs this in PowerShell, in the chat\'s folder. Claude sees it and its output with your next message.', true);
      else if (pasteHint.dataset.sticky) { pasteHint.hidden = true; hint.hidden = false; delete pasteHint.dataset.sticky; }
    };

    ta.addEventListener('input', () => { S.drafts[it.id] = ta.value; autosize(); drawSlash(); drawMode(); });
    // The command list follows the cursor: it opens or closes as the cursor moves onto or off a /word.
    ta.addEventListener('click', drawSlash);
    ta.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) drawSlash(); });
    // Ctrl+V: pasted images come in with the paste event (no permission needed); long text goes in
    // as a placeholder.
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData ? e.clipboardData.items : [])].filter((x) => x.kind === 'file' && x.type.startsWith('image/')).map((x) => x.getAsFile()).filter(Boolean);
      if (files.length) {
        e.preventDefault();
        addFiles(files);
        return;
      }
      const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (text && pasteText(text)) e.preventDefault();
    });
    ta.addEventListener('keydown', (e) => {
      if (!slash.hidden) {
        if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % slashItems.length; drawSlash(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length; drawSlash(); return; }
        if (e.key === 'Tab') { e.preventDefault(); pick(slashIndex); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); slash.hidden = true; return; }
        // Enter takes the highlighted command or file too, as in Claude Code, rather than sending
        // the half-typed word. A command typed out in full is sent.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          const c = slashItems[slashIndex];
          const w = slashWord();
          const typedOut = c && !c.file && w && c.label.toLowerCase() === `/${w.query}`.toLowerCase();
          if (c && !typedOut) { e.preventDefault(); pick(slashIndex); return; }
        }
      }
      const plainKey = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing;
      const ctrlOnly = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
      const now = findItem(`d:${it.id}`) || it;
      // The second key of a Ctrl+X chord: Ctrl+S sends now, Enter queues, Esc cancels; anything
      // else drops the chord and does what it always does.
      if (chordAt && Date.now() - chordAt < CHORD_MS) {
        endChord();
        if (ctrlOnly && e.key.toLowerCase() === 's') { e.preventDefault(); submit(false, true); return; }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!e.repeat) submit(false); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return; }
        if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) { startChord(); return; } // the modifier on its way to the second key
      } else if (chordAt) endChord();
      // Ctrl+X with nothing selected starts the chord (with a selection it cuts, as anywhere).
      if (ctrlOnly && e.key.toLowerCase() === 'x' && ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        startChord();
        return;
      }
      // Ctrl+Enter, as in Claude Code: send now.
      if (ctrlOnly && e.key === 'Enter') {
        e.preventDefault();
        if (!e.repeat) submit(false, true);
        return;
      }
      // Shift+Tab, as in Claude Code: the next permission mode (ask before edits, accept edits, plan).
      if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        cycleMode(now);
        return;
      }
      // Tab in an empty box takes Claude Code's suggested next prompt.
      if (plainKey && e.key === 'Tab' && !ta.value && now.suggestion) {
        e.preventDefault();
        show(now.suggestion);
        return;
      }
      // Ctrl+B, as in Claude Code: what Claude is waiting on carries on in the background, and Claude
      // carries on. With nothing to background, Ctrl+B is the page's own (narrowing the session list).
      if (ctrlOnly && e.key.toLowerCase() === 'b' && now.foregroundTasks > 0) {
        e.preventDefault();
        backgroundTasks(it);
        return;
      }
      // Ctrl+R, as in Claude Code: search your earlier prompts.
      if (ctrlOnly && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        openPromptSearch();
        return;
      }
      if (plainKey && e.key === 'ArrowUp' && onFirstLine() && (browsing() || (!ta.value && !S.attachments[it.id].length))) {
        e.preventDefault();
        recallOlder();
        return;
      }
      if (plainKey && e.key === 'ArrowDown' && browsing() && onLastLine()) {
        e.preventDefault();
        recallNewer();
        return;
      }
      if (e.altKey && e.key.toLowerCase() === 'v') {
        // Alt+V, as in Claude Code: read an image straight from the clipboard.
        e.preventDefault();
        pasteClipboardImage().then((files) => { if (files.length) addFiles(files); }).catch((err) => toast(err.message, 'error'));
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        // While Claude works this queues the message; Interrupt sends it right away instead.
        // A held-down Enter repeats; only the first press sends.
        e.preventDefault();
        if (!e.repeat) submit(false);
      } else if (e.key === 'Escape' && !aside.hidden) {
        e.preventDefault();
        e.stopPropagation();
        closeAside();
      } else if (e.key === 'Escape' && !ta.value) {
        e.preventDefault();
        e.stopPropagation();
        // Twice, quickly, as Claude Code's Esc Esc: go back to an earlier message. Once: to the
        // session list (a moment later, to tell the two apart).
        if (escTimer) {
          clearTimeout(escTimer);
          escTimer = null;
          rewindHere();
          return;
        }
        escTimer = setTimeout(() => { escTimer = null; focusSessionList(); }, DOUBLE_ESC_MS);
      }
    });
    setTimeout(autosize, 0);

    // Esc Esc, or the session menu's "Go back to an earlier message": the chosen message comes back
    // into the box, to change and send again.
    let escTimer = null;
    const rewindHere = async () => {
      const back = await openRewind(it);
      if (back) showSent(back);
      ta.focus();
    };
    S.rewindHere = { chatId: it.id, run: rewindHere };

    // Ctrl+R: your earlier prompts, from Claude Code's own prompt history; this folder's first.
    const search = h('div', { class: 'prompt-search', hidden: true });
    const openPromptSearch = () => {
      let results = [];
      let index = 0;
      let timer = null;
      const input = h('input', { type: 'search', placeholder: 'Search your earlier prompts', 'aria-label': 'Search your earlier prompts', spellcheck: 'false' });
      const list = h('div', { class: 'ps-list', role: 'listbox' });
      const close = () => { clearTimeout(timer); search.hidden = true; clear(search); ta.focus(); };
      const use = (r) => {
        // A paste whose text Claude Code no longer keeps is left out, rather than sent as its label.
        let text = r.text;
        const texts = {};
        let missing = 0;
        for (const [id, body] of Object.entries(r.pastes || {})) {
          if (typeof body === 'string') texts[id] = body;
          else {
            missing++;
            text = text.replace(new RegExp(`\\[Pasted text #${id}(?: \\+\\d+ lines)?\\]`), '');
          }
        }
        close();
        pastes.texts = texts;
        pastes.last = null;
        show(text);
        if (missing) toast(`${missing === 1 ? 'A paste in that prompt isn\'t' : 'Pastes in that prompt aren\'t'} saved anymore, so ${missing === 1 ? 'it was' : 'they were'} left out.`);
      };
      const draw = () => {
        clear(list);
        if (!results.length) list.appendChild(h('p', { class: 'faint small ps-empty' }, input.value.trim() ? 'No earlier prompts match.' : 'No earlier prompts yet.'));
        results.forEach((r, i) => list.appendChild(h('button', { type: 'button', class: 'ps-item', role: 'option', 'aria-selected': String(i === index), title: r.folder || '', onmousedown: (e) => { e.preventDefault(); use(r); } },
          h('span', { class: 'ps-text' }, r.text.replace(/\s+/g, ' ')),
          h('span', { class: 'faint small' }, `${r.folder && it.cwd && r.folder.toLowerCase() === it.cwd.toLowerCase() ? '' : `${shortPath(r.folder || '', 1)} · `}${r.ts ? ago(r.ts) : ''}`))));
      };
      const load = async () => {
        try { results = await api('GET', `/api/prompt-history?q=${encodeURIComponent(input.value)}&cwd=${encodeURIComponent(it.cwd || '')}`); } catch (err) { results = []; toast(err.message, 'error'); }
        index = 0;
        draw();
      };
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 120); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'ArrowDown' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) { e.preventDefault(); index = Math.min(results.length - 1, index + 1); draw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); draw(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (results[index]) use(results[index]); }
      });
      input.addEventListener('blur', () => setTimeout(() => { if (!search.contains(document.activeElement)) { search.hidden = true; clear(search); } }, 150));
      clear(search).append(h('div', { class: 'ps-head' }, h('span', { class: 'side-label' }, 'Earlier prompts'), h('span', { class: 'faint small' }, 'Ctrl+R or ↓ for the next, Enter to use it, Esc to close')), input, list);
      search.hidden = false;
      input.focus();
      load();
    };

    const picker = h('input', { type: 'file', accept: IMAGE_TYPES.join(','), multiple: true, hidden: true });
    picker.addEventListener('change', () => { addFiles([...picker.files]); picker.value = ''; });
    const attachBtn = h('button', { type: 'button', class: 'ghost attach-btn', title: 'Attach images (or paste with Ctrl+V or Alt+V, or drop them here). Drop any other file here to add its path.', onclick: () => picker.click() }, 'Image');
    const sendBtn = h('button', { type: 'button', class: 'primary send-btn', onclick: () => submit(false) }, 'Send');
    const sendNowBtn = h('button', { type: 'button', class: 'sendnow-btn', hidden: true, onclick: () => submit(false, true), title: "Send now, as Claude Code's Ctrl+X Ctrl+S: Claude takes this message next instead of after the turn; with nothing typed, the queued messages go now (Ctrl+Enter)" }, 'Send now');
    const interruptBtn = h('button', { type: 'button', class: 'danger interrupt-btn', hidden: true, onclick: () => submit(true), title: 'Stop what Claude is doing, and send your message now if you typed one' }, 'Interrupt');
    const ended = h('div', { class: 'composer-ended', hidden: true },
      h('span', null, 'This chat has ended.'),
      h('button', { type: 'button', class: 'primary small', onclick: () => resumeChat(it) }, 'Resume'));
    const box = h('div', { class: 'composer', dataset: { chat: it.id } },
      h('div', { class: 'work-panel', hidden: true }),
      aside,
      search,
      slash,
      ended,
      tray,
      h('div', { class: 'composer-row' }, ta, h('div', { class: 'composer-buttons' }, attachBtn, sendBtn, sendNowBtn, interruptBtn), picker),
      hint,
      pasteHint);
    // Drop files anywhere on the reply box: images are attached, anything else goes in by path.
    // Every dropped file is handled here; left to Edge, it would open the file in place of Claude Deck.
    box.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); box.classList.add('dropping'); } });
    box.addEventListener('dragleave', () => box.classList.remove('dropping'));
    box.addEventListener('drop', (e) => {
      box.classList.remove('dropping');
      const files = [...e.dataTransfer.files];
      if (!files.length) return;
      e.preventDefault();
      if (ta.disabled) return;
      const images = files.filter((f) => IMAGE_TYPES.includes(f.type));
      const others = files.filter((f) => !images.includes(f));
      if (images.length) addFiles(images);
      if (others.length) addOtherFiles(others);
    });
    drawTray();
    return box;
  }

  // Shift+Tab in the reply box: the next permission mode, in Claude Code's order.
  async function cycleMode(it) {
    if (it.state === 'exited') return;
    const at = MODE_CYCLE.indexOf(it.permissionMode || 'default');
    const mode = MODE_CYCLE[(at + 1) % MODE_CYCLE.length];
    const res = await run("Couldn't change the permission mode", () => api('POST', `/api/chats/${it.id}/mode`, { mode }));
    if (res) toast(`${MODE_NAMES[mode]} (Shift+Tab for the next)`);
  }

  // Ctrl+B: what Claude is waiting on (a long command, a subagent) carries on in the background.
  async function backgroundTasks(it) {
    const res = await run("Couldn't move it to the background", () => api('POST', `/api/chats/${it.id}/background`));
    if (res) toast('Running in the background. Claude carries on.');
  }

  // Esc Esc: pick one of your messages in this chat to go back to before, as Claude Code's rewind
  // does; Claude starts again from there (a new session, so the conversation as it was stays in
  // History). Resolves the message to put back in the reply box, or null.
  function openRewind(it) {
    const live = findItem(`d:${it.id}`) || it;
    const mine = S.chat && S.chat.id === it.id
      ? [...S.chat.items.values()].filter((x) => x.kind === 'user' && x.commandUuid && !x.queued && !x.withdrawn && x.text && x.text.trim()).sort((a, b) => b.n - a.n)
      : [];
    if (live.state === 'exited') { toast('This chat has ended. Resume it first.'); return Promise.resolve(null); }
    if (live.status === 'busy') { toast('Claude is working. Interrupt it first, then go back.'); return Promise.resolve(null); }
    if (!mine.length) { toast('Nothing to go back to yet: none of your messages in this chat can be rewound.'); return Promise.resolve(null); }
    return new Promise((resolve) => {
      let chosen = mine[0].commandUuid;
      const rows = mine.map((m, i) => h('label', { class: 'rw-row' },
        h('input', { type: 'radio', name: 'rewind-to', value: m.commandUuid, checked: i === 0, onchange: () => { chosen = m.commandUuid; } }),
        h('span', { class: 'rw-text' }, Deck.pastedText.collapse(m.text, m.pasted).value.replace(/\s+/g, ' ')),
        h('span', { class: 'faint small' }, ago(m.ts))));
      const files = h('input', { type: 'checkbox' });
      const dlg = h('dialog', { class: 'dialog' },
        h('form', { method: 'dialog' },
          h('h2', null, 'Go back to before which message?'),
          h('p', { class: 'muted' }, 'Claude forgets everything from that message on, and the message comes back to the reply box to change. The conversation as it was stays in History.'),
          h('div', { class: 'rw-list' }, rows),
          h('label', { class: 'check' }, files, 'Also put files back as they were before that message'),
          h('div', { class: 'dialog-actions' },
            h('button', { value: 'cancel', class: 'ghost' }, 'Cancel'),
            h('button', { value: 'ok', class: 'primary', autofocus: true }, 'Go back'))));
      dlg.addEventListener('close', async () => {
        dlg.remove();
        if (dlg.returnValue !== 'ok') { resolve(null); return; }
        const res = await run("Couldn't go back", () => api('POST', `/api/chats/${it.id}/rewind`, { messageId: chosen, files: files.checked }));
        resolve(res || null);
      });
      document.body.appendChild(dlg);
      dlg.showModal();
    });
  }

  // Above the reply box: Claude's to-do list (as Claude Code shows it while it works), what's
  // running in the background, and Ctrl+B while Claude waits on something.
  function renderWorkPanel(el, it) {
    if (!el) return;
    const todos = Array.isArray(it.todos) && it.todos.some((t) => t.status !== 'completed') ? it.todos : [];
    const bg = it.state !== 'exited' ? it.bgTasks || [] : [];
    const fg = it.status === 'busy' ? it.foregroundTasks || 0 : 0;
    const sig = JSON.stringify([todos, bg, fg]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    clear(el);
    el.hidden = !todos.length && !bg.length && !fg;
    if (todos.length) {
      const done = todos.filter((t) => t.status === 'completed').length;
      el.appendChild(h('div', { class: 'todo-list' },
        h('div', { class: 'wp-head' }, h('span', { class: 'side-label' }, 'To do'), h('span', { class: 'faint small' }, `${done} of ${todos.length} done`)),
        todos.map((t) => h('div', { class: `todo ${t.status}` },
          h('span', { class: 'todo-box', 'aria-hidden': 'true' }, t.status === 'completed' ? Deck.icon('check', { size: 12 }) : null),
          h('span', { class: 'todo-text' }, t.status === 'in_progress' ? t.activeForm : t.content),
          h('span', { class: 'visually-hidden' }, t.status === 'completed' ? ' (done)' : t.status === 'in_progress' ? ' (in progress)' : '')))));
    }
    if (fg) {
      el.appendChild(h('div', { class: 'wp-row' },
        h('span', { class: 'faint small' }, `Claude is waiting on ${fg === 1 ? 'a task' : `${fg} tasks`}.`),
        h('button', { type: 'button', class: 'ghost small', onclick: () => backgroundTasks(it) }, 'Run in background (Ctrl+B)')));
    }
    for (const t of bg) {
      el.appendChild(h('div', { class: 'wp-row' },
        h('span', { class: 'small' }, h('span', { class: 'side-label' }, 'In the background'), ' ', t.description || (t.type === 'local_bash' ? 'A shell command' : 'A subagent')),
        h('button', { type: 'button', class: 'ghost small', onclick: () => run("Couldn't stop it", () => api('POST', `/api/chats/${it.id}/tasks/${encodeURIComponent(t.taskId)}/stop`)) }, 'Stop')));
    }
  }

  function updateComposer(it) {
    const c = $('#focus-detail .composer');
    if (!c) return;
    const exited = it.state === 'exited';
    const busy = it.status === 'busy';
    renderWorkPanel(c.querySelector('.work-panel'), it);
    // Claude Code's suggested next prompt, in the empty box; Tab takes it.
    c.querySelector('.composer-input').placeholder = !exited && it.suggestion ? `${it.suggestion}   (Tab to use)` : 'Reply to Claude';
    c.querySelector('.composer-ended').hidden = !exited;
    c.querySelector('.composer-input').disabled = exited;
    c.querySelector('.attach-btn').disabled = exited;
    // While Claude works, Enter queues and the button interrupts.
    c.querySelector('.send-btn').hidden = busy;
    c.querySelector('.send-btn').disabled = exited;
    c.querySelector('.sendnow-btn').hidden = !busy;
    c.querySelector('.interrupt-btn').hidden = !busy;
    c.querySelector('.composer-hint').textContent = composerHint(busy);
  }

  function composerHint(busy) {
    if (hasQueued()) return 'Claude is working. Your queued messages go when it finishes this step. Press ↑ to take them back and edit them, or Ctrl+Enter to have Claude take them now.';
    if (busy) return 'Claude is working. Enter queues your message for when it finishes this step. Send now (Ctrl+Enter, or Ctrl+X then Ctrl+S) has Claude take it next. Interrupt stops Claude.';
    return 'Enter sends. Shift+Enter adds a line. / commands, @ files, ! runs a shell command. ↑ or Ctrl+R recalls earlier prompts. Shift+Tab changes mode. Esc Esc goes back to an earlier message.';
  }

  // ---- images --------------------------------------------------------------------------------
  // Types and size the Messages API accepts; bigger images are scaled down before sending.
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024; // 5 MB once base64-encoded
  const MAX_IMAGE_SIDE = 2000;
  // A dropped file that isn't an image, as the server keeps it (src/chat.js saveFile).
  const MAX_FILE_BYTES = 40 * 1024 * 1024;
  // As Claude Code: "paste again to expand" shows for 8 seconds, and not for a paste over 100,000
  // characters (too long to want in the reply box).
  const PASTE_HINT_MS = 8000;
  const PASTE_EXPAND_MAX = 100000;
  // @ file suggestions: typing settles for this long before asking; an index still building
  // (an empty first answer) is asked again after the second.
  const FILE_QUERY_DELAY_MS = 120;
  const FILE_INDEX_WAIT_MS = 500;
  // Esc twice, this quickly, in an empty reply box: go back to an earlier message (Claude Code's Esc Esc).
  const DOUBLE_ESC_MS = 500;
  // Claude Code's Shift+Tab order.
  const MODE_CYCLE = ['default', 'acceptEdits', 'plan'];
  const MODE_NAMES = { default: 'Ask before edits', acceptEdits: 'Accept edits', plan: 'Plan mode' };

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      // A dropped folder lands here too: it can't be read as a file.
      r.onerror = () => reject(new Error('That file could not be read.'));
      r.readAsDataURL(blob);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file is not an image Claude Deck can open.'));
      img.src = src;
    });
  }

  function drawScaled(img, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  const canvasBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  async function prepareImage(file) {
    const name = file.name || 'Pasted image';
    if (!IMAGE_TYPES.includes(file.type)) throw new Error(`${name} isn't a PNG, JPEG, GIF or WebP image.`);
    const src = await readAsDataUrl(file);
    const img = await loadImage(src);
    let blob = file;
    let resized = false;
    if (file.size > MAX_IMAGE_BYTES || Math.max(img.naturalWidth, img.naturalHeight) > MAX_IMAGE_SIDE) {
      const canvas = drawScaled(img, MAX_IMAGE_SIDE);
      blob = file.type === 'image/png' ? await canvasBlob(canvas, 'image/png') : null;
      if (!blob || blob.size > MAX_IMAGE_BYTES) blob = await canvasBlob(canvas, 'image/jpeg', 0.9);
      if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error(`${name} is too large to send, even after shrinking it.`);
      resized = true;
    }
    const dataUrl = blob === file ? src : await readAsDataUrl(blob);
    const thumb = drawScaled(img, 320).toDataURL('image/webp', 0.8);
    return { name, mediaType: blob.type, data: dataUrl.slice(dataUrl.indexOf(',') + 1), thumb, bytes: blob.size, resized };
  }

  // Alt+V: the async clipboard API asks for permission the first time.
  async function pasteClipboardImage() {
    if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('This window can\'t read the clipboard. Paste with Ctrl+V instead.');
    let items;
    try {
      items = await navigator.clipboard.read();
    } catch {
      throw new Error('Clipboard access was blocked. Allow it for Claude Deck, or paste with Ctrl+V instead.');
    }
    const files = [];
    for (const item of items) {
      const type = item.types.find((t) => IMAGE_TYPES.includes(t));
      if (type) files.push(new File([await item.getType(type)], 'Pasted image', { type }));
    }
    if (!files.length) throw new Error('There is no image on the clipboard.');
    return files;
  }

  function renderFocus() {
    renderFocusList();
    renderFocusDetail();
  }

  // ---- sessions view glue --------------------------------------------------------------------
  function renderSummary() {
    const items = allItems();
    const count = (lane) => items.filter((it) => it.lane === lane).length;
    const parts = [
      ['waiting', count('waiting'), 'need you', 'needs you'],
      ['working', count('working'), 'working', 'working'],
      ['idle', count('idle'), 'idle', 'idle'],
    ].filter(([, n]) => n > 0);
    const sum = clear($('#summary'));
    for (const [lane, n, many, one] of parts) {
      sum.appendChild(h('span', null, h('span', { class: `lamp ${lane}`, style: { marginRight: '6px', verticalAlign: '0' } }), h('span', { class: 'n' }, String(n)), ` ${n === 1 ? one : many}`));
    }
    const waiting = count('waiting');
    $('#nav-attention').textContent = waiting ? String(waiting) : '';
    document.title = waiting ? `(${waiting}) Claude Deck` : 'Claude Deck';
    // A subagent still running after Claude's reply is still work.
    const working = count('working') > 0 || items.some((it) => it.runningTasks > 0);
    setAppIcon(waiting ? 'waiting' : working ? 'working' : 'idle');
  }

  // ---- window icon ---------------------------------------------------------------------------
  // The app window uses the page icon for its title bar and taskbar button: the mascot (same grid
  // as the .brand-mark SVG in index.html). While a session works it sweats, drops flicking from one
  // side to the other every half second; when one needs you it gets an amber dot instead.
  const MASCOT_BODY = '<path fill="#d97757" shape-rendering="crispEdges" d="M2 0h10v4h2v2h-2v4h-1v-2h-1v2h-1v-2h-4v2h-1v-2h-1v2h-1v-4h-2v-2h2z"/>'
    + '<path fill="#141413" shape-rendering="crispEdges" d="M4 2h1v2h-1zM9 2h1v2h-1z"/>';
  // A teardrop with its round part centered on 0,0 and its tip pointing up; rotated to point at the head.
  const drop = (x, y, angle, scale) => `<g transform="translate(${x} ${y}) rotate(${angle}) scale(${scale})">`
    + '<path fill="#8fd6d3" stroke="#4f9d9a" stroke-width="0.18" d="M0 -1.3C0.45 -0.75 0.6 -0.35 0.6 0A0.6 0.6 0 1 1 -0.6 0C-0.6 -0.35 -0.45 -0.75 0 -1.3Z"/>'
    + '<ellipse cx="-0.22" cy="-0.1" rx="0.14" ry="0.24" fill="#ffffff" opacity="0.85"/></g>';
  // In the mascot's grid (14 x 10, head top-right corner at 12,0): one big drop and two small ones,
  // larger than in the artwork so they still read at taskbar size (16-32 px).
  const DROPS = drop(13.9, -1.3, -135, 1.8) + drop(10.4, -1.6, 195, 1.15) + drop(14.1, 1.7, -100, 1.25);
  const iconUrl = (inner) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${inner}</svg>`)}`;
  const mascotIcon = (extra) => iconUrl(`<g transform="translate(1 3)">${MASCOT_BODY}${extra}</g>`);
  const APP_ICONS = {
    idle: mascotIcon(''),
    waiting: iconUrl(`<g transform="translate(1 3)">${MASCOT_BODY}</g><circle cx="12.2" cy="12.2" r="3" fill="#f0b545" stroke="#141413" stroke-width="1"/>`),
    working: [mascotIcon(DROPS), mascotIcon(`<g transform="translate(14 0) scale(-1 1)">${DROPS}</g>`)],
  };
  let appIconState = null;
  let appIconTicker = null;

  function setAppIcon(state) {
    if (state === appIconState) return;
    appIconState = state;
    if (appIconTicker) { appIconTicker.stop(); appIconTicker = null; }
    const link = $('#favicon');
    if (state !== 'working') {
      link.href = APP_ICONS[state];
      return;
    }
    let frame = 0;
    link.href = APP_ICONS.working[0];
    const flip = () => { frame ^= 1; link.href = APP_ICONS.working[frame]; };
    // Edge slows a page's own timers to once a second or less when its window is minimized or
    // covered, which is when the taskbar matters. A worker's timers keep their pace.
    try {
      const w = new Worker('tick-worker.js');
      w.onmessage = flip;
      appIconTicker = { stop: () => w.terminate() };
    } catch {
      const t = setInterval(flip, 500);
      appIconTicker = { stop: () => clearInterval(t) };
    }
  }

  // ---- a terminal in the window --------------------------------------------------------------
  // Claude Code's own interface, drawn by xterm.js (public/vendor/xterm) from the screen the server
  // relays (src/terminals.js): keystrokes go up as they're typed, the screen comes down as an event
  // stream. One is shown at a time; selecting another session closes its stream, and coming back
  // draws the screen again from what the server kept.
  function terminalPane(it) {
    return h('div', { class: 'term-pane' },
      h('div', { class: 'term-box', 'aria-label': 'Terminal' }),
      h('div', { class: 'term-ended', hidden: it.state === 'running' }));
  }

  // The terminal's colors from the theme's own.
  function termTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    return { background: v('--bg'), foreground: v('--text'), cursor: v('--text'), cursorAccent: v('--bg'), selectionBackground: 'rgba(128, 128, 128, 0.35)' };
  }

  function mountTerminal(it) {
    unmountTerminal();
    const box = $('#focus-detail .term-box');
    if (!box || typeof Terminal !== 'function') return;
    const xterm = new Terminal({
      theme: termTheme(),
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      windowsPty: { backend: 'conpty' },
    });
    const fit = new FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open(box);
    const t = { id: it.id, xterm, fit, box, es: null, cols: it.cols, rows: it.rows, pending: '', pendingBinary: '', sending: false, fitTimer: null, observer: null };
    S.term = t;
    xterm.onData((d) => typeInto(t, d, false));
    xterm.onBinary((d) => typeInto(t, d, true));
    xterm.attachCustomKeyEventHandler((e) => termKeys(t, e));
    // An image on the clipboard: the paste has no text, so the keystroke itself goes to Claude
    // Code, which reads the image from the clipboard as it does in its terminal.
    box.addEventListener('paste', (e) => {
      const cd = e.clipboardData;
      if (!cd || cd.getData('text')) return;
      if ([...cd.items].some((i) => i.kind === 'file')) {
        e.preventDefault();
        e.stopPropagation();
        typeInto(t, '\x16', false);
      }
    }, true);
    const es = new EventSource(`/api/terminals/${encodeURIComponent(it.id)}/stream?t=${encodeURIComponent(Deck.token)}`);
    t.es = es;
    es.addEventListener('size', (e) => {
      const s = JSON.parse(e.data);
      t.cols = s.cols;
      t.rows = s.rows;
      xterm.resize(s.cols, s.rows);
    });
    es.addEventListener('reset', () => xterm.reset());
    es.addEventListener('data', (e) => xterm.write(Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0))));
    // Once the kept screen is in, fit the terminal to its box; conhost then draws it again at that size.
    es.addEventListener('open', () => setTimeout(() => fitTerminal(t), 120));
    t.observer = new ResizeObserver(() => {
      clearTimeout(t.fitTimer);
      t.fitTimer = setTimeout(() => fitTerminal(t), 80);
    });
    t.observer.observe(box);
    updateTerminal(it);
  }

  function fitTerminal(t) {
    if (S.term !== t || !t.box.isConnected || t.box.clientHeight < 40) return;
    t.fit.fit();
    const { cols, rows } = t.xterm;
    if (!cols || !rows || (cols === t.cols && rows === t.rows)) return;
    t.cols = cols;
    t.rows = rows;
    api('POST', `/api/terminals/${t.id}/resize`, { cols, rows }).catch(() => {});
  }

  // Keystrokes go in order, one request at a time; what's typed meanwhile goes with the next.
  // Windows' console input takes a paste at about 10 KB/s however it's fed (docs/CLAUDE-CODE-INTERNALS.md,
  // "Pasting is slow"), and nothing shows until all of it is in: a note says it's on its way.
  const PASTE_NOTE_FROM = 6000;
  const PASTE_BYTES_PER_S = 10000;
  function typeInto(t, data, binary) {
    if (binary) t.pendingBinary += data;
    else t.pending += data;
    if (!binary && data.length >= PASTE_NOTE_FROM) {
      const seconds = Math.ceil(data.length / PASTE_BYTES_PER_S);
      toast(`Pasting ${Math.round(data.length / 1024)} KB into Claude Code: about ${seconds} second${seconds === 1 ? '' : 's'}. Windows' console takes pasted text at about 10 KB a second.`, 'info', { ms: seconds * 1000 + 1500 });
    }
    pumpTerminal(t);
  }

  async function pumpTerminal(t) {
    if (t.sending) return;
    t.sending = true;
    try {
      while (t.pending || t.pendingBinary) {
        const text = t.pending;
        t.pending = '';
        if (text) await api('POST', `/api/terminals/${t.id}/input`, { data: text });
        const bytes = t.pendingBinary;
        t.pendingBinary = '';
        if (bytes) await api('POST', `/api/terminals/${t.id}/input`, { data: bytes, binary: true });
      }
    } catch (err) {
      t.pending = '';
      t.pendingBinary = '';
      if (S.term === t) toast(`Couldn't send to the terminal: ${err.message}`, 'error');
    } finally {
      t.sending = false;
    }
  }

  // The page's keys that a terminal here never takes: between sessions and views.
  function isDeckKey(e) {
    const key = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && !e.metaKey && key === 'tab') return true;
    if (e.altKey && !e.ctrlKey && ['1', '2', '3', '4'].includes(e.key)) return true;
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'n') return true;
    return e.key === 'F2' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  }

  // What the terminal does with a key: the page's keys pass it by (isDeckKey); Ctrl+Shift+C and
  // Ctrl+Shift+V copy and paste, as terminals have them (Ctrl+C and Ctrl+V are Claude Code's);
  // everything else is Claude Code's.
  function termKeys(t, e) {
    if (e.type !== 'keydown') return true;
    if (isDeckKey(e)) return false;
    const key = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'c') {
      e.preventDefault();
      const sel = t.xterm.getSelection();
      if (sel) copy(sel, 'Copied');
      return false;
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'v') {
      e.preventDefault();
      navigator.clipboard.readText().then((text) => { if (text) t.xterm.paste(text); }).catch(() => toast("Couldn't read the clipboard", 'error'));
      return false;
    }
    return true;
  }

  // Claude Code ended, or is running again: the note under the terminal, and whether keys go in.
  function updateTerminal(it) {
    const t = S.term;
    if (!t || t.id !== it.id) return;
    const running = it.state === 'running';
    t.xterm.options.disableStdin = !running;
    const note = $('#focus-detail .term-ended');
    if (!note) return;
    note.hidden = running;
    const sig = running ? '' : `${it.state}:${it.exitCode}:${it.launchError || ''}`;
    if (note.dataset.sig === sig) return;
    note.dataset.sig = sig;
    clear(note);
    if (running) return;
    note.appendChild(h('span', null, it.state === 'failed' ? it.launchError || "The terminal didn't start." : `Claude Code ended${it.exitCode ? ` with exit code ${it.exitCode}` : ''}.${it.userTurns ? '' : ' No prompt was sent, so there is no conversation to resume or keep in History.'}`));
    if (canResumeEmbedded(it)) note.appendChild(h('button', { class: 'primary small', onclick: () => resumeEmbedded(it) }, 'Resume'));
    note.appendChild(h('button', { class: 'ghost small', onclick: () => endSession(it) }, 'Remove'));
  }

  function unmountTerminal() {
    const t = S.term;
    if (!t) return;
    S.term = null;
    clearTimeout(t.fitTimer);
    if (t.observer) t.observer.disconnect();
    if (t.es) t.es.close();
    t.xterm.dispose();
  }

  // Empties the detail pane, closing the terminal shown in it, if any.
  function clearPane(pane) {
    unmountTerminal();
    return clear(pane);
  }

  function renderSessions() {
    renderSummary();
    renderFocus();
  }

  function select(key) {
    if (key !== S.selected) S.routeSet = key;
    S.selected = key;
    renderFocus();
    S.routeSet = null;
  }

  function showDetails(key) {
    S.selected = key;
    if (S.view !== 'sessions') setView('sessions');
    else renderSessions();
  }

  // ---- Chrome-style tab keys -----------------------------------------------------------------
  // Ctrl+Tab / Ctrl+Shift+Tab step through the sessions in list order, wrapping at the ends;
  // Ctrl+W ends the selected chat, and removes it once it has ended (then selects its neighbor).
  function focusSelected(it) {
    if (isChat(it)) {
      const ta = $('#focus-detail .composer-input');
      if (ta && !ta.disabled) { ta.focus(); return; }
    }
    if (isEmbedded(it) && S.term && S.term.id === it.id && it.state === 'running') { S.term.xterm.focus(); return; }
    const el = document.querySelector(`#focus-list [data-key="${CSS.escape(it.key)}"]`);
    if (el) el.focus();
  }

  function cycleSessions(delta) {
    const flat = visibleItems().flatMap((g) => g.items);
    if (!flat.length) return;
    const i = flat.findIndex((x) => x.key === S.selected);
    const next = i === -1 ? flat[delta > 0 ? 0 : flat.length - 1] : flat[(i + delta + flat.length) % flat.length];
    if (S.agentView) S.agentView = null;
    select(next.key);
    focusSelected(next);
  }

  async function closeSelectedChat() {
    const it = S.selected ? findItem(S.selected) : null;
    if (!it) return;
    if (!isChat(it) && !isEmbedded(it)) {
      toast('Ctrl+W ends sessions run here in Claude Deck. For this session, use End session.');
      return;
    }
    const flat = visibleItems().flatMap((g) => g.items);
    const i = flat.findIndex((x) => x.key === it.key);
    const neighbor = flat[i + 1] || flat[i - 1] || null;
    const wasEnded = it.state === 'exited' || it.state === 'failed';
    const done = await endSession(it, { quick: true });
    if (done && wasEnded && neighbor) {
      select(neighbor.key);
      focusSelected(neighbor);
    }
  }

  function moveSelection(delta) {
    const flat = visibleItems().flatMap((g) => g.items);
    if (!flat.length) return;
    let i = flat.findIndex((x) => x.key === S.selected);
    i = i === -1 ? 0 : Math.min(flat.length - 1, Math.max(0, i + delta));
    select(flat[i].key);
    const el = document.querySelector(`#focus-list [data-key="${CSS.escape(flat[i].key)}"]`);
    if (el) el.focus();
  }

  // ---- plan usage ----------------------------------------------------------------------------
  // The session and weekly limits from Claude Code's /usage, refreshed by the server.
  function usageLevel(l) {
    if (l.percent >= 100 || /critical|exceeded|over|blocked/.test(l.severity)) return 'over';
    if (l.severity === 'warning' || l.percent >= 80) return 'warn';
    return 'ok';
  }

  function resetText(ts) {
    if (!ts) return '';
    const mins = Math.round((ts - Date.now()) / 60000);
    if (mins <= 0) return 'resetting now';
    const inText = mins < 60 ? `${mins}m` : mins < 24 * 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
    return `resets in ${inText} (${when(ts)})`;
  }

  function usageBar(l, wide) {
    return h('span', { class: `ubar${wide ? ' wide' : ''} ${usageLevel(l)}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(l.percent), 'aria-label': `${l.long} ${l.percent}% used` },
      h('span', { class: 'ufill', style: { transform: `scaleX(${Math.min(100, Math.max(0, l.percent)) / 100})` } }));
  }

  function renderUsage() {
    const u = S.usage || { status: 'loading', limits: [] };
    const btn = $('#usage');
    const pop = $('#usage-pop');
    if (!btn) return;
    clear(btn);
    btn.classList.toggle('stale', u.status === 'stale');
    // The meter shows the session limit and the all-models weekly limit; the popover lists all.
    const shown = u.limits.filter((l) => l.kind === 'session' || l.kind === 'five_hour' || l.kind === 'weekly_all' || l.kind === 'seven_day');
    const list = shown.length ? shown : u.limits.slice(0, 2);
    if (!list.length) {
      btn.appendChild(h('span', { class: 'faint' }, u.status === 'loading' ? 'Checking usage…' : 'Plan usage'));
    } else {
      for (const l of list) btn.appendChild(h('span', { class: 'uitem', title: `${l.long}: ${l.percent}% used, ${resetText(l.resetsAt)}` }, h('span', { class: 'uname' }, l.name), usageBar(l), h('span', { class: `upct ${usageLevel(l)}` }, `${l.percent}%`)));
    }
    if (pop.hidden) return;
    clear(pop);
    pop.appendChild(h('div', { class: 'upop-head' }, h('strong', null, 'Plan usage'), h('span', { class: 'faint small' }, 'Same numbers as /usage in Claude Code')));
    for (const l of u.limits) {
      pop.appendChild(h('div', { class: 'urow' },
        h('div', { class: 'urow-top' }, h('span', null, l.long), h('span', { class: `upct ${usageLevel(l)}` }, `${l.percent}% used`)),
        usageBar(l, true),
        l.resetsAt ? h('div', { class: 'faint small' }, resetText(l.resetsAt)) : null));
    }
    if (u.message) pop.appendChild(h('p', { class: `small ${u.status === 'ok' ? 'faint' : 'muted'}`, style: { margin: '8px 0 0' } }, u.message));
    pop.appendChild(h('div', { class: 'upop-foot' },
      h('span', { class: 'faint small' }, u.fetchedAt ? `${u.status === 'stale' ? 'Last checked' : 'Checked'} ${when(u.fetchedAt)}` : ''),
      h('button', { type: 'button', class: 'ghost small', onclick: async () => { const s = await run("Couldn't check usage", () => api('POST', '/api/usage/refresh')); if (s) { S.usage = s; renderUsage(); } } }, 'Refresh')));
    // Which conversations used the most, in the Sessions detail pane; this closes the dropdown.
    pop.appendChild(h('button', {
      type: 'button',
      class: 'upop-week',
      'aria-pressed': String(S.view === 'sessions' && S.selected === USAGE_KEY),
      onclick: () => { pop.hidden = true; $('#usage').setAttribute('aria-expanded', 'false'); showDetails(USAGE_KEY); },
    }, Deck.icon('bars', { size: 13 }), 'Most tokens this week'));
  }

  function wireUsage() {
    const btn = $('#usage');
    const pop = $('#usage-pop');
    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
      renderUsage();
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { e.stopPropagation(); close(); btn.focus(); } }, true);
    renderUsage();
  }

  // ---- notifications -------------------------------------------------------------------------
  let audio = null;
  function chime(kind) {
    try {
      audio = audio || new AudioContext();
      const notes = kind === 'waiting' ? [660, 880] : [880, 660];
      notes.forEach((f, i) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.14);
        g.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + i * 0.14 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.14 + 0.25);
        o.connect(g).connect(audio.destination);
        o.start(audio.currentTime + i * 0.14);
        o.stop(audio.currentTime + i * 0.14 + 0.3);
      });
    } catch {
      // audio unavailable
    }
  }

  function onNotify(n) {
    const text = n.kind === 'waiting'
      ? `${n.label} needs you${n.detail ? `: ${n.detail}` : ''}`
      : n.kind === 'finished' ? `${n.label} is done and waiting for your next prompt` : `${n.label} ended`;
    const it = findItem(`d:${n.id}`) || { deck: true, id: n.id, kind: 'terminal' };
    const showing = S.view === 'sessions' && S.selected === `d:${n.id}` && document.hasFocus();
    if (!showing) toast(text, n.kind === 'waiting' ? 'waiting' : 'info', { label: isChat(it) ? 'Open chat' : 'Open terminal', run: () => openSession(it) });
    const wanted = n.kind === 'waiting' ? S.prefs.notifyOnWaiting : S.prefs.notifyOnFinished;
    if (!wanted) return;
    if (S.prefs.notifySound && !showing) chime(n.kind);
    if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
      const note = new Notification(text, { body: isChat(it) ? 'Click to open the chat.' : 'Click to open its terminal.', tag: `${n.id}:${n.kind}`, silent: true });
      note.onclick = () => { window.focus(); openSession(it); note.close(); };
    }
  }

  // ---- billing guard -------------------------------------------------------------------------
  // Claude Deck won't start sessions that would bill an Anthropic API or cloud account instead of
  // the Claude plan (src/billing.js), unless Allow API billing is on in Preferences. The banner
  // shows whenever something like that is set up, either way.
  async function loadBilling() {
    try { S.billing = await api('GET', '/api/billing'); } catch { return; }
    renderBillingBanner();
    // Only the status line in Preferences changes; rebuilding the whole view (this runs on every
    // window focus) would throw away anything being typed into its boxes.
    const status = $('#prefs-root .billing-status');
    if (status) status.textContent = billingStatusText();
  }

  function billingStatusText() {
    const b = S.billing;
    return !b ? 'Checking…' : b.findings.length ? `Found: ${b.findings.join('; ')}.` : 'Nothing found: sessions use your Claude plan.';
  }

  function renderBillingBanner() {
    const el = clear($('#billing-banner'));
    const b = S.billing;
    el.hidden = !b || !b.findings.length;
    if (el.hidden) return;
    el.appendChild(h('span', null,
      h('strong', null, b.allowed ? 'API billing is allowed. ' : "Sessions won't start. "),
      b.allowed
        ? 'Sessions started here may be charged to an Anthropic API or cloud account, on top of your Claude plan, because of: '
        : 'Claude Code would bill an Anthropic API or cloud account instead of your Claude plan, because of: ',
      b.findings.join('; '), '.'));
    el.appendChild(h('button', { class: 'ghost small', onclick: () => setView('prefs') }, 'Claude Deck Preferences'));
  }

  function billingRow(p) {
    const status = h('span', { class: 'billing-status' }, billingStatusText());
    const box = h('input', {
      type: 'checkbox',
      checked: p.allowApiBilling,
      onchange: async () => {
        if (box.checked) {
          const ok = await Deck.confirm({
            title: 'Allow sessions that bill an API account?',
            body: "With this on, Claude Deck starts sessions even when Claude Code is set up to bill an Anthropic API account or a cloud provider (an API key, a key helper, or Bedrock, Vertex and the like). Those sessions are charged per use, on top of your Claude plan. Only turn this on if you're authorized to incur those charges.",
            extra: S.billing && S.billing.findings.length ? h('p', { class: 'small' }, h('strong', null, 'Set up on this PC right now: '), S.billing.findings.join('; ')) : null,
            ok: 'Allow API billing',
            danger: true,
            safeDefault: true,
          });
          if (!ok) { box.checked = false; return; }
        }
        await savePrefs({ allowApiBilling: box.checked });
        loadBilling();
      },
    });
    return prefRow('API billing', status, h('label', { class: 'check' }, box, 'Allow sessions that bill an Anthropic API or cloud account instead of my Claude plan'));
  }

  function updateNotifBanner() {
    const want = S.prefs.notifyOnWaiting || S.prefs.notifyOnFinished;
    $('#notif-banner').hidden = !('Notification' in window) || Notification.permission !== 'default' || !want || store.get('notifDismissed', false);
  }

  // ---- folder picker -------------------------------------------------------------------------
  // In-app, so it always opens in front of the dashboard and only one can be open at a time.
  const FP = { current: '', entries: [], resolve: null, places: null };

  function pickFolder(start) {
    const dlg = $('#dlg-folder');
    if (dlg.open) return Promise.resolve(null);
    return new Promise((resolve) => {
      FP.resolve = resolve;
      $('#fp-error').hidden = true;
      $('#fp-new').hidden = true;
      dlg.showModal();
      loadPlaces();
      fpNavigate(start || store.get('lastCwd', S.prefs.defaultFolder), true);
    });
  }

  function fpFinish(value) {
    const resolve = FP.resolve;
    FP.resolve = null;
    if ($('#dlg-folder').open) $('#dlg-folder').close();
    if (resolve) resolve(value);
  }

  async function loadPlaces() {
    const host = clear($('#fp-places'));
    const [roots, folders] = await Promise.all([
      FP.places ? Promise.resolve(FP.places) : api('GET', '/api/dirs').catch(() => ({ entries: [], places: [] })),
      api('GET', '/api/folders').catch(() => S.folders),
    ]);
    FP.places = roots;
    S.folders = folders;
    const section = (title, items, label) => {
      if (!items.length) return;
      host.appendChild(h('h3', null, title));
      for (const it of items) host.appendChild(h('button', { type: 'button', class: 'fp-place', title: it.path, onclick: () => fpNavigate(it.path) }, label(it)));
    };
    section('Pinned', (folders.favorites || []).map((p) => ({ path: p })), (it) => shortPath(it.path));
    section('Recent', (folders.recent || []).slice(0, 6), (it) => shortPath(it.path));
    section('Places', roots.places || [], (it) => it.name);
    section('Drives', roots.entries || [], (it) => it.name);
  }

  async function fpNavigate(target, fallback) {
    $('#fp-error').hidden = true;
    try {
      const d = await api('GET', `/api/dirs?path=${encodeURIComponent(target || '')}`);
      FP.current = d.path;
      FP.parent = d.parent;
      FP.entries = d.entries;
      renderFolderList(d);
    } catch (err) {
      if (fallback) return fpNavigate('', false);
      $('#fp-error').textContent = err.message;
      $('#fp-error').hidden = false;
    }
  }

  function renderFolderList(d) {
    $('#fp-path').value = d.path;
    $('#fp-up').disabled = d.parent === null;
    $('#fp-choose').disabled = !d.path;
    $('#fp-mkdir').disabled = !d.path;
    const list = clear($('#fp-list'));
    if (!d.entries.length) list.appendChild(h('p', { class: 'fp-empty' }, d.path ? 'No folders inside this one. Choose it, or create a new folder.' : 'No drives found.'));
    for (const e of d.entries) {
      list.appendChild(h('button', {
        type: 'button',
        class: 'fp-item',
        role: 'option',
        title: e.path,
        onclick: () => fpNavigate(e.path),
      }, e.name));
    }
    if (d.truncated) list.appendChild(h('p', { class: 'fp-empty' }, 'Showing the first 3000 folders. Type the path to go further.'));
    list.scrollTop = 0;
  }

  async function fpCreate() {
    const name = $('#fp-new-name').value;
    const res = await api('POST', '/api/mkdir', { parent: FP.current, name }).catch((err) => {
      $('#fp-error').textContent = err.message;
      $('#fp-error').hidden = false;
      return null;
    });
    if (!res) return;
    $('#fp-new').hidden = true;
    $('#fp-new-name').value = '';
    fpNavigate(res.path);
  }

  function wireFolderPicker() {
    const dlg = $('#dlg-folder');
    dlg.addEventListener('close', () => fpFinish(null));
    $('#fp-cancel').addEventListener('click', () => fpFinish(null));
    $('#fp-choose').addEventListener('click', () => { if (FP.current) fpFinish(FP.current); });
    $('#fp-up').addEventListener('click', () => { if (FP.parent !== null) fpNavigate(FP.parent); });
    $('#fp-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); fpNavigate($('#fp-path').value.trim().replace(/^"|"$/g, '')); }
    });
    $('#fp-mkdir').addEventListener('click', () => { $('#fp-new').hidden = false; $('#fp-new-name').focus(); });
    $('#fp-new-cancel').addEventListener('click', () => { $('#fp-new').hidden = true; });
    $('#fp-new-ok').addEventListener('click', fpCreate);
    $('#fp-new-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); fpCreate(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('#fp-new').hidden = true; }
    });
    // Arrow keys move through the list; Backspace goes up a level.
    $('#fp-list').addEventListener('keydown', (e) => {
      const items = $$('#fp-list .fp-item');
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); items[Math.min(items.length - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); items[Math.max(0, i - 1)].focus(); }
      else if (e.key === 'Backspace' && FP.parent !== null) { e.preventDefault(); fpNavigate(FP.parent); }
    });
  }

  // ---- launcher ------------------------------------------------------------------------------
  const L = { color: 'slate', model: null };
  let previewTimer = null;

  // The Chat interface picked in New session: 'chat' (Claude Deck native) or 'cli' (Inlaid CLI).
  function launchWhere() {
    return $('input[name="l-where"]:checked').value;
  }

  function launchOptions() {
    const mode = $('input[name="l-mode"]:checked').value;
    return {
      mode,
      cwd: $('#l-cwd').value.trim(),
      name: $('#l-name').value.trim(),
      model: L.model ? L.model.getValue() : '',
      effort: $('#l-effort').value,
      permissionMode: $('#l-perm').value,
      color: L.color || 'slate',
      worktree: $('#l-worktree').checked ? ($('#l-worktree-name').value.trim() || true) : false,
      addDirs: $('#l-dirs').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      extraArgs: $('#l-extra').value.trim(),
      prompt: $('#l-prompt').value,
    };
  }

  function mountModelPicker(value) {
    L.model = Deck.modelPicker(S.boot.models, value || '', () => onLaunchChange(), 'From your settings');
    clear($('#l-model')).appendChild(L.model);
  }

  function applyLaunchOptions(o) {
    if (o.cwd) $('#l-cwd').value = o.cwd;
    $('#l-name').value = o.name || '';
    $$('input[name="l-mode"]').forEach((r) => { r.checked = r.value === (o.mode === 'continue' ? 'continue' : 'new'); });
    // Presets saved before 1.18.0 say 'terminal' (a Windows Terminal tab, no longer offered here):
    // the Inlaid CLI is the same interface, in the window.
    const where = o.where === 'terminal' ? 'cli' : o.where;
    if (where) $$('input[name="l-where"]').forEach((r) => { r.checked = r.value === where; });
    mountModelPicker(o.model);
    $('#l-effort').value = o.effort || '';
    $('#l-perm').value = o.permissionMode || '';
    L.color = o.color || 'slate';
    $('#l-worktree').checked = Boolean(o.worktree);
    $('#l-worktree-name').value = typeof o.worktree === 'string' ? o.worktree : '';
    $('#l-dirs').value = (o.addDirs || []).join('\n');
    $('#l-extra').value = o.extraArgs || '';
    renderSwatches();
    onLaunchChange();
  }

  function renderSwatches() {
    const host = clear($('#l-colors'));
    for (const [k, label] of Object.entries(COLOR_NAMES)) {
      host.appendChild(h('button', {
        type: 'button',
        class: 'swatch',
        role: 'radio',
        title: label,
        'aria-label': label,
        'aria-checked': String(L.color === k),
        style: { '--sw': `var(--c-${k})` },
        onclick: () => { L.color = k; renderSwatches(); },
      }));
    }
  }

  function isFavorite(p) {
    return S.prefs.favorites.some((f) => f.toLowerCase() === (p || '').toLowerCase());
  }

  function renderFolderChips() {
    const host = clear($('#l-folders'));
    const list = clear($('#l-cwd-list'));
    const favs = S.prefs.favorites.map((p) => ({ path: p, pinned: true }));
    const recent = S.folders.recent.filter((f) => !isFavorite(f.path)).slice(0, 8 - Math.min(favs.length, 6)).map((f) => ({ path: f.path, pinned: false }));
    for (const f of [...favs, ...recent]) {
      host.appendChild(h('button', {
        type: 'button',
        class: `chip${f.pinned ? ' pinned' : ''}`,
        title: f.path,
        onclick: () => { $('#l-cwd').value = f.path; onLaunchChange(); },
      }, f.pinned ? Deck.icon('star', { size: 12, filled: true }) : null, shortPath(f.path)));
    }
    for (const f of [...S.prefs.favorites, ...S.folders.recent.map((r) => r.path)]) list.appendChild(h('option', { value: f }));
  }

  function onLaunchChange() {
    const pinned = isFavorite($('#l-cwd').value.trim());
    clear($('#l-star')).appendChild(Deck.icon('star', { filled: pinned }));
    $('#l-star').setAttribute('aria-pressed', String(pinned));
    $('#l-worktree-name').disabled = !$('#l-worktree').checked;
    const native = launchWhere() === 'chat';
    $('#l-go').textContent = native ? 'Start chat' : 'Start CLI session';
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      try {
        const opts = launchOptions();
        // A native chat sends the first prompt as a message; the CLI puts it on the command line.
        const { command } = await api('POST', '/api/preview-command', native ? { ...opts, prompt: '' } : opts);
        $('#l-preview').textContent = native ? `${command}  (plus Claude Deck's streaming flags; the first prompt is sent as a message)` : command;
      } catch (err) {
        $('#l-preview').textContent = err.message;
      }
    }, 120);
  }

  async function openLaunch(prefill) {
    const dlg = $('#dlg-launch');
    $('#l-error').hidden = true;
    const folders = await run("Couldn't load recent folders", () => api('GET', '/api/folders'));
    if (folders) S.folders = folders;
    const presetSel = clear($('#l-preset'));
    presetSel.appendChild(h('option', { value: '' }, 'None'));
    S.prefs.presets.forEach((p, i) => presetSel.appendChild(h('option', { value: String(i) }, p.name)));
    // The chat interface starts on the one chosen in Claude Deck Preferences.
    applyLaunchOptions({ cwd: store.get('lastCwd', S.prefs.defaultFolder), color: 'slate', where: hereIsTerminal() ? 'cli' : 'chat', ...(prefill || {}) });
    $('#l-prompt').value = '';
    renderFolderChips();
    dlg.showModal();
    $('#l-cwd').focus();
    $('#l-cwd').select();
  }

  // Ctrl+Shift+N: a new chat straight away, with the defaults from Claude Deck Preferences (its
  // Default folder) and Claude Code's own settings for model, effort and permissions.
  let quickStarting = false;
  async function quickStart() {
    if (quickStarting) return; // held down, or pressed twice: one chat
    quickStarting = true;
    try {
      const res = await run("Couldn't start a session", () => api('POST', hereIsTerminal() ? '/api/terminals' : '/api/chats', { mode: 'new', cwd: S.prefs.defaultFolder, color: 'slate' }));
      if (!res) return;
      if (res.kind === 'embedded') openTerminal(res.id);
      else openChat(res.id);
    } finally {
      quickStarting = false;
    }
  }

  async function submitLaunch(e) {
    e.preventDefault();
    const btn = $('#l-go');
    if (btn.disabled) return; // already starting one
    btn.disabled = true;
    $('#l-error').hidden = true;
    try {
      const o = launchOptions();
      const cli = launchWhere() === 'cli';
      const res = await api('POST', cli ? '/api/terminals' : '/api/chats', o);
      store.set('lastCwd', o.cwd);
      $('#dlg-launch').close();
      if (cli) openTerminal(res.id);
      else openChat(res.id, !o.prompt.trim());
    } catch (err) {
      $('#l-error').textContent = err.message;
      $('#l-error').hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function savePrefs(patch, quiet) {
    const next = await run("Couldn't save preferences", () => api('PUT', '/api/prefs', patch));
    if (next) {
      S.prefs = next;
      applyTheme();
      updateNotifBanner();
      if (!quiet) toast('Preferences saved');
    }
    return next;
  }

  async function toggleFavorite(p) {
    if (!p) return;
    const favorites = isFavorite(p) ? S.prefs.favorites.filter((f) => f.toLowerCase() !== p.toLowerCase()) : [...S.prefs.favorites, p];
    await savePrefs({ favorites }, true);
  }

  function wireLaunch() {
    const form = $('#launch-form');
    form.addEventListener('submit', submitLaunch);
    form.addEventListener('input', onLaunchChange);
    form.addEventListener('change', onLaunchChange);
    // Ctrl+Enter submits the way the Start button does: the form checks its required fields first,
    // and a held or repeated press doesn't start a second session.
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.ctrlKey) return;
      e.preventDefault();
      if (!e.repeat) form.requestSubmit();
    });
    $('#l-cancel').addEventListener('click', () => $('#dlg-launch').close());
    $('#l-browse').addEventListener('click', async () => {
      const picked = await pickFolder($('#l-cwd').value.trim());
      if (picked) {
        $('#l-cwd').value = picked;
        onLaunchChange();
      }
    });
    $('#l-star').addEventListener('click', async () => {
      await toggleFavorite($('#l-cwd').value.trim());
      renderFolderChips();
      onLaunchChange();
    });
    $('#l-preset').addEventListener('change', (e) => {
      const p = S.prefs.presets[Number(e.target.value)];
      if (p) applyLaunchOptions({ ...p.options });
    });
    $('#l-save-preset').addEventListener('click', async () => {
      const name = await Deck.promptText({ title: 'Save as preset', label: 'Preset name', value: $('#l-name').value.trim() });
      if (!name || !name.trim()) return;
      const { prompt, ...options } = launchOptions();
      options.where = launchWhere();
      const presets = [...S.prefs.presets.filter((p) => p.name !== name.trim()), { name: name.trim(), options }];
      if (await savePrefs({ presets }, true)) toast(`Saved preset "${name.trim()}"`);
      const sel = clear($('#l-preset'));
      sel.appendChild(h('option', { value: '' }, 'None'));
      S.prefs.presets.forEach((p, i) => sel.appendChild(h('option', { value: String(i), selected: p.name === name.trim() }, p.name)));
    });
    const effort = $('#l-effort');
    for (const v of S.boot.enums.efforts) effort.appendChild(h('option', { value: v }, v));
    const perm = $('#l-perm');
    for (const v of S.boot.enums.permissionModes) perm.appendChild(h('option', { value: v }, v));
  }

  // ---- history -------------------------------------------------------------------------------
  async function loadHistory(refresh) {
    const data = await run("Couldn't load history", () => api('GET', `/api/history${refresh ? '?refresh=1' : ''}`));
    if (!data) return;
    S.history = { ...data, loaded: true };
    renderHistory();
  }

  // What the server sends back after a change in History (a move, a rename, a delete): the list,
  // the folders' names and which conversations are open.
  function takeHistory(res) {
    S.history = { ...S.history, sessions: res.sessions, live: res.live, folderNames: res.folderNames || {} };
  }

  // A conversation's folder in History: where it was started, or where it was dragged to
  // (m.folder, from src/history-folders.js). Folders are keyed case-insensitively, as Windows is.
  const folderKey = (m) => (m.folder || '').toLowerCase();
  // What a folder is called in History: the name given to it there, else the end of its path.
  const folderLabel = (p, parts = 2) => (p && (S.history.folderNames || {})[p.toLowerCase()]) || (p ? shortPath(p, parts) : 'No folder');

  function historyFiltered() {
    const q = $('#history-search').value.trim();
    const folder = $('#history-folder').value;
    const names = S.history.folderNames || {};
    const list = S.history.sessions.filter((m) => (!folder || folderKey(m) === folder)
      && matches([m.title, m.firstPrompt, m.lastPrompt, m.cwd, m.folder, names[folderKey(m)], m.sessionId, m.gitBranch, m.tag], q));
    const sort = $('#history-sort').value;
    if (sort === 'turns') list.sort((a, b) => b.userTurns - a.userTurns);
    else if (sort === 'cost') list.sort((a, b) => (b.costUSD || 0) - (a.costUSD || 0));
    return list;
  }

  function renderHistoryFolders() {
    const sel = $('#history-folder');
    const current = sel.value;
    const counts = new Map();
    for (const m of S.history.sessions) {
      if (!m.folder) continue;
      const k = folderKey(m);
      const c = counts.get(k) || { path: m.folder, n: 0 };
      c.n++;
      counts.set(k, c);
    }
    clear(sel);
    sel.appendChild(h('option', { value: '' }, 'All folders'));
    for (const [k, c] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n)) {
      sel.appendChild(h('option', { value: k, selected: k === current, title: c.path }, `${folderLabel(c.path)} (${c.n})`));
    }
  }

  function setHistoryView(view) {
    S.historyView = view === 'list' ? 'list' : 'folders';
    store.set('historyView', S.historyView);
    renderHistory();
  }

  function renderHistoryViewToggle() {
    for (const b of $$('#history-view button')) b.setAttribute('aria-pressed', String(b.dataset.view === S.historyView));
  }

  function toggleHistoryFolder(key) {
    if (S.historyOpen.has(key)) S.historyOpen.delete(key);
    else S.historyOpen.add(key);
    store.set('historyOpen', [...S.historyOpen]);
    renderHistory();
  }

  // One row of the list, in either view. In the folder view it can be dragged onto another folder.
  function historyRow(m, live, { grouped, draggable }) {
    const open = live.has(m.sessionId);
    const item = h('div', { class: `h-item${m.movedFrom ? ' moved' : ''}`, draggable: draggable ? 'true' : null },
      h('button', {
        class: 'h-row',
        role: 'option',
        'aria-selected': String(S.historySel === m.sessionId),
        dataset: { sid: m.sessionId },
        onclick: () => { S.historySel = m.sessionId; $$('#history-list .h-row').forEach((r) => r.setAttribute('aria-selected', String(r.dataset.sid === m.sessionId))); renderHistoryPreview(m); },
        ondblclick: () => resumeFromHistory(m, false, 'chat'),
      },
      h('span', { class: 'h-title' }, m.title || 'Untitled conversation'),
      h('span', { class: 'h-time', title: when(m.updatedAt) }, grouped ? when(m.updatedAt) : ago(m.updatedAt)),
      h('span', { class: 'h-sub' },
        open ? h('span', { class: 'live' }, 'Open now') : null,
        // In the folder view the folder is the heading; the row says where it was started only when that differs.
        draggable
          ? (m.movedFrom ? h('span', { class: 'h-moved', title: `Started in ${m.movedFrom}; moved here in Claude Deck` }, `from ${folderLabel(m.movedFrom, 1)}`) : null)
          : h('span', { class: 'path', title: m.cwd || '' }, shortPath(m.cwd)),
        h('span', null, `${m.userTurns} prompt${m.userTurns === 1 ? '' : 's'}`),
        m.costUSD ? h('span', null, money(m.costUSD)) : null)),
      m.movedFrom ? h('button', {
        type: 'button',
        class: 'ghost icon h-back',
        title: `Put back in the folder it was started in (${m.movedFrom})`,
        'aria-label': `Put ${m.title || 'this conversation'} back in ${m.movedFrom}`,
        onclick: () => moveConversation(m, null),
      }, Deck.icon('up', { size: 13 })) : null,
      h('button', {
        type: 'button',
        class: 'ghost icon h-del',
        disabled: open,
        title: open ? 'Open right now. End or close it first, then delete it.' : 'Delete this conversation',
        'aria-label': `Delete ${m.title || 'this conversation'}`,
        onclick: () => deleteConversation(m),
      }, trashIcon()));
    if (draggable) {
      item.addEventListener('dragstart', (e) => {
        S.historyDrag = { sessionId: m.sessionId, folderKey: folderKey(m) };
        e.dataTransfer.setData('text/plain', m.sessionId);
        e.dataTransfer.effectAllowed = 'move';
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => { S.historyDrag = null; item.classList.remove('dragging'); for (const f of $$('#history-list .drop-target')) f.classList.remove('drop-target'); });
    }
    return item;
  }

  // The folders of these conversations, most recently active first (or by the sort chosen).
  function historyFolderGroups(rows) {
    const groups = new Map();
    for (const m of rows) {
      const key = folderKey(m);
      let g = groups.get(key);
      if (!g) { g = { key, path: m.folder || '', rows: [], latest: 0, turns: 0, cost: 0 }; groups.set(key, g); }
      g.rows.push(m);
      g.latest = Math.max(g.latest, m.updatedAt || 0);
      g.turns += m.userTurns || 0;
      g.cost += m.costUSD || 0;
    }
    const sort = $('#history-sort').value;
    const by = sort === 'turns' ? (g) => g.turns : sort === 'cost' ? (g) => g.cost : (g) => g.latest;
    return [...groups.values()].sort((a, b) => by(b) - by(a));
  }

  const FOLDER_PAGE = 100;

  function historyFolderNode(g, live) {
    const open = S.historyOpen.has(g.key);
    const limit = S.historyFolderLimits[g.key] || FOLDER_PAGE;
    const named = Boolean(g.path && (S.history.folderNames || {})[g.key]);
    const head = h('button', {
      type: 'button',
      class: 'h-folder-head',
      'aria-expanded': String(open),
      title: g.path ? `${named ? `${folderLabel(g.path)}: ` : ''}${g.path}\nDrop a conversation here to move it into this folder. F2 renames it.` : 'Conversations with no folder recorded',
      onclick: () => toggleHistoryFolder(g.key),
      onkeydown: (e) => { if (e.key === 'F2' && g.path) { e.preventDefault(); renameHistoryFolder(g, head); } },
    },
    h('span', { class: 'h-chevron', 'aria-hidden': 'true' }, Deck.icon('right', { size: 12 })),
    // A name given in History reads as a name; a path stays in the path's own type.
    h('span', { class: `h-folder-name${named ? ' named' : ''}` }, h('bdi', null, folderLabel(g.path))),
    h('span', { class: 'h-folder-count', title: `${g.rows.length} conversation${g.rows.length === 1 ? '' : 's'}` }, String(g.rows.length)),
    h('span', { class: 'h-folder-time' }, g.latest ? ago(g.latest) : ''));
    const node = h('div', { class: `h-folder${open ? ' open' : ''}`, dataset: { folder: g.key } },
      h('div', { class: 'h-folder-top' },
        head,
        g.path ? h('button', {
          type: 'button',
          class: 'ghost icon h-folder-rename',
          title: 'Rename this folder in History (F2). The folder on disk keeps its name.',
          'aria-label': `Rename ${folderLabel(g.path)}`,
          onclick: () => renameHistoryFolder(g, head),
        }, Deck.icon('pen', { size: 13 })) : null),
      open ? h('div', { class: 'h-folder-body' },
        g.rows.slice(0, limit).map((m) => historyRow(m, live, { grouped: false, draggable: true })),
        g.rows.length > limit ? h('button', { class: 'ghost small h-more', onclick: () => { S.historyFolderLimits[g.key] = limit + FOLDER_PAGE; renderHistory(); } }, `Show ${Math.min(FOLDER_PAGE, g.rows.length - limit)} more`) : null) : null);
    // A conversation dragged from another folder can be dropped anywhere on this one.
    if (g.path) {
      const accepts = () => S.historyDrag && S.historyDrag.folderKey !== g.key;
      node.addEventListener('dragover', (e) => { if (!accepts()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; node.classList.add('drop-target'); });
      node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove('drop-target'); });
      node.addEventListener('drop', (e) => {
        if (!accepts()) return;
        e.preventDefault();
        node.classList.remove('drop-target');
        const m = S.history.sessions.find((x) => x.sessionId === S.historyDrag.sessionId);
        S.historyDrag = null;
        if (m) moveConversation(m, g.path);
      });
    }
    return node;
  }

  // Files a conversation under another folder (null: back where it was started), with Undo.
  async function moveConversation(m, folder) {
    const before = m.movedFrom ? m.folder : null;
    const res = await run("Couldn't move the conversation", () => api('PUT', `/api/history/${m.sessionId}/folder`, { folder }));
    if (!res) return;
    takeHistory(res);
    S.historySel = m.sessionId;
    S.historyReveal = m.sessionId;
    renderHistory();
    const now = S.history.sessions.find((x) => x.sessionId === m.sessionId) || m;
    toast(folder ? `Moved to ${folderLabel(folder)}` : `Put back in ${folderLabel(now.folder)}`, 'info', { label: 'Undo', ms: 8000, run: () => moveConversation(now, before) });
  }

  // Renames a folder where it sits in the list, as a session's name is: Enter saves, Esc puts it
  // back, and an empty name goes back to showing the folder's path. Only History's name for it.
  function renameHistoryFolder(g, head) {
    if (!head.isConnected) return;
    const current = (S.history.folderNames || {})[g.key] || '';
    const input = h('input', {
      type: 'text',
      class: 'h-folder-input',
      value: current || shortPath(g.path, 1),
      maxlength: '80',
      spellcheck: 'false',
      'aria-label': `Name for ${g.path} in History (leave empty to show its path)`,
      title: `${g.path}\nEnter saves, Esc cancels. Leave it empty to show the path again.`,
    });
    let done = false;
    const finish = async (keep) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      input.replaceWith(head);
      head.focus();
      if (!keep || name === current || (!current && name === shortPath(g.path, 1))) return;
      const res = await run("Couldn't rename the folder", () => api('PUT', '/api/history/folder-name', { folder: g.path, name }));
      if (!res) return;
      takeHistory(res);
      renderHistory();
      const again = $(`#history-list .h-folder[data-folder="${CSS.escape(g.key)}"] .h-folder-head`);
      if (again) again.focus();
      toast(name ? `Renamed to ${name} in History` : 'Showing the folder path again', 'info',
        { label: 'Undo', ms: 8000, run: async () => { const r = await run("Couldn't undo the rename", () => api('PUT', '/api/history/folder-name', { folder: g.path, name: current })); if (r) { takeHistory(r); renderHistory(); } } });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    // Clicks and drags inside the box are for editing, not for the folder.
    for (const ev of ['click', 'mousedown', 'dragstart']) input.addEventListener(ev, (e) => e.stopPropagation());
    head.replaceWith(input);
    input.focus();
    input.select();
  }

  function renderHistory() {
    renderHistoryFolders();
    renderHistoryViewToggle();
    const list = clear($('#history-list'));
    const rows = historyFiltered();
    const live = new Set(S.history.live);
    const total = S.history.sessions.length;
    $('#history-summary').textContent = rows.length === total ? `${total} conversations` : `${rows.length} of ${total} conversations`;
    if (!rows.length) {
      list.appendChild(h('p', { class: 'faint', style: { padding: '16px 8px' } }, total ? 'Nothing matches. Try fewer words, or pick All folders.' : 'No conversations found in your Claude folder yet.'));
      renderHistoryPreview(null);
      return;
    }
    // A conversation chosen elsewhere (the palette, usage, a move): its folder opens so it's in view.
    if (S.historyReveal) {
      const m = rows.find((x) => x.sessionId === S.historyReveal);
      if (m && !S.historyOpen.has(folderKey(m))) { S.historyOpen.add(folderKey(m)); store.set('historyOpen', [...S.historyOpen]); }
      S.historyReveal = null;
    }
    if (S.historyView === 'folders') {
      for (const g of historyFolderGroups(rows)) list.appendChild(historyFolderNode(g, live));
    } else {
      const grouped = $('#history-sort').value === 'recent';
      let lastGroup = null;
      for (const m of rows.slice(0, S.historyLimit)) {
        if (grouped) {
          const g = dayGroup(m.updatedAt);
          if (g !== lastGroup) {
            list.appendChild(h('div', { class: 'h-group' }, g));
            lastGroup = g;
          }
        }
        list.appendChild(historyRow(m, live, { grouped, draggable: false }));
      }
      if (rows.length > S.historyLimit) {
        list.appendChild(h('button', { class: 'ghost h-more', onclick: () => { S.historyLimit += 200; renderHistory(); } }, `Show ${Math.min(200, rows.length - S.historyLimit)} more`));
      }
    }
    const selected = rows.find((m) => m.sessionId === S.historySel) || rows[0];
    S.historySel = selected.sessionId;
    const selRow = list.querySelector(`[data-sid="${selected.sessionId}"]`);
    if (selRow) selRow.setAttribute('aria-selected', 'true');
    renderHistoryPreview(selected);
  }

  // ---- deleting conversations ----------------------------------------------------------------
  // The files go to Claude Deck's trash (src/trash.js), so there's no confirm step: Undo is in the toast.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function trashIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of [['viewBox', '0 0 20 20'], ['width', '15'], ['height', '15'], ['fill', 'currentColor'], ['aria-hidden', 'true']]) svg.setAttribute(k, v);
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('fill-rule', 'evenodd');
    p.setAttribute('clip-rule', 'evenodd');
    p.setAttribute('d', 'M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z');
    svg.appendChild(p);
    return svg;
  }

  async function deleteConversation(m) {
    // Keep the place in the list: select the next conversation if this one was selected.
    const rows = historyFiltered();
    const at = rows.findIndex((x) => x.sessionId === m.sessionId);
    const next = rows[at + 1] || rows[at - 1] || null;
    const res = await run("Couldn't delete the conversation", () => api('DELETE', `/api/history/${m.sessionId}`));
    if (!res) return;
    if (S.historySel === m.sessionId) S.historySel = next ? next.sessionId : null;
    takeHistory(res);
    renderHistory();
    const nextRow = next && $(`#history-list .h-row[data-sid="${next.sessionId}"]`);
    if (nextRow) nextRow.focus();
    const title = m.title || 'Untitled conversation';
    toast(`Deleted "${title.length > 60 ? `${title.slice(0, 60)}…` : title}"`, 'info', { label: 'Undo', ms: 10000, run: () => undoDelete(res.trashId) });
  }

  async function undoDelete(trashId) {
    const res = await run("Couldn't put the conversation back", () => api('POST', '/api/history/restore', { trashId }));
    if (!res) return;
    takeHistory(res);
    S.historySel = res.sessionId;
    S.historyReveal = res.sessionId;
    renderHistory();
    toast('Conversation restored');
  }

  let historyPreviewId = null;
  function renderHistoryPreview(m) {
    const pane = clear($('#history-preview'));
    historyPreviewId = m ? m.sessionId : null;
    if (!m) return;
    const live = S.history.live.includes(m.sessionId);
    const cmd = resumeCommand(m);
    const box = h('div', { class: 'convo' }, h('div', { class: 'convo-inner' }, h('p', { class: 'convo-note' }, 'Loading…')));
    const changes = h('div', { class: 'changes-panel', hidden: true });
    const changesBtn = h('button', { class: 'ghost small', 'aria-pressed': 'false', title: 'Files Claude changed in each turn, with diffs and restore' }, 'Changes');
    const showChanges = (on) => {
      changes.hidden = !on;
      box.hidden = on;
      changesBtn.setAttribute('aria-pressed', String(on));
      changesBtn.textContent = on ? 'Conversation' : 'Changes';
      clear(changes);
      if (on) changes.appendChild(changesView(m.sessionId, () => showChanges(false)));
    };
    changesBtn.addEventListener('click', () => showChanges(changes.hidden));
    pane.appendChild(h('div', { class: 'detail-head' },
      // The line plate: its lamp and name, then whether it's open right now, on one line.
      h('div', { class: 'head-title' },
        h('span', { class: `lamp ${live ? 'working' : 'ended'}` }),
        h('h2', null, m.title || 'Untitled conversation'),
        live ? h('span', { class: 'status-text working' }, 'Open right now') : null),
      m.firstPrompt && m.firstPrompt !== m.title ? h('div', { class: 'muted card-prompt' }, m.firstPrompt) : null,
      h('dl', { class: 'facts' },
        fact('Folder', m.cwd, true),
        // Moved in History's folder view; it still resumes from its own folder above.
        fact('Filed under', m.movedFrom ? m.folder : null, true),
        fact('Last active', when(m.updatedAt)),
        fact('Started', when(m.startedAt)),
        fact('Prompts', m.userTurns),
        fact('Est. cost', money(m.costUSD)),
        fact('Model', m.model),
        fact('Branch', m.gitBranch && m.gitBranch !== 'HEAD' ? m.gitBranch : null),
        fact('Session ID', m.sessionId, true)),
      h('div', { class: 'actions' },
        h('button', { class: 'primary small', onclick: () => resumeFromHistory(m, false, 'chat'), disabled: !m.cwd, title: 'Continue this conversation here in Claude Deck' }, 'Resume here'),
        h('button', { class: 'ghost small', onclick: () => resumeFromHistory(m, false, 'terminal'), disabled: !m.cwd }, 'Resume in terminal'),
        h('button', { class: 'ghost small', onclick: () => resumeFromHistory(m, true, 'chat'), disabled: !m.cwd, title: 'Continue from here as a new, separate conversation' }, 'Fork a copy'),
        changesBtn,
        h('button', { class: 'ghost small', onclick: () => openFolder(m.cwd), disabled: !m.cwd }, 'Open folder'),
        cmd ? h('button', { class: 'ghost small', onclick: () => copy(cmd, 'Resume command copied') }, 'Copy resume command') : null,
        h('button', { class: 'ghost small', onclick: () => copy(m.sessionId, 'Session ID copied') }, 'Copy session ID'),
        // The link comes from the transcript, so only a web address is made clickable.
        /^https:\/\//i.test(m.prUrl || '') ? h('a', { href: m.prUrl, target: '_blank', rel: 'noopener', class: 'small', style: { alignSelf: 'center' } }, 'Linked pull request') : null)));
    pane.appendChild(changes);
    pane.appendChild(box);
    api('GET', `/api/transcript/${m.sessionId}?limit=150`).then((data) => {
      if (historyPreviewId === m.sessionId) renderConversation(box, data.items);
    }).catch((err) => {
      if (historyPreviewId === m.sessionId) clear(box.querySelector('.convo-inner')).appendChild(h('p', { class: 'convo-note' }, `Couldn't load the conversation: ${err.message}`));
    });
  }

  async function resumeFromHistory(m, fork, target) {
    if (!fork && S.history.live.includes(m.sessionId)) {
      const ok = await Deck.confirm({
        title: 'This conversation is already open',
        body: 'Resuming it a second time makes the two copies drift apart. Fork a copy instead, so each has its own conversation. To move it here instead, select the session and use Continue here.',
        ok: 'Fork a copy',
      });
      if (!ok) return;
      fork = true;
    }
    const res = await run("Couldn't resume", () => api('POST', '/api/history/resume', { sessionId: m.sessionId, fork, target }));
    if (!res) return;
    if (target === 'terminal') toast(fork ? 'Forked into a new tab' : 'Resumed in a new tab');
    else if (res.kind === 'embedded') openTerminal(res.id);
    else openChat(res.id);
  }

  // ---- palette -------------------------------------------------------------------------------
  let paletteItems = [];
  let paletteIndex = 0;

  function paletteCommands() {
    return [
      { kind: 'Command', text: 'New session', run: () => openLaunch() },
      { kind: 'Command', text: 'Most tokens this week', run: () => showDetails(USAGE_KEY) },
      { kind: 'Command', text: 'Open history', run: () => setView('history') },
      { kind: 'Command', text: 'Edit Claude Code settings', run: () => setView('settings') },
      { kind: 'Command', text: 'Open preferences', run: () => setView('prefs') },
      { kind: 'Command', text: 'Show keyboard shortcuts', run: () => $('#dlg-keys').showModal() },
      { kind: 'Command', text: 'Take the guided tour', run: () => startTour() },
    ];
  }

  // The guided tour (public/tour.js), on the Sessions view. Seen once it's finished or skipped, so
  // first launch offers it only once; Preferences and Ctrl+K start it again.
  function startTour() {
    if (document.querySelector('dialog[open]')) return;
    setView('sessions');
    Deck.tour.start({ onDone: () => store.set('tourSeen', true) });
  }

  function renderPalette() {
    const q = $('#palette-input').value.trim();
    const out = [];
    for (const c of paletteCommands()) if (matches([c.text], q)) out.push(c);
    for (const it of allItems()) {
      if (!matches([heading(it), it.title, it.cwd, it.lastPrompt, it.lastReply], q)) continue;
      out.push({
        kind: isChat(it) ? 'Chat' : 'Session',
        text: heading(it),
        sub: statusLabel(it),
        run: () => { setView('sessions'); if (isChat(it)) openChat(it.id); else if (isTerminal(it) && it.state === 'running') { openSession(it); showDetails(it.key); } else showDetails(it.key); },
      });
    }
    if (q && S.history.loaded) {
      let n = 0;
      for (const m of S.history.sessions) {
        if (n >= 25) break;
        if (!matches([m.title, m.firstPrompt, m.lastPrompt, m.cwd, m.sessionId], q)) continue;
        n++;
        out.push({ kind: 'History', text: m.title || 'Untitled conversation', sub: `${shortPath(m.cwd)}  ${ago(m.updatedAt)}`, run: () => { setView('history'); S.historySel = m.sessionId; S.historyReveal = m.sessionId; renderHistory(); } });
      }
    }
    paletteItems = out.slice(0, 60);
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
    const host = clear($('#palette-results'));
    if (!paletteItems.length) host.appendChild(h('p', { class: 'faint', style: { padding: '10px 12px', margin: 0 } }, 'No matches.'));
    paletteItems.forEach((p, i) => {
      host.appendChild(h('button', {
        class: 'p-item',
        role: 'option',
        'aria-selected': String(i === paletteIndex),
        onclick: () => runPalette(i),
        onmousemove: () => { if (paletteIndex !== i) { paletteIndex = i; renderPalette(); } },
      }, h('span', { class: 'p-kind' }, p.kind), h('span', { class: 'p-text' }, p.text), p.sub ? h('span', { class: 'p-sub' }, p.sub) : null));
    });
    const sel = host.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function runPalette(i) {
    const p = paletteItems[i];
    $('#dlg-palette').close();
    if (p) p.run();
  }

  function openPalette() {
    if (!S.history.loaded) loadHistory(false).then(() => { if ($('#dlg-palette').open) renderPalette(); });
    $('#palette-input').value = '';
    paletteIndex = 0;
    renderPalette();
    $('#dlg-palette').showModal();
    $('#palette-input').focus();
  }

  function wirePalette() {
    $('#palette-input').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
    $('#palette-input').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1); renderPalette(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = Math.max(0, paletteIndex - 1); renderPalette(); }
      else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteIndex); }
    });
    $('#dlg-palette').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('#btn-palette').addEventListener('click', openPalette);
  }

  // ---- preferences view ----------------------------------------------------------------------
  function prefRow(label, hint, ...controls) {
    return h('div', { class: 'pref-row' }, h('div', { class: 'pl' }, label, hint ? h('small', null, hint) : null), h('div', { class: 'pc' }, controls));
  }

  // A font picker with a line set in the chosen font. Fonts this PC doesn't have are listed but
  // can't be picked.
  function fontRow(key, label, hint, sample) {
    const preview = h('span', { class: `font-preview${key === 'fontLabels' ? ' plate-text' : ''}` }, sample);
    const show = (id) => { const c = FONT_CHOICES[id]; preview.style.fontFamily = c && c.stack ? c.stack : ''; };
    const sel = h('select', { 'aria-label': label, onchange: (e) => { show(e.target.value); savePrefs({ [key]: e.target.value }); } },
      Object.entries(FONT_CHOICES).map(([id, c]) => {
        const have = fontInstalled(c.face);
        return h('option', { value: id, selected: S.prefs[key] === id, disabled: !have && S.prefs[key] !== id },
          id === 'default' ? `Default (${FONT_DEFAULTS[key]})` : have ? c.label : `${c.label} (not on this PC)`);
      }));
    show(S.prefs[key]);
    return prefRow(label, hint, h('div', { class: 'font-pick' }, sel, preview));
  }

  function toggle(key, label) {
    return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.prefs[key], onchange: (e) => savePrefs({ [key]: e.target.checked }) }), label);
  }

  // Installing as an Edge app gives Claude Deck its own taskbar icon and pin.
  function appSection() {
    const section = h('section', { class: 'pref-section' },
      h('h2', null, 'Taskbar app'),
      h('p', null, 'Install Claude Deck as an app to give it its own icon, so you can pin it to the taskbar and its window stays under that pin instead of Edge.'));
    const body = h('div', null, h('small', { class: 'faint' }, 'Checking…'));
    section.appendChild(body);
    api('GET', '/api/app').then((info) => {
      clear(body);
      const standalone = window.matchMedia('(display-mode: standalone)').matches;
      let installRow;
      if (info.installed || standalone) {
        installRow = prefRow('App', 'Installed',
          h('small', null, 'Open Claude Deck from the Start menu or the taskbar. To pin it: right-click its taskbar icon, then choose Pin to taskbar.'));
      } else if (S.installPrompt) {
        installRow = prefRow('App', 'Not installed yet',
          h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => { const ev = S.installPrompt; S.installPrompt = null; await ev.prompt(); renderPrefs(); } }, 'Install Claude Deck')),
          h('small', { class: 'faint' }, 'Edge asks to confirm. Tick "Pin to taskbar" in that window if it offers it.'));
      } else {
        installRow = prefRow('App', 'Not installed yet',
          h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => run("Couldn't open Edge", () => api('POST', '/api/app/open-in-browser')) }, 'Open in Edge to install')),
          h('small', { class: 'faint' }, 'In that Edge tab, select the install icon at the right end of the address bar (or open the … menu, then Apps, then Install Claude Deck). After that, Claude Deck always opens as its own app.'));
      }
      const startup = h('input', { type: 'checkbox', checked: info.startup });
      startup.addEventListener('change', async () => {
        startup.disabled = true;
        const res = await run("Couldn't change the startup setting", () => api('POST', '/api/app/startup', { enabled: startup.checked }));
        startup.disabled = false;
        if (res) { startup.checked = res.startup; toast(res.startup ? 'Claude Deck will start when you sign in' : 'Claude Deck won\'t start on sign-in anymore'); } else startup.checked = !startup.checked;
      });
      body.appendChild(installRow);
      body.appendChild(prefRow('Start with Windows', 'A scheduled task keeps the server running in the background while you are signed in, and restarts it if it crashes',
        h('label', { class: 'check' }, startup, 'Start the Claude Deck server when I sign in'),
        h('small', { class: 'faint' }, 'Stop server now (under Dashboard) still stops it until you next sign in or start Claude Deck yourself.'),
        info.taskLowPriority ? h('div', { class: 'row' },
          h('small', null, PRIORITY_TASK_TEXT),
          h('button', { class: 'ghost', style: { flex: 'none' }, onclick: (e) => { e.currentTarget.disabled = true; updateTaskPriority(); } }, 'Update the task'))
          : info.serverLowPriority && info.resident ? h('small', null, PRIORITY_SIGN_OUT_TEXT) : null));
    }).catch((err) => { clear(body).appendChild(h('small', { class: 'faint' }, `Couldn't check the app status: ${err.message}`)); });
    return section;
  }

  // The version Claude Code reports ("2.1.308 (Claude Code)"), as just the number.
  const versionNumber = (v) => (String(v || '').match(/\d+\.\d+\.\d+/) || [''])[0];

  function claudeUpdateHint(c) {
    const a = c.autoUpdate;
    if (!a) return '';
    if (!a.enabled) return `Automatic updates are off (${a.blockedBy} is set). New models, such as a new Sonnet, show up once Claude Code is updated.`;
    const newer = c.updateAvailable ? `Claude Code ${c.latest.version} is out; this PC has ${versionNumber(c.version)}. ` : '';
    return `${newer}Claude Code updates itself only from its own terminal interface (the Inlaid CLI or a Windows Terminal tab), and only when no session is using it; native chats don't update it. Claude Deck looks for a newer version${a.channel === 'stable' ? ' on the stable channel' : ''} and offers it. New models show up in the model menus once it's updated.`;
  }

  // Claude Code's own `claude update`. Open chats keep the version they started with until resumed.
  // btn: the Preferences button, if that's where it was asked from.
  async function updateClaude(btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking…';
    } else {
      toast('Updating Claude Code…');
    }
    try {
      const res = await run("Couldn't update Claude Code", () => api('POST', '/api/claude/update'));
      if (!res) return;
      S.boot.claude = res.claude;
      const changed = res.claude.version !== res.before;
      if (res.locked) toast("Claude Code couldn't replace its program while sessions are using it. End your open chats and CLI sessions (or Restart server in Claude Deck Preferences), then update again.", 'error', { ms: 15000 });
      // npm, which Claude Code asks for the newest version, was too slow three times: nothing to do
      // with signing in, whatever Claude Code's own last line suggests (src/claude-locate.js).
      else if (res.npmLookup) toast("Claude Code couldn't get the newest version number from npm in time, after three tries, so it didn't update. Your Claude sign-in isn't the problem. Try again in a few minutes, or run claude update in PowerShell. Claude Code's full output is in Claude Deck's log (Preferences → Data folder → logs).", 'error', { ms: 20000 });
      else if (!res.ok) toast(`Claude Code couldn't update: ${res.reason}. Claude Code's full output is in Claude Deck's log (Preferences → Data folder → logs).`, 'error', { ms: 15000 });
      else if (changed) toast(`Claude Code updated to ${versionNumber(res.claude.version)}. Resume open chats to use it.`);
      // npm has a newer one than Claude Code installed: Anthropic releases each version gradually.
      else if (res.claude.updateAvailable) toast(`Claude Code says ${versionNumber(res.claude.version)} is the newest for this PC for now. Anthropic releases new versions gradually, so ${res.claude.latest.version} should arrive soon.`);
      else toast(`Claude Code is up to date (${versionNumber(res.claude.version) || 'unknown version'})`);
      if (changed) S.boot.models = await api('GET', '/api/models');
      if (S.view === 'prefs') renderPrefs();
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Update Claude Code now'; }
    }
  }

  // A sign-in task from an earlier Claude Deck runs the server, and so every chat and MCP server,
  // at Windows' background priority (low CPU, disk and memory priority), and MCP servers then
  // often miss Claude Code's 30-second start limit (src/app-install.js taskPriority). Registering
  // the task again fixes it from the next sign-in; the server running now keeps its priority.
  const PRIORITY_TASK_TEXT = 'The sign-in task was set up by an earlier Claude Deck and runs chats at low priority, so MCP servers often time out while starting. Update it, then sign out and back in.';
  const PRIORITY_SIGN_OUT_TEXT = 'The sign-in task is up to date, but this server started before it was, so chats still run at low priority. Sign out of Windows and back in (Restart server keeps the low priority).';
  async function updateTaskPriority() {
    const res = await run("Couldn't update the sign-in task", () => api('POST', '/api/app/startup', { enabled: true }));
    if (res) toast('Sign-in task updated. Sign out of Windows and back in (or restart the PC) for it to take effect: Restart server keeps the low priority.', 'info', { ms: 20000 });
    if (S.view === 'prefs') renderPrefs();
  }

  // At startup: ask to fix a low-priority sign-in task, or, once fixed, say a sign-in is still
  // needed. Once per window (Cancel waits for the next), after the tour and any open dialog,
  // like offerClaudeUpdate.
  async function offerPriorityFix() {
    const key = 'deck-priority-offered';
    try { if (sessionStorage.getItem(key)) return; } catch { /* storage unavailable */ }
    let info;
    try { info = await api('GET', '/api/app'); } catch { return; }
    if (!info.taskLowPriority && !(info.serverLowPriority && info.resident)) return;
    while (document.querySelector('.tour, dialog[open]')) await new Promise((r) => setTimeout(r, 1000));
    try { sessionStorage.setItem(key, '1'); } catch { /* storage unavailable */ }
    if (!info.taskLowPriority) return toast(PRIORITY_SIGN_OUT_TEXT, 'info', { ms: 20000 });
    const ok = await Deck.confirm({
      title: 'Run chats at normal priority?',
      body: `${PRIORITY_TASK_TEXT} Updating changes only the task's priority, to the one programs you open yourself get.`,
      ok: 'Update the task',
    });
    if (ok) updateTaskPriority();
  }

  // A newer Claude Code is out (src/server.js checkLatestClaude): offer it once per version and
  // window, after the tour and any open dialog. Native chats never update Claude Code themselves.
  // It counts as offered once it's on screen, so a reload during the tour doesn't lose it.
  let claudeOfferWaiting = false;
  async function offerClaudeUpdate() {
    const key = 'deck-claude-update-offered';
    const due = () => {
      const c = S.boot && S.boot.claude;
      if (!c || !c.updateAvailable) return null;
      try { if (sessionStorage.getItem(key) === c.latest.version) return null; } catch { /* storage unavailable */ }
      return c;
    };
    if (claudeOfferWaiting || !due()) return;
    claudeOfferWaiting = true;
    try {
      while (document.querySelector('.tour, dialog[open]')) await new Promise((r) => setTimeout(r, 1000));
      const c = due(); // still newer, after the wait?
      if (!c) return;
      try { sessionStorage.setItem(key, c.latest.version); } catch { /* storage unavailable */ }
      toast(`Claude Code ${c.latest.version} is out (this PC has ${versionNumber(c.version)}). Native chats don't update Claude Code on their own.`, 'info', { label: 'Update now', ms: 20000, run: () => updateClaude() });
    } finally {
      claudeOfferWaiting = false;
    }
  }

  function renderPrefs() {
    const root = clear($('#prefs-root'));
    const p = S.prefs;
    const claude = S.boot.claude || {};
    root.appendChild(appSection());

    const pathInput = h('input', { type: 'text', value: p.claudePath, placeholder: claude.path || 'Not found', spellcheck: 'false' });
    const detected = h('small', { class: 'faint' }, claude.path ? `Using ${claude.version || 'unknown version'} from ${claude.source}` : 'Claude Code was not found on PATH.');
    root.appendChild(h('section', { class: 'pref-section' },
      h('h2', null, 'Claude Code'),
      prefRow('Program', 'Leave empty to find it automatically',
        h('div', { class: 'row' }, pathInput,
          h('button', { class: 'ghost', onclick: async () => { await savePrefs({ claudePath: pathInput.value.trim() }, true); const info = await run("Couldn't check Claude Code", () => api('POST', '/api/claude/detect')); if (info) { S.boot.claude = info; renderPrefs(); toast(info.path ? `Found ${info.version || 'Claude Code'}` : 'Claude Code was not found', info.path ? 'info' : 'error'); } } }, 'Save and check')),
        detected),
      claude.path ? prefRow('Updates', claudeUpdateHint(claude),
        h('div', { class: 'row' },
          h('button', { class: 'ghost', title: "Runs Claude Code's own claude update", onclick: (e) => updateClaude(e.currentTarget) }, 'Update Claude Code now'))) : null));

    const nameInput = h('input', { type: 'text', value: p.windowName });
    const profileInput = h('input', { type: 'text', value: p.wtProfile, placeholder: 'Your default profile' });
    root.appendChild(h('section', { class: 'pref-section' },
      h('h2', null, 'Windows Terminal'),
      h('p', null, 'Used for sessions you choose to run in a terminal. Open terminal, beside a terminal session\'s title, switches to its tab.'),
      prefRow('Windows', null,
        h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'p-wm', checked: p.windowMode === 'single', onchange: () => savePrefs({ windowMode: 'single' }) }), 'One window, a tab per session'),
        h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'p-wm', checked: p.windowMode === 'perSession', onchange: () => savePrefs({ windowMode: 'perSession' }) }), 'A separate window per session'),
        h('small', { class: 'faint' }, 'With one window, keep the tabs in the order Claude Deck opened them. Dragging tabs around, or opening other tabs in that window, makes Open terminal land on the wrong tab.')),
      prefRow('Window name', 'Only used for the shared window', h('div', { class: 'row' }, nameInput, h('button', { class: 'ghost', onclick: () => savePrefs({ windowName: nameInput.value.trim() }) }, 'Save'))),
      prefRow('Terminal profile', 'Font, colors and so on come from this profile', h('div', { class: 'row' }, profileInput, h('button', { class: 'ghost', onclick: () => savePrefs({ wtProfile: profileInput.value.trim() }) }, 'Save')))));

    const folderInput = h('input', { type: 'text', value: p.defaultFolder, spellcheck: 'false' });
    // A newly chosen default is where New session opens next: the folder it remembers from the last
    // session started (lastCwd, which otherwise comes first) is forgotten.
    const saveDefaultFolder = async (folder) => {
      if (await savePrefs({ defaultFolder: folder })) {
        try { localStorage.removeItem('deck-lastCwd'); } catch { /* storage unavailable */ }
      }
    };
    const favList = h('div', { class: 'pc' }, p.favorites.length ? p.favorites.map((f) => h('div', { class: 'fav' }, h('span', null, f), h('button', { class: 'ghost small', onclick: async () => { await toggleFavorite(f); renderPrefs(); } }, 'Unpin'))) : h('small', { class: 'faint' }, 'Pin folders with the star in the New session window.'));
    const presetList = h('div', { class: 'pc' }, p.presets.length ? p.presets.map((pr) => h('div', { class: 'fav' }, h('span', null, pr.name), h('button', { class: 'ghost small', onclick: async () => { await savePrefs({ presets: S.prefs.presets.filter((x) => x.name !== pr.name) }, true); renderPrefs(); } }, 'Delete'))) : h('small', { class: 'faint' }, 'Save a preset from the New session window.'));
    root.appendChild(h('section', { class: 'pref-section' },
      h('h2', null, 'New sessions'),
      prefRow('Chat interface', 'The one New session starts on, and the one Ctrl+Shift+N, Resume here and Continue here use',
        h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'p-here', checked: p.runHereAs === 'chat', onchange: () => savePrefs({ runHereAs: 'chat' }) }), "Claude Deck native: the dashboard's own reply box, cards for permission prompts and questions, meters, the subagents panel"),
        h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'p-here', checked: p.runHereAs === 'terminal', onchange: () => savePrefs({ runHereAs: 'terminal' }) }), "Inlaid CLI: Claude Code's own interface in the window, with every command, dialog and key as in Claude Code"),
        h('small', { class: 'faint' }, 'Sessions already running stay as they are. Either kind can continue as the other from its session menu.')),
      prefRow('Default folder', 'Where Ctrl+Shift+N starts a session. New session starts here too, until you start a session somewhere else',
        h('div', { class: 'row' }, folderInput,
          // A folder chosen with Browse is saved straight away, like the other choices in Preferences.
          h('button', { class: 'ghost', onclick: async () => { const picked = await pickFolder(folderInput.value); if (picked) { folderInput.value = picked; await saveDefaultFolder(picked); } } }, 'Browse…'),
          h('button', { class: 'ghost', onclick: () => saveDefaultFolder(folderInput.value.trim()) }, 'Save'))),
      prefRow('Pinned folders', null, favList),
      prefRow('Presets', null, presetList)));

    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    root.appendChild(h('section', { class: 'pref-section' },
      h('h2', null, 'Notifications'),
      h('p', null, 'Desktop notifications appear when this window is in the background. Keep the Claude Deck window open, even minimized, to get them.'),
      prefRow('Notify me when', null, toggle('notifyOnWaiting', 'A session needs me (permission prompts, questions)'), toggle('notifyOnFinished', 'A session finishes a task or ends')),
      prefRow('Sound', null, toggle('notifySound', 'Play a short chime')),
      prefRow('Desktop notifications', perm === 'granted' ? 'Allowed' : perm === 'denied' ? 'Blocked in the browser. Allow them in the site settings for this window.' : perm === 'unsupported' ? 'Not supported here' : 'Not turned on yet',
        h('div', { class: 'row' },
          perm === 'default' ? h('button', { class: 'ghost', onclick: async () => { await Notification.requestPermission(); renderPrefs(); updateNotifBanner(); } }, 'Turn on') : null,
          h('button', { class: 'ghost', onclick: () => { if (perm === 'granted') new Notification('Claude Deck notifications work', { body: 'You will see these when a session needs you.' }); if (S.prefs.notifySound) chime('waiting'); toast(perm === 'granted' ? 'Test notification sent' : 'Desktop notifications are not allowed yet', perm === 'granted' ? 'info' : 'error'); } }, 'Send a test')))));

    root.appendChild(h('section', { class: 'pref-section' },
      h('h2', null, 'Appearance'),
      prefRow('Theme', null, h('select', { 'aria-label': 'Theme', onchange: (e) => savePrefs({ theme: e.target.value }) },
        THEME_GROUPS.map(([group, themes]) => h('optgroup', { label: group },
          themes.map(([v, t]) => h('option', { value: v, selected: p.theme === v }, t)))))),
      fontRow('fontText', 'Text font', 'Messages, lists and controls', 'Claude finished the release notes and is waiting for your next prompt.'),
      fontRow('fontLabels', 'Label font', 'The engraved capitals on plates and labels', 'Needs you · Model · Current cost'),
      prefRow('Tool calls', null, toggle('showToolIcons', 'Show an icon beside each tool call in a chat')),
      prefRow('/clear', 'Claude starts a new conversation either way; ↑ still recalls your earlier messages', toggle('clearChatOnClear', "Clear the chat's messages too, as Claude Code clears its screen"))));

    root.appendChild(h('section', { class: 'pref-section' },
      h('h2', null, 'Billing'),
      h('p', null, 'Claude Deck only starts sessions that use your Claude plan. It checks for anything that would make Claude Code bill an Anthropic API account or a cloud provider instead, and refuses to start sessions if it finds one.'),
      billingRow(p)));

    root.appendChild(h('section', { class: 'pref-section' },
      h('h2', null, 'Dashboard'),
      prefRow('Other terminals', null, toggle('showExternal', 'Show Claude sessions started outside Claude Deck')),
      prefRow('Background server', 'Chats run inside the server; terminal sessions keep running either way', toggle('stopWhenClosed', 'Stop the local server 90 seconds after this window closes, unless a chat is still running'),
        h('div', { class: 'row' },
          h('button', { class: 'ghost', title: 'Get the latest Claude Deck from GitHub, then restart on it', onclick: (e) => checkForUpdates(e.currentTarget) }, 'Check for updates'),
          h('button', { class: 'ghost', title: 'Stop the server and start it again, then reload this window: picks up changes to Claude Deck', onclick: restartServer }, 'Restart server'),
          h('button', { class: 'danger', onclick: async () => { if (await Deck.confirm({ title: 'Stop the Claude Deck server?', body: 'Chats end (resume them from History later). Terminal sessions keep running. Start Claude Deck again to reconnect.', ok: 'Stop server', danger: true })) api('POST', '/api/shutdown').catch(() => {}); } }, 'Stop server now'))),
      prefRow('Data folder', 'Preferences, settings backups, the history cache, and Claude Deck\'s log (logs\\claude-deck.log) for working out what went wrong', h('div', { class: 'row' }, h('code', { style: { overflowWrap: 'anywhere', flex: '1' } }, S.boot.dataDir), h('button', { class: 'ghost', onclick: () => openFolder(S.boot.dataDir) }, 'Open'))),
      prefRow('Version', 'The version the server was started from', h('div', { class: 'row' }, h('span', null, `Claude Deck ${S.boot.version}`), h('a', { href: 'https://github.com/BPT-CIPP/Claude-Deck/releases', target: '_blank', rel: 'noopener', class: 'small' }, 'Release notes'))),
      prefRow('Guided tour', 'A two-minute walk through Claude Deck, for anyone new to it or to Claude Code', h('div', { class: 'row' }, h('button', { class: 'ghost', onclick: startTour }, 'Take the tour')))));
  }

  // Restart the server (a new copy takes over on the same port), then reload this window once the
  // new server answers, so changes to both the server and the page take effect.
  async function restartServer() {
    const ok = await Deck.confirm({
      title: 'Restart the Claude Deck server?',
      body: 'It stops and starts again right away, and this window reloads. Chats end, including one working on Claude Deck itself; resume them afterwards. Terminal sessions keep running.',
      ok: 'Restart server',
    });
    if (!ok) return;
    const res = await run("Couldn't restart the server", () => api('POST', '/api/restart'));
    if (!res) return;
    toast('Restarting the server…');
    reloadWhenRestarted(res.pid);
  }

  // Once a server other than `oldPid` answers, reload the window onto it.
  async function reloadWhenRestarted(oldPid) {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const now = await api('GET', '/api/ping').catch(() => null);
      if (now && now.pid !== oldPid) { location.reload(); return; }
    }
    toast("The server didn't come back. Start Claude Deck again from its shortcut.", 'error');
  }

  // Updating needs a program this PC doesn't have (src/update.js err.prerequisite): say so and offer
  // to install it with winget. Then checks again (retry), or, for the GitHub CLI, says to sign in.
  const PREREQUISITES = {
    git: { title: 'Install Git?', body: "Claude Deck updates itself from GitHub with Git, and Git isn't installed on this PC." },
    gh: { title: 'Install the GitHub CLI?', body: "GitHub asked for a sign-in before it would hand over Claude Deck (the repository isn't public to you). Claude Deck signs in through the GitHub CLI, which isn't installed on this PC." },
  };
  async function offerPrerequisite(err, retry) {
    const p = PREREQUISITES[err.prerequisite];
    if (!p) return;
    const ok = await Deck.confirm({ title: p.title, body: `${p.body} Install it now? It comes from winget, Windows' own package manager, and Windows may ask for permission.`, ok: 'Install' });
    if (!ok) return;
    toast(`Installing ${err.prerequisite === 'git' ? 'Git' : 'the GitHub CLI'}… this can take a few minutes.`);
    const res = await run("Couldn't install it", () => api('POST', '/api/update/install', { tool: err.prerequisite }));
    if (!res) return;
    if (err.prerequisite === 'gh') {
      toast('The GitHub CLI is installed. Sign in by running gh auth login in PowerShell, then check for updates again.', 'info', { label: 'Copy command', ms: 30000, run: () => copy('gh auth login', 'Command copied') });
      return;
    }
    toast(`${res.label} is installed.`);
    if (retry) retry();
  }

  // Checks GitHub for a newer Claude Deck (src/update.js); if there is one, asks, then updates this
  // copy and restarts on it.
  async function checkForUpdates(btn) {
    // When this copy can't be updated from here, the message includes the command to do it by
    // hand, and the toast stays up with a button to copy it. A missing program is offered instead.
    const ask = (apply) => api('POST', '/api/update', { apply }).catch((err) => {
      if (err.prerequisite) offerPrerequisite(err, () => checkForUpdates(btn));
      else {
        toast(`Couldn't ${apply ? 'update Claude Deck' : 'check for updates'}: ${err.message}`, 'error',
          err.command ? { label: 'Copy command', ms: 30000, run: () => copy(err.command, 'Command copied') } : undefined);
      }
      return null;
    });
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const check = await ask(false);
    btn.disabled = false;
    btn.textContent = 'Check for updates';
    if (!check) return;
    if (!check.available) { toast(`Claude Deck is up to date (${check.from ? `v${check.from}` : 'latest version'}).`); return; }
    const ok = await Deck.confirm({
      title: check.to && check.to !== check.from ? `Update to v${check.to}?` : 'Update Claude Deck?',
      body: `${check.from ? `This is v${check.from}. ` : ''}Claude Deck gets the latest version from GitHub, then restarts and this window reloads. Chats end, including one working on Claude Deck itself; resume them afterwards. Terminal sessions keep running.`,
      ok: 'Update and restart',
    });
    if (!ok) return;
    const res = await ask(true);
    if (!res) return;
    if (!res.updated) { toast('Claude Deck is already up to date.'); return; }
    toast(`Updated to v${res.to}. Restarting…`);
    reloadWhenRestarted(res.pid);
  }

  // At launch: when GitHub has a newer Claude Deck for this copy (a git clone on main), offer it.
  // A program the update needs and this PC doesn't have (Git; the GitHub CLI only if GitHub asks for
  // a sign-in) is offered for install, once per window. Everything else that can go wrong (offline,
  // a copy that isn't updated from here) ends silently, by request: Check for updates in
  // Preferences is the place that explains problems. A version declined isn't offered again until
  // the window is next opened.
  async function checkForUpdatesAtLaunch() {
    const offered = 'deck-update-offered';
    let check;
    try {
      check = await api('POST', '/api/update', { apply: false });
    } catch (err) {
      if (!err.prerequisite) return;
      try {
        if (sessionStorage.getItem('deck-prerequisite-offered') === err.prerequisite) return;
        sessionStorage.setItem('deck-prerequisite-offered', err.prerequisite);
      } catch { /* storage unavailable: offer it anyway */ }
      while (document.querySelector('.tour, dialog[open]')) await new Promise((r) => setTimeout(r, 1000));
      offerPrerequisite(err, checkForUpdatesAtLaunch);
      return;
    }
    if (!check || !check.available) return;
    const version = String(check.to || '');
    try {
      if (sessionStorage.getItem(offered) === version) return;
      sessionStorage.setItem(offered, version);
    } catch { /* storage unavailable: offer it anyway */ }
    // After the first-launch tour or any open dialog, not on top of them.
    while (document.querySelector('.tour, dialog[open]')) await new Promise((r) => setTimeout(r, 1000));
    const ok = await Deck.confirm({
      title: 'Update found',
      body: `Would you like to update Claude Deck now?${check.to && check.to !== check.from ? ` Version ${check.to} is available${check.from ? ` (this is ${check.from})` : ''}.` : ''} Claude Deck gets it from GitHub, then restarts and this window reloads. Chats end, including one working on Claude Deck itself; resume them afterwards. Terminal sessions keep running.`,
      ok: 'Update now',
    });
    if (!ok) return;
    let res;
    try { res = await api('POST', '/api/update', { apply: true }); } catch { return; }
    if (!res || !res.updated) return;
    toast(`Updated to v${res.to}. Restarting…`);
    reloadWhenRestarted(res.pid);
  }

  // ---- views + wiring ------------------------------------------------------------------------
  function setView(view) {
    if (!['sessions', 'history', 'settings', 'prefs'].includes(view)) view = 'sessions';
    if (view !== S.view) closePluginsMenu();
    S.view = view;
    store.set('view', view);
    for (const v of ['sessions', 'history', 'settings', 'prefs']) $(`#view-${v}`).hidden = v !== view;
    $$('.nav-item').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
    if (view === 'sessions') renderSessions();
    else if (view === 'history') loadHistory(true);
    else if (view === 'settings') Deck.SettingsUI.show();
    else if (view === 'prefs') renderPrefs();
  }

  function applyTheme() {
    document.documentElement.dataset.theme = S.prefs.theme;
    // The chosen fonts replace the text and label stacks (app.css --font and --font-plate).
    for (const [key, prop] of [['fontText', '--font'], ['fontLabels', '--font-plate']]) {
      const choice = FONT_CHOICES[S.prefs[key]];
      if (choice && choice.stack) document.documentElement.style.setProperty(prop, choice.stack);
      else document.documentElement.style.removeProperty(prop);
    }
    // Tool-call emoji are drawn either way and shown by CSS, so the toggle applies to open chats at once.
    document.documentElement.dataset.toolIcons = S.prefs.showToolIcons ? 'on' : 'off';
    if (S.term) S.term.xterm.options.theme = termTheme();
  }

  function setConn(ok) {
    $('#conn').className = `conn ${ok ? 'ok' : 'down'}`;
    $('#conn-text').textContent = ok ? 'Live' : 'Reconnecting…';
  }

  function connect() {
    const es = new EventSource(`/api/events?t=${encodeURIComponent(Deck.token)}`);
    let wasDown = false;
    es.addEventListener('state', (e) => {
      S.live = JSON.parse(e.data);
      setConn(true);
      if (S.view === 'sessions') renderSessions();
      else renderSummary();
    });
    es.addEventListener('notify', (e) => onNotify(JSON.parse(e.data)));
    es.addEventListener('chat', (e) => onChatEvent(JSON.parse(e.data)));
    es.addEventListener('chat-tasks', (e) => onChatTasks(JSON.parse(e.data)));
    es.addEventListener('usage', (e) => { S.usage = JSON.parse(e.data); renderUsage(); });
    // Claude Code reported a different model list (a new version, say): menus opened from now on use it.
    es.addEventListener('models', (e) => { S.boot.models = JSON.parse(e.data); });
    // Claude Code turned up after the server started (installed since): Preferences shows it.
    // Claude Code turned up after the server started, was updated, or has a newer version out.
    es.addEventListener('claude', (e) => {
      S.boot.claude = JSON.parse(e.data);
      if (S.view === 'prefs') renderPrefs();
      offerClaudeUpdate();
    });
    es.addEventListener('open', () => {
      setConn(true);
      // After a reconnect, reload the open chat in case events were missed. If the server that
      // answers now is another version (restarted by its supervisor, or updated from another
      // window), this page's scripts are out of date: reload the page instead.
      if (wasDown) {
        api('GET', '/api/ping').then((p) => { if (p.version && S.boot && p.version !== S.boot.version) location.reload(); }).catch(() => {});
        if (S.chat) { const it = findItem(`d:${S.chat.id}`); if (it) loadChat(it); }
      }
      wasDown = false;
    });
    es.addEventListener('error', () => { setConn(false); wasDown = true; });
  }

  function onKey(e) {
    // A key a control has already used (arrows in a menu, Enter on a subagent card) isn't also a
    // page shortcut: it would switch sessions under the open menu, or close what Enter just opened.
    if (e.defaultPrevented) return;
    const t = e.target;
    const typing = t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]');
    const key = e.key.toLowerCase();
    // In a terminal here, keys are Claude Code's own (Ctrl+B, Ctrl+K, Ctrl+W, Esc, / and ?); only
    // the keys that move between sessions and views stay the page's (termKeys keeps those from
    // the terminal too).
    if (t && t.closest && t.closest('.term-pane') && !isDeckKey(e)) return;
    // Inside the session menu or the plugins popover, plain keys (arrows, Enter) belong to it.
    if (t && t.closest && t.closest('.hm-menu, .plugin-pop') && !e.ctrlKey && !e.altKey && !e.metaKey) return;
    if ((e.ctrlKey || e.metaKey) && key === 'k') { e.preventDefault(); openPalette(); return; }
    if ((e.ctrlKey || e.metaKey) && key === 'b') { e.preventDefault(); if (S.toggleRail) S.toggleRail(); return; }
    if ((e.ctrlKey || e.metaKey) && key === 's' && S.view === 'settings') { e.preventDefault(); Deck.SettingsUI.save(); return; }
    if (e.altKey && !e.ctrlKey && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); setView(['sessions', 'history', 'settings', 'prefs'][Number(e.key) - 1]); return; }
    // Work while typing too. In an installed app window Chromium lets the page take these first;
    // outside the Sessions view they're left to the browser (where Ctrl+W closes the window).
    if (e.ctrlKey && !e.altKey && !e.metaKey && S.view === 'sessions' && (key === 'tab' || (key === 'w' && !e.shiftKey))) {
      e.preventDefault();
      // Holding Ctrl+Tab keeps cycling; holding Ctrl+W must not end one chat after another.
      if (document.querySelector('dialog[open]') || (key === 'w' && e.repeat)) return;
      if (key === 'tab') cycleSessions(e.shiftKey ? -1 : 1);
      else closeSelectedChat();
      return;
    }
    // Ctrl+Shift+N: start a new chat with the default settings, from anywhere in the Sessions
    // view, even while typing a reply.
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'n' && S.view === 'sessions') {
      e.preventDefault();
      if (!e.repeat && !document.querySelector('dialog[open]')) quickStart();
      return;
    }
    // F2: rename the selected session, as in Explorer; works while typing (F2 does nothing in a
    // text box), so it follows Ctrl+Tab. The cursor goes back where it was afterwards.
    if (e.key === 'F2' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && S.view === 'sessions' && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      const it = S.selected ? findItem(S.selected) : null;
      if (!it) return;
      if (!it.deck) { toast('Sessions started outside Claude Deck can\'t be renamed here.'); return; }
      const back = document.activeElement;
      rename(it).then(() => { if (back && back.isConnected && !back.disabled) back.focus(); });
      return;
    }
    // Enter on an ended chat resumes it: from its list row, or with nothing focused
    // (its reply box is greyed out, so focus falls back to the page). Other buttons keep their Enter.
    if (key === 'enter' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && S.view === 'sessions' && S.selected && !document.querySelector('dialog[open]')) {
      const it = findItem(S.selected);
      const onIt = !t || t === document.body || t.disabled || (t.dataset && t.dataset.key === S.selected);
      if (it && isChat(it) && it.state === 'exited' && onIt) { e.preventDefault(); resumeAndFocus(it); return; }
    }
    if (typing || e.ctrlKey || e.altKey || e.metaKey || document.querySelector('dialog[open]')) return;
    if (e.key === '/') {
      const f = S.view === 'history' ? $('#history-search') : S.view === 'sessions' ? $('#session-filter') : null;
      if (f) { e.preventDefault(); f.focus(); }
    } else if (e.key === '?') { e.preventDefault(); $('#dlg-keys').showModal(); }
    else if (S.view === 'sessions' && ['arrowdown', 'arrowright'].includes(key)) { e.preventDefault(); moveSelection(1); }
    else if (S.view === 'sessions' && ['arrowup', 'arrowleft'].includes(key)) { e.preventDefault(); moveSelection(-1); }
    else if (S.view === 'sessions' && key === 'enter' && S.selected && !(t && t.closest('button, summary, a'))) {
      const it = findItem(S.selected);
      if (it) { e.preventDefault(); openSession(it); }
    }
  }

  function fatal(title, body) {
    const main = clear(document.querySelector('main'));
    main.appendChild(h('div', { class: 'empty' }, h('h2', null, title), h('p', null, body)));
  }

  function wireRailCollapse() {
    const app = $('.app');
    const toggleBtn = $('#btn-rail-toggle');
    // Windows 900px wide or less (app.css) start with the list narrowed, to leave the chat room.
    // Widening it there lasts until the window crosses 900px and doesn't change the saved choice.
    const narrow = window.matchMedia('(max-width: 900px)');
    const applyRail = () => app.classList.toggle('rail-collapsed', narrow.matches || Boolean(store.get('rail-collapsed', false)));
    applyRail();
    narrow.addEventListener('change', applyRail);

    function toggleRail() {
      const next = !app.classList.contains('rail-collapsed');
      app.classList.toggle('rail-collapsed', next);
      if (!narrow.matches) store.set('rail-collapsed', next);
    }

    if (toggleBtn) toggleBtn.addEventListener('click', toggleRail);
    S.toggleRail = toggleRail;
  }

  // Needs-you lamps flash once a second, like a signal box's. One clock for the whole page, so a
  // lamp on a row that was just rebuilt stays in step with the rest (a CSS animation per lamp would
  // restart on every update). With reduced motion they stay lit.
  function wireLampFlash() {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    setInterval(() => {
      document.documentElement.classList.toggle('lamps-dim', !still.matches && !document.documentElement.classList.contains('lamps-dim'));
    }, 500);
  }

  // A list beside a reading pane, resized by dragging the line between them (or with ← and → on
  // it), remembered per view. Double-click puts it back: to `reset` px, or with reset null to the
  // width the stylesheet gives it. The width lives in the CSS custom property `prop` on `container`.
  function wireSplitter({ splitter, container, list, prop, storeKey, reset, min, max }) {
    if (!splitter || !container) return;

    const saved = store.get(storeKey, reset);
    if (typeof saved === 'number' && saved >= 200 && saved <= 700) container.style.setProperty(prop, `${saved}px`);
    else if (reset !== null) container.style.setProperty(prop, `${reset}px`);
    // The width now: the one set here, or (none set yet) the list's own.
    const current = () => parseInt(getComputedStyle(container).getPropertyValue(prop), 10) || Math.round(list.getBoundingClientRect().width) || reset || min;
    const setWidth = (w) => {
      const next = Math.max(min, Math.min(max, w));
      container.style.setProperty(prop, `${next}px`);
      store.set(storeKey, next);
    };

    let dragging = false;
    let startX = 0;
    let startW = 0;

    splitter.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = current();
      splitter.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      setWidth(startW + e.clientX - startX);
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        splitter.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });

    splitter.addEventListener('dblclick', () => {
      if (reset !== null) { setWidth(reset); return; }
      container.style.removeProperty(prop);
      try { localStorage.removeItem(`deck-${storeKey}`); } catch { /* storage unavailable */ }
    });

    splitter.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') setWidth(current() - 15);
      else if (e.key === 'ArrowRight') setWidth(current() + 15);
    });
  }

  function wireSplitters() {
    wireSplitter({ splitter: $('#focus-splitter'), container: $('#focus'), list: $('#focus .track'), prop: '--focus-sidebar-w', storeKey: 'focus-sidebar-width', reset: 290, min: 220, max: 500 });
    // History's list starts at the width the stylesheet gives it (it grows with the window).
    wireSplitter({ splitter: $('#history-splitter'), container: $('#view-history .split'), list: $('#history-list'), prop: '--history-list-w', storeKey: 'history-list-width', reset: null, min: 240, max: 640 });
  }

  async function init() {
    if (!Deck.token) {
      fatal('Open Claude Deck from its shortcut', 'This window was opened without its access key. Start Claude Deck with Start-ClaudeDeck.ps1 or its shortcut.');
      return;
    }
    try {
      S.boot = await api('GET', '/api/bootstrap');
    } catch (err) {
      fatal(err.status === 401 ? 'This window has an old access key' : 'Claude Deck is not responding',
        err.status === 401 ? 'Close this window and start Claude Deck again from its shortcut.' : `Start Claude Deck again from its shortcut. (${err.message})`);
      return;
    }
    S.prefs = S.boot.prefs;
    S.live = S.boot.state;
    S.usage = S.boot.usage || null;
    applyTheme();
    // The version the server was started from, beside the connection light.
    $('#conn-version').textContent = `v${S.boot.version}`;
    $('#conn').title = `Connection to the local Claude Deck server (Claude Deck ${S.boot.version})`;
    loadBilling();
    window.addEventListener('focus', loadBilling);

    $$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('#btn-new').addEventListener('click', () => openLaunch());
    $('#session-filter').addEventListener('input', (e) => { S.filter = e.target.value.trim(); renderSessions(); });
    $('#history-search').addEventListener('input', () => { S.historyLimit = 150; renderHistory(); });
    $('#history-folder').addEventListener('change', () => { S.historyLimit = 150; renderHistory(); });
    $('#history-sort').addEventListener('change', () => renderHistory());
    for (const b of $$('#history-view button')) b.addEventListener('click', () => setHistoryView(b.dataset.view));
    $('#btn-rescan').addEventListener('click', async () => {
      const data = await run("Couldn't rescan", () => api('POST', '/api/history/rebuild'));
      if (data) { S.history = { ...data, loaded: true }; renderHistory(); toast('History rescanned'); }
    });
    $('#btn-enable-notif').addEventListener('click', async () => { await Notification.requestPermission(); updateNotifBanner(); });
    $('#btn-dismiss-notif').addEventListener('click', () => { store.set('notifDismissed', true); updateNotifBanner(); });
    document.addEventListener('keydown', onKey);
    // A file dropped outside the reply box does nothing; left to Edge, it would open the file in
    // place of the dashboard. (The reply box handles its own drops first.)
    const noDrop = (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      if (!e.target.closest || !e.target.closest('.composer')) e.dataTransfer.dropEffect = 'none';
    };
    document.addEventListener('dragover', noDrop);
    document.addEventListener('drop', noDrop);
    // Installable-app support: the service worker shows an offline page when the server is down.
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      S.installPrompt = e;
      if (S.view === 'prefs') renderPrefs();
    });
    window.addEventListener('appinstalled', () => {
      S.installPrompt = null;
      toast('Claude Deck is installed. To pin it, right-click its taskbar icon and choose Pin to taskbar.');
      if (S.view === 'prefs') renderPrefs();
    });
    window.addEventListener('beforeunload', (e) => { if (Deck.SettingsUI.isDirty()) { e.preventDefault(); e.returnValue = ''; } });

    wireRailCollapse();
    wireLampFlash();
    wireSplitters();
    wireLaunch();
    wireFolderPicker();
    wireUsage();
    wirePalette();
    Deck.SettingsUI.mount($('#settings-root'), {
      boot: S.boot,
      folders: async () => ((await run("Couldn't load folders", () => api('GET', '/api/folders'))) || S.folders),
      pickFolder,
      openFolder,
    });
    updateNotifBanner();
    setView(S.view);
    connect();
    // Once the page has drawn: on first launch the guided tour, then the update check, which waits
    // for the tour to finish before it asks anything.
    setTimeout(() => {
      if (!store.get('tourSeen', false)) startTour();
      checkForUpdatesAtLaunch();
      offerClaudeUpdate();
      offerPriorityFix();
    }, 400);
    // Keep "for 3m" style labels fresh.
    setInterval(() => { if (S.view === 'sessions' && !document.hidden) { renderSessions(); renderUsage(); } }, 30000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
