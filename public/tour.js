'use strict';
// The guided tour: a first-launch walk through the page for someone who has never used Claude Code.
// Each step lights up one part of the page (a cutout in a dimmed cover) with a card beside it.
// Steps whose part isn't on screen (no chat open, say) are skipped if optional, otherwise the card
// sits in the middle. app.js starts it on first launch; Preferences and Ctrl+K start it again.
// Kept apart from app.js so test/tour.test.js can check the steps without a page.
//
// Step: { target?: CSS selector, optional?: true, title, body: [paragraph strings] }

(function () {
  const STEPS = [
    {
      title: 'Welcome to Claude Deck',
      body: [
        'Claude Code is Claude working in a folder on your PC: it reads your files, edits them and runs commands to get a job done, and it asks you before it changes anything.',
        'Claude Deck is where you run it, talk to it and keep an eye on it. This tour takes about two minutes. Use the arrow keys or the buttons, and Esc to leave.',
      ],
    },
    {
      target: '#btn-new',
      title: 'Start a session',
      body: [
        'Everything starts here. Choose the folder you want Claude to work in, such as a project or a folder of scripts. Claude only works inside the folder you pick.',
        'Leave Run it on "Here in Claude Deck" to chat with Claude in this window. You can type your first request now or after it starts.',
      ],
    },
    {
      target: '.track',
      title: 'Your sessions',
      body: [
        'Every session you start is listed here, so you can run several at once and switch between them.',
        'The light beside each one says what it\'s doing: flashing amber means it needs you, white means it\'s working, green means it\'s finished and waiting, and unlit means it has ended.',
      ],
    },
    {
      target: '#btn-rail-toggle',
      title: 'Make room',
      body: ['This button (or Ctrl+B) narrows the list to just its lights, to give the conversation more space. Click it again to widen it.'],
    },
    {
      target: '#focus-detail',
      title: 'The conversation',
      body: [
        'The selected session\'s conversation fills this side. Type in the box at the bottom and press Enter to send; Shift+Enter adds a new line.',
        'When Claude wants to edit a file or run a command, it stops and asks you here. Read what it wants to do, then allow it or say no. You can type while it works; your message waits its turn.',
      ],
    },
    {
      target: '#focus-detail .facts',
      optional: true,
      title: 'Session controls',
      body: [
        'Model picks which Claude does the work. Effort sets how hard it thinks before answering. Permissions sets how often it asks first: "default" asks before every edit or command, which is the safe place to start.',
        'Context shows how much of Claude\'s working memory this conversation has used. Compact summarizes it to free up room on long jobs.',
      ],
    },
    {
      target: '#usage',
      title: 'Plan usage',
      body: ['Claude Code uses your Claude plan, which has limits per session and per week. This shows how much you\'ve used and when it resets. Click it for details.'],
    },
    {
      target: '#btn-palette',
      title: 'Search everything',
      body: ['Ctrl+K finds any session, past conversation or command by typing a few letters. Press ? anywhere (outside a text box) for the list of keyboard shortcuts.'],
    },
    {
      target: '.nav-item[data-view="history"]',
      title: 'History',
      body: ['Every past conversation, including ones from Claude Code in a terminal. Read them, search them, and pick any of them up where you left off.'],
    },
    {
      target: '.nav-item[data-view="settings"]',
      title: 'Claude Code settings',
      body: ['Claude Code\'s own settings, such as which commands it may run without asking. You can leave these alone to begin with; Claude Deck backs up a file before saving it.'],
    },
    {
      target: '.nav-item[data-view="prefs"]',
      title: 'Claude Deck preferences',
      body: ['How Claude Deck itself looks and behaves: themes, fonts, notifications, starting with Windows and installing it as a taskbar app. You can take this tour again from here.'],
    },
    {
      title: 'Try it',
      body: [
        'Click New session, choose a folder you know, and ask something like "What is in this folder, and what does it do?" Claude only reads to answer that, so it\'s a safe first request.',
        'Then ask it for a small change and watch it ask before it edits.',
      ],
    },
  ];

  const Deck = (window.Deck = window.Deck || {});

  function visibleBox(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  // onDone(finished): finished is true when the last step was reached, false when left early.
  function start({ onDone } = {}) {
    if (document.querySelector('.tour')) return;
    const h = Deck.h;
    const steps = STEPS.filter((s) => !s.optional || visibleBox(document.querySelector(s.target)));
    let at = 0;
    const back = document.activeElement;

    const cutout = h('div', { class: 'tour-cutout', 'aria-hidden': 'true' });
    const count = h('span', { class: 'tour-count' });
    const title = h('h2', { class: 'tour-title', id: 'tour-title' });
    const body = h('div', { class: 'tour-body' });
    const prevBtn = h('button', { type: 'button', class: 'ghost', onclick: () => go(at - 1) }, 'Back');
    const nextBtn = h('button', { type: 'button', class: 'primary', onclick: () => go(at + 1) });
    const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' },
      h('div', { class: 'tour-head' }, title, count),
      body,
      h('div', { class: 'tour-actions' },
        h('button', { type: 'button', class: 'ghost tour-skip', onclick: () => end(false) }, 'Skip tour'),
        h('span', { class: 'spacer' }),
        prevBtn, nextBtn));
    // The cover takes every click, so the page underneath can't change mid-step.
    const root = h('div', { class: 'tour' }, h('div', { class: 'tour-cover' }), cutout, card);

    function place() {
      const step = steps[at];
      const r = step.target ? visibleBox(document.querySelector(step.target)) : null;
      root.classList.toggle('tour-centered', !r);
      const pad = 6;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      if (!r) {
        // Nothing lit: the cutout shrinks to the middle (app.css), so drop the last step's box.
        cutout.removeAttribute('style');
        card.style.left = `${Math.round((vw - cw) / 2)}px`;
        card.style.top = `${Math.round(Math.max(16, (vh - ch) / 2))}px`;
        return;
      }
      const box = { left: Math.max(4, r.left - pad), top: Math.max(4, r.top - pad), right: Math.min(vw - 4, r.right + pad), bottom: Math.min(vh - 4, r.bottom + pad) };
      Object.assign(cutout.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` });
      // Below the part if it fits, else above, else beside it (right, then left). In a small window
      // with room nowhere, on the roomier side, against the window's edge, covering as little as it can.
      const gap = 12;
      const clampX = (x) => Math.max(12, Math.min(x, vw - cw - 12));
      const clampY = (y) => Math.max(12, Math.min(y, vh - ch - 12));
      let left;
      let top;
      if (box.bottom + gap + ch <= vh - 12) { top = box.bottom + gap; left = clampX(box.left); }
      else if (box.top - gap - ch >= 12) { top = box.top - gap - ch; left = clampX(box.left); }
      else if (box.right + gap + cw <= vw - 12) { left = box.right + gap; top = clampY(box.top); }
      else if (box.left - gap - cw >= 12) { left = box.left - gap - cw; top = clampY(box.top); }
      else { left = clampX(box.left); top = vh - box.bottom >= box.top ? clampY(vh - ch - 12) : 12; }
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
    }

    function go(n) {
      if (n >= steps.length) { end(true); return; }
      at = Math.max(0, n);
      const step = steps[at];
      title.textContent = step.title;
      count.textContent = `${at + 1} of ${steps.length}`;
      Deck.clear(body).append(...step.body.map((p) => h('p', null, p)));
      prevBtn.hidden = at === 0;
      nextBtn.textContent = at === steps.length - 1 ? 'Done' : 'Next';
      place();
      nextBtn.focus();
    }

    function onKey(e) {
      // Everything else waits while the tour is up, so a shortcut can't change the page under it.
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); end(false); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(at + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(at - 1); }
      else if (e.key === 'Tab') {
        // Focus stays in the card.
        const items = [...card.querySelectorAll('button:not([hidden])')];
        const i = items.indexOf(document.activeElement);
        e.preventDefault();
        items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      } else if (!(e.key === 'Enter' || e.key === ' ') || !card.contains(e.target)) e.preventDefault();
    }

    function end(finished) {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      root.remove();
      if (back && back.isConnected && typeof back.focus === 'function') back.focus();
      if (onDone) onDone(finished);
    }

    document.body.appendChild(root);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    go(0);
  }

  Deck.tour = { STEPS, start };
})();
