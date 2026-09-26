'use strict';
// Claude Deck dashboard: sessions board / focus view with in-app chat, history, launcher,
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
    layout: store.get('layout', 'board'),
    selected: null,
    opening: null, // { key, until } while a just-created session waits for its first state update
    filter: '',
    history: { sessions: [], live: [], loaded: false },
    historySel: null,
    historyLimit: 150,
    folders: { favorites: [], recent: [] },
    detailKey: null,
    headSig: null,
    convo: { key: null, stamp: null, sessionId: null },
    chat: null, // the chat shown in the focus view: { id, loaded, items: Map, past, commands, buffer }
    drafts: {},
    attachments: {}, // chat id -> images waiting to be sent
    showTasks: {}, // chat id -> subagents panel open
    showChanges: {}, // session key -> changes shown instead of the conversation
    agentView: null, // { chatId, taskId }: a subagent's detail shown instead of the conversation
  };

  const LANES = [
    { key: 'waiting', label: 'Needs you' },
    { key: 'working', label: 'Working' },
    { key: 'idle', label: 'Idle' },
    { key: 'ended', label: 'Ended' },
  ];
  const COLOR_NAMES = { slate: 'Slate', cyan: 'Cyan', amber: 'Amber', sage: 'Sage', rose: 'Rose', violet: 'Violet', sand: 'Sand' };
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
    else if (isTerminal(it)) {
      if (it.state === 'exited') resumeTerminal(it);
      else run("Couldn't open the terminal", () => api('POST', `/api/sessions/${it.id}/focus`));
    } else showDetails(it.key);
  }

  function openChat(id, focusComposer = true) {
    S.selected = `d:${id}`;
    S.agentView = null; // opening a chat shows its conversation
    S.opening = { key: S.selected, until: Date.now() + 8000 };
    if (S.view !== 'sessions') setView('sessions');
    setLayout('focus');
    if (focusComposer) setTimeout(() => { const ta = $('#focus-detail .composer-input'); if (ta && !ta.disabled) ta.focus(); }, 60);
  }

  function backToBoard() {
    setLayout('board');
    const el = S.selected && document.querySelector(`#board [data-key="${CSS.escape(S.selected)}"]`);
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
      title = isChat(it) ? 'Remove this chat from the board?' : 'Close this tab?';
      body = 'The conversation stays in History.';
      ok = isChat(it) ? 'Remove' : 'Close tab';
    } else {
      title = 'End this session?';
      body = `Claude stops${active ? ' mid-task' : ''}${isTerminal(it) ? ' and its tab closes' : ''}. The conversation stays in History, so you can resume it later.`;
      ok = 'End session';
    }
    const ask = !quick || active || it.kind === 'external';
    if (ask && !(await Deck.confirm({ title, body, ok, danger: active || it.kind === 'external' }))) return false;
    const path = isChat(it) ? `/api/chats/${it.id}/end` : isTerminal(it) ? `/api/sessions/${it.id}/close` : `/api/external/${it.pid}/end`;
    const keep = quick && !ended && isChat(it);
    const res = await run("Couldn't end the session", () => api('POST', path, keep ? { keep: true } : undefined));
    if (!res) return false;
    if (keep) {
      // Still listed (as ended) and still selected, so a second Ctrl+W removes it.
      toast('Chat ended', 'info', { label: 'Undo', ms: 8000, run: () => resumeChat(it) });
      return true;
    }
    toast(ended ? 'Removed' : 'Session ended');
    if (S.selected === it.key && S.layout === 'focus') S.selected = null;
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
    if (c) openChat(c.id);
  }

  async function continueInTerminal(it) {
    const ok = await Deck.confirm({ title: 'Continue in Windows Terminal?', body: 'This chat ends here and the same conversation opens in a Windows Terminal tab, with the full terminal interface.', ok: 'Open in terminal' });
    if (!ok) return;
    const res = await run("Couldn't move the chat", () => api('POST', `/api/chats/${it.id}/to-terminal`));
    if (res) toast('Continuing in Windows Terminal');
  }

  async function dismiss(it) {
    await run("Couldn't dismiss", () => api('POST', `/api/sessions/${it.id}/dismiss`));
  }

  async function rename(it) {
    const name = await Deck.promptText({ title: 'Rename session', label: 'Name shown in Claude Deck', value: it.name || '' });
    if (name === null) return;
    const base = isChat(it) ? '/api/chats' : '/api/sessions';
    await run("Couldn't rename", () => api('PATCH', `${base}/${it.id}`, { name }));
  }

  async function recolor(it, color) {
    const base = isChat(it) ? '/api/chats' : '/api/sessions';
    await run("Couldn't change the color", () => api('PATCH', `${base}/${it.id}`, { color }));
  }

  function openFolder(p) {
    if (p) run("Couldn't open the folder", () => api('POST', '/api/open-folder', { path: p }));
  }

  // Answer a permission prompt or question for a chat.
  async function answer(chatId, requestId, decision) {
    return run("Couldn't send the answer", () => api('POST', `/api/chats/${chatId}/respond`, { requestId, ...decision }));
  }

  // ---- board ---------------------------------------------------------------------------------
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };

  function cardActions(it) {
    const b = [];
    if (isTerminal(it) && it.state === 'failed') {
      b.push(h('button', { class: 'small', onclick: stop(() => dismiss(it)) }, 'Dismiss'));
      return b;
    }
    if (isChat(it)) {
      if (it.state === 'exited') b.push(h('button', { class: 'primary small', onclick: stop(() => resumeChat(it)) }, 'Resume'));
      b.push(h('button', { class: `${it.state === 'exited' ? 'ghost' : 'primary'} small`, onclick: stop(() => openChat(it.id)) }, 'Open chat'));
    } else if (isTerminal(it)) {
      b.push(h('button', { class: 'primary small', onclick: stop(() => openSession(it)) }, it.state === 'exited' ? 'Resume' : 'Open terminal'));
      b.push(h('button', { class: 'ghost small', onclick: stop(() => showDetails(it.key)) }, 'Details'));
    } else {
      b.push(h('button', { class: 'ghost small', onclick: stop(() => showDetails(it.key)) }, 'Details'));
    }
    b.push(h('span', { class: 'grow' }));
    const ended = it.state === 'exited';
    b.push(h('button', { class: 'ghost danger small', title: ended ? 'Remove from the board' : 'End this session', onclick: stop(() => endSession(it)) }, ended ? (isChat(it) ? 'Remove' : 'Close tab') : 'End'));
    return b;
  }

  // Permission prompts can be answered right on the card; questions open the chat.
  function cardRequest(it) {
    const p = it.pending;
    if (!isChat(it) || !p) return null;
    if (p.kind === 'question') {
      return h('div', { class: 'card-req' },
        h('div', null, h('strong', null, 'Claude has a question for you')),
        h('div', { class: 'req-actions' }, h('button', { class: 'primary small', onclick: stop(() => openChat(it.id)) }, 'Answer')));
    }
    return h('div', { class: 'card-req' },
      h('div', null, h('strong', null, `Wants to use ${p.displayName}`), p.detail ? h('code', { class: 'req-detail', title: p.detail }, p.detail) : null),
      h('div', { class: 'req-actions' },
        h('button', { class: 'primary small', onclick: stop(() => answer(it.id, p.requestId, { action: 'allow' })) }, 'Allow'),
        h('button', { class: 'danger small', onclick: stop(() => answer(it.id, p.requestId, { action: 'deny' })) }, 'Deny'),
        h('button', { class: 'ghost small', onclick: stop(() => openChat(it.id)) }, 'More options')));
  }

  // Claude's own title for the conversation, when it adds something beyond the name.
  function subtitle(it) {
    return it.name && it.title && it.title.trim().toLowerCase() !== it.name.trim().toLowerCase() ? it.title : null;
  }

  function card(it) {
    const title = heading(it);
    const sub = subtitle(it);
    const since = it.statusSince ? ago(it.statusSince) : '';
    const snippet = isChat(it) && it.lastReply
      ? h('div', { class: 'card-prompt' }, h('span', { class: 'who' }, 'Claude: '), it.lastReply)
      : it.lastPrompt ? h('div', { class: 'card-prompt' }, isChat(it) ? h('span', { class: 'who' }, 'You: ') : null, it.lastPrompt) : null;
    return h('article', {
      class: `card${it.deck ? '' : ' external'}${S.selected === it.key ? ' selected' : ''}`,
      tabindex: 0,
      dataset: { key: it.key },
      style: it.deck ? { '--tag': `var(--c-${it.color || 'slate'})` } : null,
      'aria-label': `${title}, ${statusLabel(it)}`,
      onclick: () => select(it.key),
      ondblclick: () => openSession(it),
    },
    h('div', { class: 'card-status' },
      h('span', { class: `lamp ${it.lane}` }),
      h('span', { class: `status-text ${it.lane}` }, statusLabel(it)),
      h('span', { class: 'since', title: it.statusSince ? `Since ${when(it.statusSince)}` : null }, since)),
    h('div', { class: `card-title${it.title || it.name ? '' : ' untitled'}` }, title),
    sub ? h('div', { class: 'muted' }, sub) : null,
    cardRequest(it) || snippet,
    // Subagents can keep working after Claude's reply ends, so show them even when the chat is idle.
    isChat(it) && it.runningTasks ? h('div', { class: 'card-tasks' }, h('span', { class: 'lamp working' }), `${it.runningTasks} subagent${it.runningTasks === 1 ? '' : 's'} running`) : null,
    it.state === 'failed' && it.launchError ? h('div', { class: 'error' }, it.launchError) : null,
    h('div', { class: 'card-meta' },
      h('span', { class: 'path', title: it.cwd || '' }, shortPath(it.cwd)),
      h('span', { class: 'where' }, isChat(it) ? 'Chat' : isTerminal(it) ? 'Terminal' : 'External'),
      it.gitBranch && it.gitBranch !== 'HEAD' ? h('span', { class: 'branch', title: `Git branch: ${it.gitBranch}` }, `⎇ ${it.gitBranch}`) : null),
    h('div', { class: 'card-actions' }, cardActions(it)));
  }

  function emptyState() {
    return h('div', { class: 'empty' },
      h('h2', null, 'No Claude sessions running'),
      h('p', null, 'Start one here and reply to it right from the dashboard, or run it in Windows Terminal. Sessions you start in other terminals show up here too.'),
      h('button', { class: 'primary', onclick: () => openLaunch() }, 'New session'),
      h('p', { class: 'faint', style: { marginTop: '14px' } }, 'Or pick up an old conversation from History.'));
  }

  function renderBoard() {
    const board = $('#board');
    const activeKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    const scroll = board.scrollTop;
    clear(board);
    if (!allItems().length) {
      board.appendChild(emptyState());
      return;
    }
    const groups = visibleItems();
    if (!groups.some((g) => g.items.length)) {
      board.appendChild(h('div', { class: 'empty' }, h('p', null, 'No sessions match that filter.')));
      return;
    }
    for (const { lane, items } of groups) {
      if (!items.length) continue;
      board.appendChild(h('section', { class: `lane ${lane.key}`, 'aria-label': lane.label },
        h('div', { class: 'lane-head' },
          h('span', { class: `lamp ${lane.key}` }),
          h('h2', null, lane.label),
          h('span', { class: 'lane-count' }, String(items.length))),
        h('div', { class: 'cards' }, items.map(card))));
    }
    board.scrollTop = scroll;
    if (activeKey) {
      const el = board.querySelector(`[data-key="${CSS.escape(activeKey)}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  // ---- focus layout --------------------------------------------------------------------------
  function renderFocusList() {
    const list = $('#focus-list');
    clear(list);
    list.appendChild(h('button', { class: 'ghost small back', onclick: backToBoard, title: 'Esc' }, '← Board'));
    const groups = visibleItems();
    if (!groups.some((g) => g.items.length)) {
      list.appendChild(h('p', { class: 'faint', style: { padding: '12px' } }, allItems().length ? 'No sessions match that filter.' : 'No sessions running.'));
      return;
    }
    for (const { lane, items } of groups) {
      if (!items.length) continue;
      list.appendChild(h('div', { class: 'focus-group' }, h('span', { class: `lamp ${lane.key}` }), `${lane.label} (${items.length})`));
      for (const it of items) {
        list.appendChild(h('button', {
          class: 'focus-row',
          role: 'option',
          'aria-selected': String(S.selected === it.key),
          dataset: { key: it.key },
          style: it.deck ? { '--tag': `var(--c-${it.color || 'slate'})` } : null,
          onclick: () => select(it.key),
          ondblclick: () => openSession(it),
        },
        h('span', { class: `lamp ${it.lane}` }),
        h('span', { class: 'fr-text' },
          h('div', { class: 'fr-title' }, heading(it)),
          h('div', { class: 'fr-sub' }, h('span', null, isChat(it) ? 'Chat' : isTerminal(it) ? 'Terminal' : 'Outside'), h('span', null, shortPath(it.cwd, 1)), it.statusSince ? h('span', null, ago(it.statusSince)) : null))));
      }
    }
  }

  function fact(label, value, mono) {
    if (value === null || value === undefined || value === '') return null;
    return h('div', null, h('dt', null, label), h('dd', { class: mono ? 'mono' : null }, value instanceof Node ? value : String(value)));
  }

  function colorSelect(it) {
    return h('select', { class: 'small', 'aria-label': 'Card color', onchange: (e) => recolor(it, e.target.value) },
      Object.entries(COLOR_NAMES).map(([k, v]) => h('option', { value: k, selected: k === (it.color || 'slate') }, `${v} tag`)));
  }

  function changesButton(it) {
    if (!it.sessionId) return null;
    const on = Boolean(S.showChanges[it.key]);
    return h('button', { class: 'ghost small', 'aria-pressed': String(on), title: 'Files Claude changed in each turn, with diffs and restore', onclick: () => toggleChanges(it) }, on ? 'Conversation' : 'Changes');
  }

  function detailHead(it) {
    const acts = [];
    const cmd = resumeCommand(it);
    if (isChat(it)) {
      if (it.state === 'exited') acts.push(h('button', { class: 'primary small', onclick: () => resumeChat(it) }, 'Resume'));
      acts.push(h('button', {
        class: `${it.runningTasks ? '' : 'ghost '}small`,
        'aria-pressed': String(Boolean(S.showTasks[it.id])),
        title: 'Subagents Claude started in this chat',
        onclick: () => { S.showTasks[it.id] = !S.showTasks[it.id]; S.headSig = null; renderFocusDetail(); renderTasksPanel(); },
      }, it.runningTasks ? `Subagents (${it.runningTasks} running)` : it.taskCount ? `Subagents (${it.taskCount})` : 'Subagents'));
      acts.push(changesButton(it));
      acts.push(h('button', { class: 'ghost small', onclick: () => rename(it) }, 'Rename'), colorSelect(it));
      acts.push(h('button', { class: 'ghost small', onclick: () => openFolder(it.cwd) }, 'Open folder'));
      if (it.sessionId) acts.push(h('button', { class: 'ghost small', onclick: () => continueInTerminal(it), title: 'Continue this conversation in a Windows Terminal tab' }, 'Continue in terminal'));
      acts.push(h('button', { class: 'danger small', onclick: () => endSession(it) }, it.state === 'exited' ? 'Remove' : 'End session'));
    } else if (isTerminal(it)) {
      if (it.state !== 'failed') {
        acts.push(h('button', { class: 'primary small', onclick: () => openSession(it) }, it.state === 'exited' ? 'Resume' : 'Open terminal'));
        if (it.sessionId) acts.push(h('button', { class: 'ghost small', onclick: () => continueHere(it), title: 'Close the tab and continue this conversation here' }, 'Continue here'));
        acts.push(changesButton(it));
        acts.push(h('button', { class: 'ghost small', onclick: () => rename(it) }, 'Rename'), colorSelect(it));
      }
      acts.push(h('button', { class: 'ghost small', onclick: () => openFolder(it.cwd), disabled: !it.cwd }, 'Open folder'));
      if (cmd) acts.push(h('button', { class: 'ghost small', onclick: () => copy(cmd, 'Resume command copied') }, 'Copy resume command'));
      if (it.state === 'failed') acts.push(h('button', { class: 'ghost small', onclick: () => dismiss(it) }, 'Dismiss'));
      else acts.push(h('button', { class: 'danger small', onclick: () => endSession(it) }, it.state === 'exited' ? 'Close tab' : 'End session'));
    } else {
      if (it.sessionId && it.cwd) acts.push(h('button', { class: 'primary small', onclick: () => continueHere(it) }, 'Continue here'));
      acts.push(changesButton(it));
      acts.push(h('button', { class: 'ghost small', onclick: () => openFolder(it.cwd), disabled: !it.cwd }, 'Open folder'));
      if (cmd) acts.push(h('button', { class: 'ghost small', onclick: () => copy(cmd, 'Resume command copied') }, 'Copy resume command'));
      acts.push(h('button', { class: 'danger small', onclick: () => endSession(it) }, 'End session'));
    }

    // Running chats get pickers; everything else shows what's known as text.
    let modelFact = it.model;
    let effortFact = isChat(it) ? it.requestedEffort || null : null;
    let modeFact = isChat(it) ? it.permissionMode || null : null;
    if (isChat(it) && it.state !== 'exited') {
      modelFact = Deck.modelPicker(S.boot.enums.models, it.requestedModel || '',(m) => run("Couldn't change the model", () => api('POST', `/api/chats/${it.id}/model`, { model: m })), `Default (${it.model || 'from settings'})`);
      effortFact = h('select', { class: 'small', 'aria-label': 'Effort', onchange: (e) => run("Couldn't change the effort", () => api('POST', `/api/chats/${it.id}/effort`, { effort: e.target.value })) },
        h('option', { value: '' }, 'Default'),
        S.boot.enums.efforts.map((v) => h('option', { value: v, selected: v === it.requestedEffort }, v)));
      const modes = ['default', ...S.boot.enums.permissionModes.filter((m) => m !== 'manual')];
      modeFact = h('select', { class: 'small', 'aria-label': 'Permission mode', onchange: (e) => run("Couldn't change the permission mode", () => api('POST', `/api/chats/${it.id}/mode`, { mode: e.target.value })) },
        modes.map((m) => h('option', { value: m, selected: m === (it.permissionMode || 'default') }, m)));
    }
    const settingFacts = [fact('Model', modelFact), fact('Effort', effortFact), fact('Permissions', modeFact), isChat(it) ? fact('Plugins', pluginsButton(it)) : null].filter(Boolean);

    return h('div', { class: 'detail-head' },
      h('div', { class: 'card-status' },
        h('span', { class: `lamp ${it.lane}` }),
        h('span', { class: `status-text ${it.lane}` }, statusLabel(it)),
        it.statusSince ? h('span', { class: 'faint' }, `for ${ago(it.statusSince).replace('just now', 'a moment')}`) : null,
        h('span', { class: 'spacer' }),
        isChat(it) && it.status === 'busy' ? h('button', { class: 'danger small', onclick: () => stopTurn(it) }, 'Stop') : null),
      h('h2', null, heading(it)),
      subtitle(it) ? h('div', { class: 'muted' }, subtitle(it)) : null,
      it.note ? h('p', { class: 'faint', style: { margin: '6px 0 0' } }, it.note) : null,
      it.kind === 'external' ? h('p', { class: 'faint', style: { margin: '6px 0 0' } }, 'Started outside Claude Deck. Choose Continue here to reply to it from the dashboard.') : null,
      it.state === 'failed' && it.launchError ? h('p', { class: 'error' }, it.launchError) : null,
      h('dl', { class: 'facts' },
        // Cut from the start, so the folder's own name stays visible.
        fact('Folder', it.cwd ? h('span', { class: 'row-path' },
          h('span', { class: 'path-text', title: it.cwd }, h('bdi', null, it.cwd)),
          h('button', { class: 'ghost icon small', title: 'Copy folder path', onclick: () => copy(it.cwd, 'Folder path copied') }, '⎘'),
          h('button', { class: 'ghost icon small', title: 'Open folder in Explorer', onclick: () => openFolder(it.cwd) }, '↗')
        ) : null, true),
        fact('Branch', it.gitBranch && it.gitBranch !== 'HEAD' ? it.gitBranch : null),
        fact('Session ID', it.sessionId, true),
        fact('Prompts', it.userTurns || null),
        fact('Est. cost', money(it.costUSD)),
        isTerminal(it) ? fact('Window', it.windowName) : it.kind === 'external' ? fact('Process', it.pid) : null),
      settingFacts.length ? h('dl', { class: 'facts' }, settingFacts) : null,
      h('div', { class: 'actions' }, acts));
  }

  // ---- plugins menu (chat header) ------------------------------------------------------------
  // Claude Code's plugins, through its own CLI (src/plugins.js). A change applies to every Claude
  // Code session; the chat whose menu it is picks it up at once (reload_plugins). The menu lives on
  // <body>, not in the header, because the header is rebuilt whenever the chat's status changes.
  const plugins = { byCwd: new Map(), loading: new Map(), pop: null, search: '', openCategories: new Set() };

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
    for (const b of $$('.plugin-btn')) b.textContent = `${pluginSummary(plugins.byCwd.get(b.dataset.cwd))} ▾`;
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
    }, `${pluginSummary(plugins.byCwd.get(key))} ▾`);
    if (!plugins.byCwd.has(key)) loadPlugins(key).then(updatePluginButtons).catch(() => {});
    if (plugins.pop && plugins.pop.chatId === it.id) plugins.pop.btn = btn;
    return btn;
  }

  function closePluginsMenu() {
    const p = plugins.pop;
    if (!p) return;
    p.el.remove();
    if (p.btn) p.btn.setAttribute('aria-expanded', 'false');
    plugins.pop = null;
  }

  function togglePluginsMenu(it, btn) {
    if (plugins.pop && plugins.pop.chatId === it.id) { closePluginsMenu(); return; }
    closePluginsMenu();
    const el = h('div', { class: 'plugin-pop', role: 'dialog', 'aria-label': 'Plugins' });
    el.addEventListener('click', (e) => e.stopPropagation());
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
      el.appendChild(h('label', { class: 'pp-row', title: pl.id },
        h('span', { class: 'pp-name' }, pl.name, h('small', { class: 'faint' }, pl.marketplace)),
        pl.description ? h('span', { class: 'pp-desc' }, pl.description) : null,
        h('input', { type: 'checkbox', class: 'pp-control', checked: pl.enabled, disabled: p.busy.has(pl.id), 'aria-label': `Turn ${pl.name} on`, onchange: (e) => setPluginEnabled(pl, e.target.checked) })));
    }
    el.appendChild(h('div', { class: 'pp-section' }, 'Marketplace'));
    const search = h('input', { type: 'search', class: 'pp-search', value: plugins.search, placeholder: `Search ${list.available.length} plugin${list.available.length === 1 ? '' : 's'}`, spellcheck: 'false', 'aria-label': 'Search the marketplace' });
    const results = h('div', { class: 'pp-results' });
    const row = (pl) => {
      const busy = p.busy.has(pl.id);
      return h('div', { class: 'pp-row', title: pl.id },
        h('span', { class: 'pp-name' }, pl.name, h('small', { class: 'faint' }, pl.marketplace)),
        pl.description ? h('span', { class: 'pp-desc' }, pl.description) : null,
        h('button', { type: 'button', class: 'ghost small pp-control', disabled: busy, onclick: () => installPlugin(pl) }, busy ? 'Installing…' : 'Install'));
    };
    // Grouped by the category each marketplace gives its plugins (plain list if none have one).
    // Groups start closed; a search opens every group with a match.
    const fill = () => {
      const q = plugins.search.trim().toLowerCase();
      const hits = list.available.filter((pl) => !q || `${pl.name} ${pl.description} ${pl.marketplace} ${pl.category || ''}`.toLowerCase().includes(q));
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

  // Only rebuild the header when something it shows changed, so dropdowns aren't reset mid-use.
  function headSignature(it) {
    return JSON.stringify([it.key, it.state, it.status, it.waitingFor, heading(it), it.title, it.name, it.model, it.requestedModel, it.requestedEffort, it.permissionMode,
      it.costUSD, it.sessionId, it.color, it.gitBranch, it.cwd, it.exitCode, it.note, it.userTurns, ago(it.statusSince),
      it.runningTasks, it.taskCount, Boolean(S.showTasks[it.id]), Boolean(S.showChanges[it.key])]);
  }

  function renderFocusDetail() {
    const pane = $('#focus-detail');
    const flat = visibleItems().flatMap((g) => g.items);
    let it = S.selected ? flat.find((x) => x.key === S.selected) : null;
    if (!it && S.opening && S.opening.key === S.selected && Date.now() < S.opening.until) {
      clear(pane).appendChild(h('div', { class: 'empty' }, h('p', null, 'Starting the session…')));
      S.detailKey = null;
      return;
    }
    if (!it && flat.length) {
      it = flat[0];
      S.selected = it.key;
    }
    if (!it) {
      clear(pane);
      S.detailKey = null;
      S.chat = null;
      pane.appendChild(allItems().length ? h('div', { class: 'empty' }, h('p', null, 'Select a session.')) : emptyState());
      return;
    }
    if (S.opening && S.opening.key === it.key) S.opening = null;

    const fresh = S.detailKey !== it.key || !pane.querySelector('.convo');
    if (fresh) {
      if (plugins.pop && plugins.pop.chatId !== it.id) closePluginsMenu();
      clear(pane);
      S.detailKey = it.key;
      S.headSig = headSignature(it);
      S.convo = { key: null, stamp: null, sessionId: null };
      pane.appendChild(detailHead(it));
      if (isChat(it)) pane.appendChild(h('div', { class: 'tasks-panel', hidden: true }));
      pane.appendChild(h('div', { class: 'changes-panel', hidden: true }));
      if (isChat(it)) pane.appendChild(h('div', { class: 'changes-panel agent-panel', hidden: true }));
      pane.appendChild(h('div', { class: 'convo' }, h('div', { class: 'convo-inner' })));
      if (isChat(it)) {
        pane.appendChild(composer(it));
        loadChat(it);
      } else {
        S.chat = null;
      }
    } else if (headSignature(it) !== S.headSig) {
      S.headSig = headSignature(it);
      pane.replaceChild(detailHead(it), pane.querySelector('.detail-head'));
    }
    if (isChat(it)) {
      updateComposer(it);
      renderTasksPanel(); // keeps the running times current
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
    S.convo = { key: it.key, sessionId: it.sessionId, stamp };
    try {
      const data = await api('GET', `/api/transcript/${it.sessionId}?limit=150`);
      if (S.convo.key !== it.key) return;
      renderConversation(box, data.items);
    } catch (err) {
      if (S.convo.key !== it.key) return;
      clear(inner).appendChild(h('p', { class: 'convo-note' }, err.status === 404 ? 'No transcript has been written for this session yet.' : `Couldn't load the conversation: ${err.message}`));
    }
  }

  function transcriptNode(m) {
    if (m.kind === 'user') {
      const onlyImages = /^\[\d+ images?\]$/.test(m.text);
      return h('div', { class: 'msg msg-user', title: m.ts ? when(m.ts) : null },
        m.images ? h('div', { class: 'faint small' }, `${m.images} image${m.images === 1 ? '' : 's'} attached`) : null,
        onlyImages ? null : h('div', { class: 'msg-text' }, m.text));
    }
    if (m.kind === 'assistant') {
      const div = h('div', { class: 'msg msg-assistant' });
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
    if (first || atBottom) box.scrollTop = box.scrollHeight;
  }

  // ---- chat ----------------------------------------------------------------------------------
  async function loadChat(it) {
    S.chat = { id: it.id, loaded: false, items: new Map(), past: [], commands: [], buffer: [], tasks: [] };
    try {
      const d = await api('GET', `/api/chats/${it.id}`);
      if (!S.chat || S.chat.id !== it.id) return;
      S.chat.past = d.past || [];
      S.chat.commands = d.commands || [];
      S.chat.tasks = d.tasks || [];
      renderTasksPanel();
      for (const item of d.items) S.chat.items.set(item.n, item);
      for (const e of S.chat.buffer) if (e.seq > d.seq && e.item) S.chat.items.set(e.item.n, e.item);
      S.chat.buffer = [];
      S.chat.loaded = true;
      renderChat(true);
    } catch (err) {
      const inner = $('#focus-detail .convo-inner');
      if (inner) clear(inner).appendChild(h('p', { class: 'convo-note' }, `Couldn't load the chat: ${err.message}`));
    }
  }

  function onChatEvent(e) {
    if (!S.chat || e.id !== S.chat.id) return;
    if (e.reset || e.meta) {
      const it = findItem(`d:${e.id}`);
      if (it) loadChat(it);
      return;
    }
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

  const tokenText = (n) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString());

  function taskStatusText(t) {
    const took = duration((t.endedAt || Date.now()) - t.startedAt);
    return t.status === 'running' ? `Running for ${took}` : `${t.status.charAt(0).toUpperCase()}${t.status.slice(1)} after ${took}`;
  }

  function stopSubagent(chatId, t) {
    return run("Couldn't stop the subagent", () => api('POST', `/api/chats/${chatId}/tasks/${encodeURIComponent(t.taskId)}/stop`));
  }

  // One card per subagent; click it for the detail view.
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
      h('span', { class: `status-text ${lane} small` }, taskStatusText(t)),
      t.status === 'running' ? h('button', { type: 'button', class: 'danger small', onclick: (e) => { e.stopPropagation(); stopSubagent(chatId, t); } }, 'Stop') : null),
    stats.length ? h('div', { class: 'task-stats' }, stats.map((s) => h('span', null, s))) : null,
    t.status === 'running' && t.activity ? h('div', { class: 'task-activity' }, t.activity) : null,
    t.summary ? h('div', { class: 'task-summary clamp' }, richText(t.summary)) : null,
    h('div', { class: 'task-open faint small' }, 'Details →'));
  }

  function renderTasksPanel() {
    const panel = $('#focus-detail .tasks-panel');
    if (!panel || !S.chat) return;
    // A subagent's detail takes the list's place; Back brings the list back.
    const open = S.showTasks[S.chat.id] && !(S.agentView && S.agentView.chatId === S.chat.id);
    panel.hidden = !open;
    if (!open) return;
    const focused = document.activeElement && panel.contains(document.activeElement) ? $$('.task', panel).indexOf(document.activeElement) : -1;
    clear(panel);
    const tasks = S.chat.tasks || [];
    const running = tasks.filter((t) => t.status === 'running').length;
    panel.appendChild(h('div', { class: 'tasks-head' },
      h('h3', null, 'Subagents'),
      h('span', { class: 'faint small' }, running ? `${running} running` : 'None running'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'ghost small', onclick: () => { S.showTasks[S.chat.id] = false; renderTasksPanel(); } }, 'Hide')));
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
        clear(root).appendChild(h('div', { class: 'tasks-head' }, h('button', { type: 'button', class: 'ghost small', onclick: closeSubagent }, '← Back')));
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
    clear(root);
    root.appendChild(h('div', { class: 'tasks-head' },
      h('button', { type: 'button', class: 'ghost small', onclick: closeSubagent }, '← Back'),
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
      root.appendChild(h('details', { class: 'agent-prompt', open: t.prompt.length < 600 },
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
    if (S.chat && S.showTasks[S.chat.id] && (S.chat.tasks || []).some((t) => t.status === 'running')) renderTasksPanel();
    for (const el of $$('#focus-detail .agent-panel [data-since]')) el.textContent = `Running for ${duration(Date.now() - Number(el.dataset.since))}`;
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
    const convo = $('#focus-detail .convo');
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
  // One per tool call in a chat, by what the tool does. Claude Code's own tools by name; anything
  // else (MCP tools are named mcp__<server>__<action>) by words in its action; 🔧 otherwise.
  const TOOL_ICONS = {
    Bash: '💻', PowerShell: '💻', BashOutput: '💻', KillShell: '🛑', KillBash: '🛑', TaskStop: '🛑',
    Read: '📖', Write: '📝', Edit: '✏️', MultiEdit: '✏️', NotebookEdit: '📓', NotebookRead: '📓',
    Glob: '🗂️', Grep: '🔍', LS: '📁',
    WebFetch: '🌐', WebSearch: '🌍',
    Agent: '🤖', Task: '🤖', SendMessage: '💬', ListAgents: '🤖',
    TodoWrite: '✅', TaskCreate: '✅', TaskUpdate: '✅', TaskList: '✅', TaskGet: '✅',
    AskUserQuestion: '❓', EnterPlanMode: '🗺️', ExitPlanMode: '🗺️',
    Skill: '🧩', SlashCommand: '⌨️', ToolSearch: '🧰', Monitor: '👀',
    ScheduleWakeup: '⏰', CronCreate: '⏰', CronDelete: '⏰', CronList: '⏰',
    EnterWorktree: '🌿', ExitWorktree: '🌿', Workflow: '🔀', Artifact: '🖼️',
  };
  const TOOL_ICON_WORDS = [
    [/screenshot|snapshot|capture/, '📸'],
    [/click|hover|drag|tap/, '👆'],
    [/press_key|type_text|keyboard|\bfill|type\b/, '⌨️'],
    [/navigate|new_page|select_page|open_url|browse|goto/, '🧭'],
    [/evaluate|script|execute|exec|run/, '📜'],
    [/mail|outlook|inbox/, '📧'],
    [/calendar|event|meeting|availability/, '📅'],
    [/chat|message|teams|slack|channel/, '💬'],
    [/search|query|find|lookup/, '🔎'],
    [/delete|remove|trash|close/, '🗑️'],
    [/create|write|update|upload|edit|set|send|post/, '📝'],
    [/list|get|read|fetch|download|view/, '📖'],
    [/file|folder|drive|sharepoint|document/, '📁'],
    [/trace|performance|lighthouse|audit|heap/, '📈'],
  ];

  function toolIcon(name) {
    const n = String(name || '');
    if (TOOL_ICONS[n]) return TOOL_ICONS[n];
    const action = (n.startsWith('mcp__') ? n.split('__').slice(2).join('_') : n).toLowerCase();
    for (const [re, icon] of TOOL_ICON_WORDS) if (re.test(action)) return icon;
    return '🔧';
  }

  function chatNode(it) {
    const n = String(it.n);
    switch (it.kind) {
      case 'user': {
        // Taken back out of the queue to edit (↑): it's in the reply box now, not the conversation.
        if (it.withdrawn) return h('div', { dataset: { n }, hidden: true });
        const node = h('div', { class: `msg msg-user${it.queued ? ' queued' : ''}`, dataset: { n }, title: when(it.ts) });
        if (it.queued) node.appendChild(h('span', { class: 'msg-tag waiting', title: 'Claude reads this when it finishes what it is doing now. Press ↑ in an empty reply box to take it back and edit it.' }, 'Queued'));
        else if (it.undelivered) node.appendChild(h('span', { class: 'msg-tag ended', title: 'The chat ended before Claude read this message' }, 'Not delivered'));
        if (it.images && it.images.length) node.appendChild(h('div', { class: 'msg-images' }, it.images.map((src) => h('img', { src, alt: 'Attached image', class: 'msg-thumb' }))));
        else if (it.imageCount) node.appendChild(h('div', { class: 'faint small' }, `${it.imageCount} image${it.imageCount === 1 ? '' : 's'} attached`));
        if (it.text && it.text.trim()) node.appendChild(h('div', { class: 'msg-text' }, it.text));
        return node;
      }
      case 'assistant': {
        const div = h('div', { class: 'msg msg-assistant', dataset: { n } });
        div.appendChild(richText(it.text));
        return div;
      }
      case 'tool': {
        const state = it.result === undefined ? h('span', { class: 'tstate' }, 'running') : it.isError ? h('span', { class: 'tstate err' }, 'failed') : null;
        return h('details', { class: `msg-tool${it.isError ? ' err' : ''}`, dataset: { n } },
          h('summary', null, h('span', { class: 'ticon', 'aria-hidden': 'true' }, toolIcon(it.name)), h('span', { class: 'tname' }, it.name), it.detail ? h('span', { class: 'tdetail', title: it.detail }, it.detail) : null, state),
          h('div', { class: 'tool-body' },
            h('div', { class: 'faint small' }, 'Input'), h('pre', { class: 'code small' }, it.input),
            it.result !== undefined ? [h('div', { class: 'faint small' }, it.isError ? 'Error' : 'Result'), h('pre', { class: 'code small' }, it.result || '(empty)')] : null));
      }
      case 'permission':
        return permissionCard(it);
      case 'question':
        return questionCard(it);
      case 'note':
        return h('div', { class: 'msg-note', dataset: { n } }, it.text);
      case 'error':
        return h('div', { class: 'msg-error', dataset: { n }, role: 'alert' }, it.text);
      case 'result':
        return it.aborted || it.isError ? h('span', { dataset: { n }, hidden: true }) : h('div', { class: 'msg-result', dataset: { n } }, it.durationMs ? `Done in ${duration(it.durationMs)}` : 'Done');
      default:
        return h('span', { dataset: { n }, hidden: true });
    }
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

  function renderChat(scrollToEnd) {
    const box = $('#focus-detail .convo');
    if (!box || !S.chat) return;
    const inner = clear(box.querySelector('.convo-inner'));
    if (S.chat.past.length) {
      inner.appendChild(h('p', { class: 'convo-note' }, 'Earlier in this conversation'));
      const past = h('div', { class: 'past' });
      for (const m of S.chat.past) past.appendChild(transcriptNode(m));
      inner.appendChild(past);
      inner.appendChild(h('hr', { class: 'past-rule' }));
    }
    const items = [...S.chat.items.values()].sort((a, b) => a.n - b.n);
    if (!items.length && !S.chat.past.length) inner.appendChild(h('p', { class: 'convo-note chat-empty' }, 'Say what you want Claude to do. Replies appear here as they are written.'));
    for (const it of items) inner.appendChild(chatNode(it));
    inner.appendChild(h('div', { class: 'chat-spinner', hidden: true, 'aria-hidden': 'true' },
      h('span', { class: 'spin-glyph' }), h('span', { class: 'spin-verb' }), h('span', { class: 'spin-time faint' })));
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
    if (el) el.hidden = true;
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
    if (el.hidden) el.hidden = false;
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
      // Keep an expanded tool call expanded when its result arrives.
      if (existing.tagName === 'DETAILS' && existing.open && node.tagName === 'DETAILS') node.open = true;
      existing.replaceWith(node);
    } else {
      // New messages go above the working spinner, which stays last.
      inner.insertBefore(node, inner.querySelector('.chat-spinner'));
    }
    if (stick || item.kind === 'user') box.scrollTop = box.scrollHeight;
  }

  async function stopTurn(it) {
    const res = await run("Couldn't stop Claude", () => api('POST', `/api/chats/${it.id}/interrupt`));
    if (res) toast('Stopping…');
  }

  // Your earlier messages in the open chat, newest first, for ↑ in the reply box. Queued ones are
  // left out: ↑ takes those back out of the queue instead.
  function sentMessages() {
    if (!S.chat) return [];
    const live = [...S.chat.items.values()].filter((x) => x.kind === 'user' && !x.withdrawn && !x.queued).sort((a, b) => b.n - a.n).map((x) => x.text);
    const past = (S.chat.past || []).filter((x) => x.kind === 'user').map((x) => x.text).reverse();
    const out = [];
    for (const t of [...live, ...past]) {
      if (t && t.trim() && !/^\[\d+ images?\]$/.test(t) && out[out.length - 1] !== t) out.push(t);
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
      ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
    };
    const drawSlash = () => {
      const v = ta.value;
      const m = /^\/(\S*)$/.exec(v);
      const commands = (S.chat && S.chat.commands) || [];
      slashItems = m ? commands.filter((c) => c.name.toLowerCase().startsWith(m[1].toLowerCase())).slice(0, 8) : [];
      slashIndex = Math.min(slashIndex, Math.max(0, slashItems.length - 1));
      clear(slash);
      slash.hidden = !slashItems.length;
      slashItems.forEach((c, i) => {
        slash.appendChild(h('button', { type: 'button', class: 'slash-item', role: 'option', 'aria-selected': String(i === slashIndex), onmousedown: (e) => { e.preventDefault(); pick(i); } },
          h('span', { class: 'slash-name' }, `/${c.name}`), c.argumentHint ? h('span', { class: 'faint' }, ` ${c.argumentHint}`) : null, h('span', { class: 'slash-desc' }, c.description)));
      });
    };
    const pick = (i) => {
      const c = slashItems[i];
      if (!c) return;
      ta.value = `/${c.name} `;
      S.drafts[it.id] = ta.value;
      drawSlash();
      ta.focus();
    };
    // Attached images waiting to be sent, kept per chat so switching chats doesn't lose them.
    S.attachments[it.id] = S.attachments[it.id] || [];
    const tray = h('div', { class: 'attach-tray', hidden: true });
    const drawTray = () => {
      const list = S.attachments[it.id];
      clear(tray);
      tray.hidden = !list.length;
      list.forEach((a, i) => {
        tray.appendChild(h('div', { class: 'attach', title: `${a.name} (${Math.round(a.bytes / 1024)} KB${a.resized ? ', resized' : ''})` },
          h('img', { src: a.thumb, alt: a.name }),
          h('button', { type: 'button', class: 'attach-remove', 'aria-label': `Remove ${a.name}`, onclick: () => { list.splice(i, 1); drawTray(); } }, '×')));
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
    const onFirstLine = () => ta.selectionStart === ta.selectionEnd && !ta.value.slice(0, ta.selectionStart).includes('\n');
    const onLastLine = () => ta.selectionStart === ta.selectionEnd && !ta.value.slice(ta.selectionEnd).includes('\n');
    const browsing = () => Boolean(recall && ta.value === recall.shown);
    const recallOlder = async () => {
      if (!browsing()) {
        recall = null;
        if (hasQueued()) {
          const res = await run("Couldn't take the queued messages back", () => api('POST', `/api/chats/${it.id}/unqueue`));
          if (res && res.messages.length) {
            show(res.messages.map((m) => m.text).filter((t) => t && t.trim()).join('\n\n'));
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
        recall = { list: sentMessages(), index: -1, draft: ta.value, shown: null };
      }
      if (recall.index + 1 >= recall.list.length) return;
      recall.index++;
      recall.shown = recall.list[recall.index];
      show(recall.shown);
    };
    const recallNewer = () => {
      if (recall.index <= 0) {
        const draft = recall.draft;
        recall = null;
        show(draft);
        return;
      }
      recall.index--;
      recall.shown = recall.list[recall.index];
      show(recall.shown);
    };

    const submit = async (interrupt) => {
      recall = null;
      const text = ta.value;
      const list = S.attachments[it.id];
      if (!text.trim() && !list.length) {
        if (interrupt) stopTurn(it);
        return;
      }
      const images = list.map((a) => ({ mediaType: a.mediaType, data: a.data, thumb: a.thumb }));
      const res = await run("Couldn't send", () => api('POST', `/api/chats/${it.id}/send`, { text, images, interrupt: interrupt === true }));
      if (res) {
        ta.value = '';
        delete S.drafts[it.id];
        S.attachments[it.id] = [];
        drawTray();
        autosize();
        drawSlash();
      }
    };

    ta.addEventListener('input', () => { S.drafts[it.id] = ta.value; autosize(); drawSlash(); });
    // Ctrl+V: pasted images come in with the paste event (no permission needed).
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData ? e.clipboardData.items : [])].filter((x) => x.kind === 'file' && x.type.startsWith('image/')).map((x) => x.getAsFile()).filter(Boolean);
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });
    ta.addEventListener('keydown', (e) => {
      if (!slash.hidden) {
        if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % slashItems.length; drawSlash(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length; drawSlash(); return; }
        if (e.key === 'Tab') { e.preventDefault(); pick(slashIndex); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); slash.hidden = true; return; }
      }
      const plainKey = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing;
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
        e.preventDefault();
        submit(false);
      } else if (e.key === 'Escape' && !ta.value) {
        e.preventDefault();
        e.stopPropagation();
        backToBoard();
      }
    });
    setTimeout(autosize, 0);

    const picker = h('input', { type: 'file', accept: IMAGE_TYPES.join(','), multiple: true, hidden: true });
    picker.addEventListener('change', () => { addFiles([...picker.files]); picker.value = ''; });
    const attachBtn = h('button', { type: 'button', class: 'ghost attach-btn', title: 'Attach images (or paste with Ctrl+V or Alt+V, or drop them here)', onclick: () => picker.click() }, 'Image');
    const sendBtn = h('button', { type: 'button', class: 'primary send-btn', onclick: () => submit(false) }, 'Send');
    const interruptBtn = h('button', { type: 'button', class: 'danger interrupt-btn', hidden: true, onclick: () => submit(true), title: 'Stop what Claude is doing and send your message now' }, 'Interrupt');
    const ended = h('div', { class: 'composer-ended', hidden: true },
      h('span', null, 'This chat has ended.'),
      h('button', { type: 'button', class: 'primary small', onclick: () => resumeChat(it) }, 'Resume'));
    const box = h('div', { class: 'composer', dataset: { chat: it.id } },
      slash,
      ended,
      tray,
      h('div', { class: 'composer-row' }, ta, h('div', { class: 'composer-buttons' }, attachBtn, sendBtn, interruptBtn), picker),
      h('div', { class: 'composer-hint' }, 'Enter sends. Shift+Enter adds a line. Type / for commands. Ctrl+V or Alt+V pastes an image. Esc goes back to the board.'));
    // Drop images anywhere on the reply box.
    box.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); box.classList.add('dropping'); } });
    box.addEventListener('dragleave', () => box.classList.remove('dropping'));
    box.addEventListener('drop', (e) => {
      box.classList.remove('dropping');
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    drawTray();
    return box;
  }

  function updateComposer(it) {
    const c = $('#focus-detail .composer');
    if (!c) return;
    const exited = it.state === 'exited';
    const busy = it.status === 'busy';
    c.querySelector('.composer-ended').hidden = !exited;
    c.querySelector('.composer-input').disabled = exited;
    c.querySelector('.attach-btn').disabled = exited;
    // While Claude works, Enter queues and the button interrupts.
    c.querySelector('.send-btn').hidden = busy;
    c.querySelector('.send-btn').disabled = exited;
    c.querySelector('.interrupt-btn').hidden = !busy;
    c.querySelector('.composer-hint').textContent = composerHint(busy);
  }

  function composerHint(busy) {
    if (hasQueued()) return 'Claude is working. Your queued messages go when it finishes this step. Press ↑ to take them back and edit them.';
    if (busy) return 'Claude is working. Enter queues your message for when it finishes this step. Interrupt stops it and sends your message now.';
    return 'Enter sends. Shift+Enter adds a line. ↑ recalls your last message. / for commands. Ctrl+V or Alt+V pastes an image. Esc goes back.';
  }

  // ---- images --------------------------------------------------------------------------------
  // Types and size the Messages API accepts; bigger images are scaled down before sending.
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024; // 5 MB once base64-encoded
  const MAX_IMAGE_SIDE = 2000;

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('That image could not be read.'));
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

  function renderSessions() {
    renderSummary();
    $$('.seg [data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === S.layout)));
    $('#board').hidden = S.layout !== 'board';
    $('#focus').hidden = S.layout !== 'focus';
    if (S.layout === 'board') renderBoard();
    else renderFocus();
  }

  function select(key) {
    S.selected = key;
    if (S.layout === 'board') {
      $$('#board .card').forEach((c) => c.classList.toggle('selected', c.dataset.key === key));
    } else {
      renderFocus();
    }
  }

  function showDetails(key) {
    S.selected = key;
    setLayout('focus');
  }

  function setLayout(layout) {
    S.layout = layout;
    store.set('layout', layout);
    renderSessions();
  }

  // ---- Chrome-style tab keys -----------------------------------------------------------------
  // Ctrl+Tab / Ctrl+Shift+Tab step through the sessions in list order, wrapping at the ends;
  // Ctrl+W ends the selected chat, and removes it once it has ended (then selects its neighbor).
  function focusSelected(it) {
    if (S.layout === 'focus' && isChat(it)) {
      const ta = $('#focus-detail .composer-input');
      if (ta && !ta.disabled) { ta.focus(); return; }
    }
    const el = document.querySelector(`${S.layout === 'board' ? '#board' : '#focus-list'} [data-key="${CSS.escape(it.key)}"]`);
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
    if (!isChat(it)) {
      toast('Ctrl+W ends in-app chats. For this session, use End session.');
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
    const el = document.querySelector(`${S.layout === 'board' ? '#board' : '#focus-list'} [data-key="${CSS.escape(flat[i].key)}"]`);
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
      h('span', { class: 'ufill', style: { width: `${Math.min(100, Math.max(0, l.percent))}%` } }));
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
    const showing = S.view === 'sessions' && S.layout === 'focus' && S.selected === `d:${n.id}` && document.hasFocus();
    if (!showing) toast(text, n.kind === 'waiting' ? 'waiting' : 'info', { label: isChat(it) ? 'Open chat' : 'Open terminal', run: () => openSession(it) });
    const wanted = n.kind === 'waiting' ? S.prefs.notifyOnWaiting : S.prefs.notifyOnFinished;
    if (!wanted) return;
    if (S.prefs.notifySound && !showing) chime(n.kind);
    if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
      const note = new Notification(text, { body: isChat(it) ? 'Click to open the chat.' : 'Click to open its terminal.', tag: `${n.id}:${n.kind}`, silent: true });
      note.onclick = () => { window.focus(); openSession(it); note.close(); };
    }
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
    L.model = Deck.modelPicker(S.boot.enums.models, value || '', () => onLaunchChange(), 'From your settings');
    clear($('#l-model')).appendChild(L.model);
  }

  function applyLaunchOptions(o) {
    if (o.cwd) $('#l-cwd').value = o.cwd;
    $('#l-name').value = o.name || '';
    $$('input[name="l-mode"]').forEach((r) => { r.checked = r.value === (o.mode === 'continue' ? 'continue' : 'new'); });
    if (o.where) $$('input[name="l-where"]').forEach((r) => { r.checked = r.value === o.where; });
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
      }, `${f.pinned ? '★ ' : ''}${shortPath(f.path)}`));
    }
    for (const f of [...S.prefs.favorites, ...S.folders.recent.map((r) => r.path)]) list.appendChild(h('option', { value: f }));
  }

  function onLaunchChange() {
    $('#l-star').textContent = isFavorite($('#l-cwd').value.trim()) ? '★' : '☆';
    $('#l-worktree-name').disabled = !$('#l-worktree').checked;
    const where = launchWhere();
    $('#l-go').textContent = where === 'chat' ? 'Start chat' : 'Open in terminal';
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      try {
        const opts = launchOptions();
        const { command } = await api('POST', '/api/preview-command', where === 'chat' ? { ...opts, prompt: '' } : opts);
        $('#l-preview').textContent = where === 'chat' ? `${command}  (plus Claude Deck's streaming flags; the first prompt is sent as a message)` : command;
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
    applyLaunchOptions({ cwd: store.get('lastCwd', S.prefs.defaultFolder), color: 'slate', where: store.get('launchWhere', 'chat'), ...(prefill || {}) });
    $('#l-prompt').value = '';
    renderFolderChips();
    dlg.showModal();
    $('#l-cwd').focus();
    $('#l-cwd').select();
  }

  async function submitLaunch(e) {
    e.preventDefault();
    const btn = $('#l-go');
    btn.disabled = true;
    $('#l-error').hidden = true;
    try {
      const o = launchOptions();
      const where = launchWhere();
      const res = await api('POST', where === 'chat' ? '/api/chats' : '/api/launch', o);
      store.set('lastCwd', o.cwd);
      store.set('launchWhere', where);
      $('#dlg-launch').close();
      if (where === 'chat') openChat(res.id, !o.prompt.trim());
      else toast('Session started in Windows Terminal');
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
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) submitLaunch(e);
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

  function historyFiltered() {
    const q = $('#history-search').value.trim();
    const folder = $('#history-folder').value;
    const list = S.history.sessions.filter((m) => (!folder || (m.cwd || '').toLowerCase() === folder)
      && matches([m.title, m.firstPrompt, m.lastPrompt, m.cwd, m.sessionId, m.gitBranch, m.tag], q));
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
      if (!m.cwd) continue;
      const k = m.cwd.toLowerCase();
      const c = counts.get(k) || { path: m.cwd, n: 0 };
      c.n++;
      counts.set(k, c);
    }
    clear(sel);
    sel.appendChild(h('option', { value: '' }, 'All folders'));
    for (const [k, c] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n)) {
      sel.appendChild(h('option', { value: k, selected: k === current, title: c.path }, `${shortPath(c.path)} (${c.n})`));
    }
  }

  function renderHistory() {
    renderHistoryFolders();
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
      const open = live.has(m.sessionId);
      list.appendChild(h('div', { class: 'h-item' },
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
          h('span', { class: 'path', title: m.cwd || '' }, shortPath(m.cwd)),
          h('span', null, `${m.userTurns} prompt${m.userTurns === 1 ? '' : 's'}`),
          m.costUSD ? h('span', null, money(m.costUSD)) : null)),
        h('button', {
          type: 'button',
          class: 'ghost icon h-del',
          disabled: open,
          title: open ? 'Open right now. End or close it first, then delete it.' : 'Delete this conversation',
          'aria-label': `Delete ${m.title || 'this conversation'}`,
          onclick: () => deleteConversation(m),
        }, trashIcon())));
    }
    if (rows.length > S.historyLimit) {
      list.appendChild(h('button', { class: 'ghost h-more', onclick: () => { S.historyLimit += 200; renderHistory(); } }, `Show ${Math.min(200, rows.length - S.historyLimit)} more`));
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
    S.history = { ...S.history, sessions: res.sessions, live: res.live };
    renderHistory();
    const nextRow = next && $(`#history-list .h-row[data-sid="${next.sessionId}"]`);
    if (nextRow) nextRow.focus();
    const title = m.title || 'Untitled conversation';
    toast(`Deleted "${title.length > 60 ? `${title.slice(0, 60)}…` : title}"`, 'info', { label: 'Undo', ms: 10000, run: () => undoDelete(res.trashId) });
  }

  async function undoDelete(trashId) {
    const res = await run("Couldn't put the conversation back", () => api('POST', '/api/history/restore', { trashId }));
    if (!res) return;
    S.history = { ...S.history, sessions: res.sessions, live: res.live };
    S.historySel = res.sessionId;
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
      live ? h('div', { class: 'card-status' }, h('span', { class: 'lamp working' }), h('span', { class: 'status-text working' }, 'Open right now')) : null,
      h('h2', null, m.title || 'Untitled conversation'),
      m.firstPrompt && m.firstPrompt !== m.title ? h('div', { class: 'muted card-prompt' }, m.firstPrompt) : null,
      h('dl', { class: 'facts' },
        fact('Folder', m.cwd, true),
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
        m.prUrl ? h('a', { href: m.prUrl, target: '_blank', rel: 'noopener', class: 'small', style: { alignSelf: 'center' } }, 'Linked pull request') : null)));
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
        body: 'Resuming it a second time makes the two copies drift apart. Fork a copy instead, so each has its own conversation. To move it here instead, use Continue here on its card.',
        ok: 'Fork a copy',
      });
      if (!ok) return;
      fork = true;
    }
    const res = await run("Couldn't resume", () => api('POST', '/api/history/resume', { sessionId: m.sessionId, fork, target }));
    if (!res) return;
    if (target === 'terminal') toast(fork ? 'Forked into a new tab' : 'Resumed in a new tab');
    else openChat(res.id);
  }

  // ---- palette -------------------------------------------------------------------------------
  let paletteItems = [];
  let paletteIndex = 0;

  function paletteCommands() {
    return [
      { kind: 'Command', text: 'New session', run: () => openLaunch() },
      { kind: 'Command', text: 'Show sessions as a board', run: () => { setView('sessions'); setLayout('board'); } },
      { kind: 'Command', text: 'Focus on one session', run: () => { setView('sessions'); setLayout('focus'); } },
      { kind: 'Command', text: 'Open history', run: () => setView('history') },
      { kind: 'Command', text: 'Edit Claude Code settings', run: () => setView('settings') },
      { kind: 'Command', text: 'Open preferences', run: () => setView('prefs') },
      { kind: 'Command', text: 'Show keyboard shortcuts', run: () => $('#dlg-keys').showModal() },
    ];
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
        out.push({ kind: 'History', text: m.title || 'Untitled conversation', sub: `${shortPath(m.cwd)}  ${ago(m.updatedAt)}`, run: () => { setView('history'); S.historySel = m.sessionId; renderHistory(); } });
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
        h('small', { class: 'faint' }, 'Stop server now (under Dashboard) still stops it until you next sign in or start Claude Deck yourself.')));
    }).catch((err) => { clear(body).appendChild(h('small', { class: 'faint' }, `Couldn't check the app status: ${err.message}`)); });
    return section;
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
        detected)));

    const nameInput = h('input', { type: 'text', value: p.windowName });
    const profileInput = h('input', { type: 'text', value: p.wtProfile, placeholder: 'Your default profile' });
    root.appendChild(h('section', { class: 'pref-section' },
      h('h2', null, 'Windows Terminal'),
      h('p', null, 'Used for sessions you choose to run in a terminal. Open terminal on a card switches to its tab.'),
      prefRow('Windows', null,
        h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'p-wm', checked: p.windowMode === 'single', onchange: () => savePrefs({ windowMode: 'single' }) }), 'One window, a tab per session'),
        h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'p-wm', checked: p.windowMode === 'perSession', onchange: () => savePrefs({ windowMode: 'perSession' }) }), 'A separate window per session'),
        h('small', { class: 'faint' }, 'With one window, keep the tabs in the order Claude Deck opened them. Dragging tabs around, or opening other tabs in that window, makes Open terminal land on the wrong tab.')),
      prefRow('Window name', 'Only used for the shared window', h('div', { class: 'row' }, nameInput, h('button', { class: 'ghost', onclick: () => savePrefs({ windowName: nameInput.value.trim() }) }, 'Save'))),
      prefRow('Terminal profile', 'Font, colors and so on come from this profile', h('div', { class: 'row' }, profileInput, h('button', { class: 'ghost', onclick: () => savePrefs({ wtProfile: profileInput.value.trim() }) }, 'Save')))));

    const folderInput = h('input', { type: 'text', value: p.defaultFolder, spellcheck: 'false' });
    const favList = h('div', { class: 'pc' }, p.favorites.length ? p.favorites.map((f) => h('div', { class: 'fav' }, h('span', null, f), h('button', { class: 'ghost small', onclick: async () => { await toggleFavorite(f); renderPrefs(); } }, 'Unpin'))) : h('small', { class: 'faint' }, 'Pin folders with the star in the New session window.'));
    const presetList = h('div', { class: 'pc' }, p.presets.length ? p.presets.map((pr) => h('div', { class: 'fav' }, h('span', null, pr.name), h('button', { class: 'ghost small', onclick: async () => { await savePrefs({ presets: S.prefs.presets.filter((x) => x.name !== pr.name) }, true); renderPrefs(); } }, 'Delete'))) : h('small', { class: 'faint' }, 'Save a preset from the New session window.'));
    root.appendChild(h('section', { class: 'pref-section' },
      h('h2', null, 'New sessions'),
      prefRow('Default folder', 'Used until you start a session somewhere else',
        h('div', { class: 'row' }, folderInput,
          h('button', { class: 'ghost', onclick: async () => { const picked = await pickFolder(folderInput.value); if (picked) folderInput.value = picked; } }, 'Browse…'),
          h('button', { class: 'ghost', onclick: () => savePrefs({ defaultFolder: folderInput.value.trim() }) }, 'Save'))),
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
          themes.map(([v, t]) => h('option', { value: v, selected: p.theme === v }, t))))))));

    root.appendChild(h('section', { class: 'pref-section' },
      h('h2', null, 'Dashboard'),
      prefRow('Other terminals', null, toggle('showExternal', 'Show Claude sessions started outside Claude Deck')),
      prefRow('Background server', 'Chats run inside the server; terminal sessions keep running either way', toggle('stopWhenClosed', 'Stop the local server 90 seconds after this window closes, unless a chat is still running'),
        h('div', { class: 'row' }, h('button', { class: 'danger', onclick: async () => { if (await Deck.confirm({ title: 'Stop the Claude Deck server?', body: 'Chats end (resume them from History later). Terminal sessions keep running. Start Claude Deck again to reconnect.', ok: 'Stop server', danger: true })) api('POST', '/api/shutdown').catch(() => {}); } }, 'Stop server now'))),
      prefRow('Data folder', 'Preferences, settings backups and the history cache', h('div', { class: 'row' }, h('code', { style: { overflowWrap: 'anywhere', flex: '1' } }, S.boot.dataDir), h('button', { class: 'ghost', onclick: () => openFolder(S.boot.dataDir) }, 'Open'))),
      prefRow('Version', 'The version the server was started from', h('div', { class: 'row' }, h('span', null, `Claude Deck ${S.boot.version}`), h('a', { href: 'https://github.com/BPT-CIPP/Claude-Deck/releases', target: '_blank', rel: 'noopener', class: 'small' }, 'Release notes')))));
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
    es.addEventListener('open', () => {
      setConn(true);
      // After a reconnect, reload the open chat in case events were missed.
      if (wasDown && S.chat) { const it = findItem(`d:${S.chat.id}`); if (it) loadChat(it); }
      wasDown = false;
    });
    es.addEventListener('error', () => { setConn(false); wasDown = true; });
  }

  function onKey(e) {
    const t = e.target;
    const typing = t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]');
    const key = e.key.toLowerCase();
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
    // Enter on an ended chat resumes it: from its list row or board card, or with nothing focused
    // (its reply box is greyed out, so focus falls back to the page). Other buttons keep their Enter.
    if (key === 'enter' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && S.view === 'sessions' && S.selected && !document.querySelector('dialog[open]')) {
      const it = findItem(S.selected);
      const onIt = !t || t === document.body || t.disabled || (t.dataset && t.dataset.key === S.selected);
      if (it && isChat(it) && it.state === 'exited' && onIt) { e.preventDefault(); resumeAndFocus(it); return; }
    }
    if (typing || e.ctrlKey || e.altKey || e.metaKey || document.querySelector('dialog[open]')) return;
    if (key === 'escape' && S.view === 'sessions' && S.layout === 'focus') { e.preventDefault(); backToBoard(); }
    else if (key === 'n') { e.preventDefault(); openLaunch(); }
    else if (key === 'f' && S.view === 'sessions') { e.preventDefault(); setLayout(S.layout === 'board' ? 'focus' : 'board'); }
    else if (e.key === '/') {
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
    const isCollapsed = Boolean(store.get('rail-collapsed', false));
    if (isCollapsed) app.classList.add('rail-collapsed');

    function toggleRail() {
      const next = !app.classList.contains('rail-collapsed');
      app.classList.toggle('rail-collapsed', next);
      store.set('rail-collapsed', next);
    }

    if (toggleBtn) toggleBtn.addEventListener('click', toggleRail);
    S.toggleRail = toggleRail;
  }

  function wireFocusSplitter() {
    const splitter = $('#focus-splitter');
    const focusEl = $('#focus');
    if (!splitter || !focusEl) return;

    let savedW = store.get('focus-sidebar-width', 290);
    if (typeof savedW !== 'number' || savedW < 200 || savedW > 600) savedW = 290;
    focusEl.style.setProperty('--focus-sidebar-w', `${savedW}px`);

    let dragging = false;
    let startX = 0;
    let startW = savedW;

    splitter.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      const current = parseInt(getComputedStyle(focusEl).getPropertyValue('--focus-sidebar-w'), 10) || 290;
      startW = current;
      splitter.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      const newW = Math.max(220, Math.min(500, startW + delta));
      focusEl.style.setProperty('--focus-sidebar-w', `${newW}px`);
      store.set('focus-sidebar-width', newW);
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
      focusEl.style.setProperty('--focus-sidebar-w', '290px');
      store.set('focus-sidebar-width', 290);
    });

    splitter.addEventListener('keydown', (e) => {
      const current = parseInt(getComputedStyle(focusEl).getPropertyValue('--focus-sidebar-w'), 10) || 290;
      if (e.key === 'ArrowLeft') {
        const next = Math.max(220, current - 15);
        focusEl.style.setProperty('--focus-sidebar-w', `${next}px`);
        store.set('focus-sidebar-width', next);
      } else if (e.key === 'ArrowRight') {
        const next = Math.min(500, current + 15);
        focusEl.style.setProperty('--focus-sidebar-w', `${next}px`);
        store.set('focus-sidebar-width', next);
      }
    });
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

    $$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $$('.seg [data-layout]').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));
    $('#btn-new').addEventListener('click', () => openLaunch());
    $('#session-filter').addEventListener('input', (e) => { S.filter = e.target.value.trim(); renderSessions(); });
    $('#history-search').addEventListener('input', () => { S.historyLimit = 150; renderHistory(); });
    $('#history-folder').addEventListener('change', () => { S.historyLimit = 150; renderHistory(); });
    $('#history-sort').addEventListener('change', () => renderHistory());
    $('#btn-rescan').addEventListener('click', async () => {
      const data = await run("Couldn't rescan", () => api('POST', '/api/history/rebuild'));
      if (data) { S.history = { ...data, loaded: true }; renderHistory(); toast('History rescanned'); }
    });
    $('#btn-enable-notif').addEventListener('click', async () => { await Notification.requestPermission(); updateNotifBanner(); });
    $('#btn-dismiss-notif').addEventListener('click', () => { store.set('notifDismissed', true); updateNotifBanner(); });
    document.addEventListener('keydown', onKey);
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
    wireFocusSplitter();
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
    // Keep "for 3m" style labels fresh.
    setInterval(() => { if (S.view === 'sessions' && !document.hidden) { renderSessions(); renderUsage(); } }, 30000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
