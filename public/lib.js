'use strict';
// Shared helpers for the dashboard. Everything hangs off window.Deck.

(function () {
  const Deck = (window.Deck = window.Deck || {});

  // ---- token + API ---------------------------------------------------------------------------
  // A token in the address (?t=, from the server's own link) replaces the saved one only once the
  // server accepts it: any web page can open this address with a made-up token, and saving that
  // would lock the installed app out. A rejected one is dropped and the page reloads with the saved one.
  function takeToken() {
    const url = new URL(location.href);
    let token = url.searchParams.get('t');
    if (token) {
      url.searchParams.delete('t');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      const offered = token;
      fetch('/api/ping', { headers: { 'x-deck-token': offered } }).then((res) => {
        if (res.ok) {
          try { localStorage.setItem('deck-token', offered); } catch { /* storage unavailable */ }
        } else if (res.status === 401) {
          location.reload();
        }
      }).catch(() => { /* server not reachable; nothing to decide */ });
    } else {
      try { token = localStorage.getItem('deck-token'); } catch { token = null; }
    }
    return token || '';
  }
  Deck.token = takeToken();

  Deck.api = async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'x-deck-token': Deck.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      if (data && typeof data.command === 'string') err.command = data.command;
      throw err;
    }
    return data;
  };

  // ---- DOM -----------------------------------------------------------------------------------
  // h('div', { class: 'x', onclick: fn, dataset: { k: 'v' } }, 'text', child, [more])
  Deck.h = function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style' && typeof v === 'object') {
          for (const [prop, val] of Object.entries(v)) {
            if (prop.startsWith('--')) el.style.setProperty(prop, val);
            else el.style[prop] = val;
          }
        }
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden' || k === 'open') el[k] = Boolean(v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, children);
    return el;
  };

  function append(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }

  // Drawn icons, one stroke weight, in the text color: Deck.icon('copy'). Built as SVG elements
  // (never innerHTML). 16x16 grid, 1.5px stroke.
  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
    open: 'M9 3h4v4M13 3L7.5 8.5M11 9.5v3.5h-8v-8h3.5',
    down: 'M4 6.5l4 4 4-4',
    right: 'M6.5 4l4 4-4 4',
    check: 'M3.5 8.5l3 3 6-7',
    close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
    star: 'M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.2 4.6 13l.7-3.8-2.8-2.7 3.8-.5z',
    up: 'M8 13V3.5M4 7.5l4-4 4 4',
    branch: 'M5 2.5v11M5 10h2.5A3.5 3.5 0 0 0 11 6.5v-4',
    bars: 'M3 13V9M6.5 13V5M10 13V7.5M13.5 13V3',
    panel: 'M2.5 3.5h11v9h-11zM6 3.5v9',
    left: 'M9.5 4l-4 4 4 4',
    // Tool calls (Preferences > Appearance > Tool calls)
    terminal: 'M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5',
    file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
    pen: 'M10.5 3l2.5 2.5-7 7H3.5V10z',
    folder: 'M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z',
    search: 'M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 10l3.5 3.5',
    globe: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11',
    agent: 'M4 5.5h8v6.5H4zM8 3v2.5M6.5 8.5v.5M9.5 8.5v.5',
    list: 'M6 4.5h7.5M6 8h7.5M6 11.5h7.5M3 4.5h.5M3 8h.5M3 11.5h.5',
    question: 'M6 6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5M8 12v.2',
    clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5',
    stop: 'M4.5 4.5h7v7h-7z',
    plug: 'M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2',
    pointer: 'M4 3l8 4.5-3.5 1 2 3.5-1.5.8-2-3.5-3 2.2z',
  };
  Deck.icon = function icon(name, { size = 14, filled = false, label = null } = {}) {
    const svg = document.createElementNS(SVG, 'svg');
    const attrs = { viewBox: '0 0 16 16', width: String(size), height: String(size), fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: `ico ico-${name}` };
    if (label) { attrs.role = 'img'; attrs['aria-label'] = label; } else attrs['aria-hidden'] = 'true';
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', ICONS[name] || '');
    svg.appendChild(p);
    return svg;
  };

  Deck.$ = (sel, root = document) => root.querySelector(sel);
  Deck.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  Deck.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  // ---- formatting ----------------------------------------------------------------------------
  Deck.ago = function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
    return new Date(ts).toLocaleDateString();
  };

  Deck.when = function when(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  };

  Deck.dayGroup = function dayGroup(ts) {
    if (!ts) return 'Undated';
    const d = new Date(ts);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const diff = (start - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return 'This week';
    if (diff < 31) return 'This month';
    return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
  };

  Deck.money = (v) => (typeof v === 'number' ? `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}` : '');

  // "C:\Users\me\Documents\Claude\Powershell\Utilities" -> "Powershell\Utilities"
  Deck.shortPath = function shortPath(p, parts = 2) {
    if (!p) return '';
    const segs = p.split(/[\\/]+/).filter(Boolean);
    return segs.length <= parts ? p : segs.slice(-parts).join('\\');
  };

  Deck.copy = async function copy(text, what = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      Deck.toast(what);
    } catch {
      Deck.toast('Copy failed: the clipboard is not available here.', 'error');
    }
  };

  // ---- toasts --------------------------------------------------------------------------------
  // action: { label, run, ms? }. ms keeps the toast up longer, for an Undo worth having time for.
  Deck.toast = function toast(message, kind = 'info', action) {
    const host = document.getElementById('toasts');
    const el = Deck.h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      Deck.h('span', null, message),
      action ? Deck.h('button', { class: 'link', onclick: () => { action.run(); el.remove(); } }, action.label) : null);
    host.appendChild(el);
    const life = (action && action.ms) || (kind === 'error' ? 7000 : 4000);
    setTimeout(() => el.classList.add('leaving'), life);
    setTimeout(() => el.remove(), life + 400);
  };

  // Plain-text rendering with fenced code blocks, inline code and bold. Builds nodes, never HTML.
  Deck.richText = function richText(text) {
    const frag = document.createDocumentFragment();
    const str = String(text);
    // Any language name (c++, objective-c), and Windows line endings after it.
    const regex = /```([^\s`]*)[ \t]*\r?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    function addProse(chunk) {
      if (!chunk) return;
      const p = Deck.h('div', { class: 'prose' });
      const tokens = chunk.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/);
      for (const t of tokens) {
        if (!t) continue;
        if (t.startsWith('`') && t.endsWith('`') && t.length > 2) p.appendChild(Deck.h('code', null, t.slice(1, -1)));
        else if (t.startsWith('**') && t.endsWith('**') && t.length > 4) p.appendChild(Deck.h('strong', null, t.slice(2, -2)));
        else p.appendChild(document.createTextNode(t));
      }
      frag.appendChild(p);
    }

    while ((match = regex.exec(str)) !== null) {
      if (match.index > lastIndex) {
        addProse(str.slice(lastIndex, match.index));
      }
      const lang = match[1] || 'code';
      const code = match[2].replace(/\r?\n$/, '');
      const copyBtn = Deck.h('button', { class: 'code-block-copy', title: 'Copy code' }, 'Copy');
      copyBtn.addEventListener('click', async () => {
        await Deck.copy(code, 'Code copied');
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
      });
      const block = Deck.h('div', { class: 'code-block-wrap' },
        Deck.h('div', { class: 'code-block-head' },
          Deck.h('span', { class: 'lang-tag' }, lang),
          copyBtn),
        Deck.h('pre', { class: 'code' }, code));
      frag.appendChild(block);
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < str.length) {
      const rest = str.slice(lastIndex);
      const unclosed = rest.match(/```([^\s`]*)[ \t]*\r?\n?([\s\S]*)$/);
      if (unclosed && unclosed.index === 0) {
        const lang = unclosed[1] || 'code';
        const code = unclosed[2];
        const block = Deck.h('div', { class: 'code-block-wrap' },
          Deck.h('div', { class: 'code-block-head' }, Deck.h('span', { class: 'lang-tag' }, lang)),
          Deck.h('pre', { class: 'code' }, code));
        frag.appendChild(block);
      } else {
        addProse(rest);
      }
    }
    return frag;
  };

  // Model picker: a button that opens a menu with a flyout for each model family (Sonnet ▸ Sonnet
  // 5.5, Sonnet 5.5 · 1M context, ...), like a Windows context menu, plus "Other model ID…" for any
  // other ID. catalog is the server's model menu ({ families, extras }, src/models.js), with the
  // versions Claude Code reports. The menu lives on <body> (class model-menu) while it's open.
  Deck.modelPicker = function modelPicker(catalog, value, onChange, defaultLabel = 'Default') {
    const h = Deck.h;
    const cat = catalog && Array.isArray(catalog.families) ? catalog : { families: [], extras: [] };
    const choices = [...cat.families.flatMap((f) => f.items), ...(cat.extras || [])];
    let current = value || '';
    let other = Boolean(current) && !choices.some((c) => c.value === current);
    const btn = h('button', { type: 'button', class: 'model-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    const custom = h('input', { type: 'text', value: other ? current : '', placeholder: 'e.g. claude-opus-5-5', hidden: !other, spellcheck: 'false', 'aria-label': 'Model ID' });
    const wrap = h('div', { class: 'model-picker' }, btn, custom);
    const draw = () => {
      const c = choices.find((x) => x.value === current);
      const label = other ? 'Other model ID' : c ? c.label : current || defaultLabel;
      Deck.clear(btn).append(h('span', { class: 'model-btn-label' }, label), h('span', { class: 'model-btn-arrow' }, Deck.icon('down', { size: 12 })));
      btn.title = c ? `${c.label}: ${c.hint}` : current || defaultLabel;
      btn.setAttribute('aria-label', `Model: ${label}`);
    };
    wrap.getValue = () => (other ? custom.value.trim() : current);

    let menu = null;
    const onDoc = (e) => { if (menu && !menu.contains(e.target) && !btn.contains(e.target)) close(false); };
    const onEsc = (e) => { if (e.key === 'Escape' && menu) { e.stopPropagation(); e.preventDefault(); close(true); } };
    const onResize = () => close(false);
    function close(refocus) {
      if (!menu) return;
      menu.remove();
      menu = null;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onEsc, true);
      window.removeEventListener('resize', onResize);
      if (refocus && btn.isConnected) btn.focus();
    }
    const choose = (v) => {
      close(true);
      other = false;
      custom.hidden = true;
      current = v;
      draw();
      if (onChange) onChange(v);
    };
    const check = (on) => (on ? h('span', { class: 'hm-check' }, Deck.icon('check', { size: 12 })) : null);
    const item = (label, v, hint) => h('button', { type: 'button', role: 'menuitemradio', class: 'hm-item', 'aria-checked': String(!other && v === current), title: hint || null, onclick: () => choose(v) }, label, check(!other && v === current));
    const family = (f) => {
      const wrapF = h('div', { class: 'hm-flyout' });
      const mine = !other && f.items.some((i) => i.value === current);
      const open = () => {
        if (wrapF.querySelector('.hm-sub')) return;
        for (const s of menu.querySelectorAll('.hm-sub')) s.remove();
        // The ones that follow the newest version first, then the specific versions under a heading.
        const firstPinned = f.items.findIndex((i) => i.pinned);
        const sub = h('div', { class: 'hm-menu hm-sub', role: 'menu', 'aria-label': f.name }, f.items.map((i, n) => {
          const el = item(i.label, i.value, i.hint);
          if (!i.pinned) return el;
          el.classList.add('hm-pinned');
          return n === firstPinned ? [h('div', { class: 'hm-heading', role: 'presentation' }, 'Specific versions'), el] : el;
        }));
        wrapF.appendChild(sub);
        // Opens to the left when there's no room on the right, as Windows menus do, and moves up
        // (scrolling if it's taller than the window) rather than running off the bottom.
        const s = sub.getBoundingClientRect();
        if (s.right > window.innerWidth - 8) sub.classList.add('hm-sub-left');
        const room = window.innerHeight - 16;
        if (s.height > room) { sub.style.maxHeight = `${room}px`; sub.style.overflowY = 'auto'; }
        const over = Math.min(s.height, room) + s.top - (window.innerHeight - 8);
        if (over > 0) sub.style.top = `${-5 - over}px`;
      };
      const trigger = h('button', { type: 'button', role: 'menuitem', class: 'hm-item', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); open(); const first = wrapF.querySelector('.hm-sub .hm-item'); if (first) first.focus(); } },
        f.version || f.name, check(mine), h('span', { class: 'hm-arrow' }, Deck.icon('right', { size: 12 })));
      wrapF.append(trigger);
      wrapF.addEventListener('mouseenter', open);
      wrapF.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' && e.target === trigger) { e.preventDefault(); trigger.click(); }
        if (e.key === 'ArrowLeft' && e.target !== trigger) { e.preventDefault(); e.stopPropagation(); const sub = wrapF.querySelector('.hm-sub'); if (sub) sub.remove(); trigger.focus(); }
      });
      return wrapF;
    };
    const openMenu = () => {
      menu = h('div', { class: 'hm-menu model-menu', role: 'menu', 'aria-label': 'Model' },
        item(defaultLabel, '', 'Whatever your Claude Code settings choose'),
        cat.families.map(family),
        (cat.extras || []).map((x) => item(x.label, x.value, x.hint)),
        h('button', { type: 'button', role: 'menuitemradio', class: 'hm-item', 'aria-checked': String(other), onclick: () => { close(false); other = true; custom.hidden = false; draw(); custom.focus(); } }, 'Other model ID…', check(other)));
      // A plain item closes any open flyout, so only one is open at a time.
      menu.addEventListener('mouseover', (e) => {
        const it = e.target.closest && e.target.closest('.model-menu > .hm-item');
        if (it) for (const s of menu.querySelectorAll('.hm-sub')) s.remove();
      });
      // Up and down move between the items of the (sub)menu that has focus.
      menu.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const m = document.activeElement && document.activeElement.closest('.hm-menu');
        if (!m) return;
        const list = [...m.querySelectorAll(':scope > .hm-item, :scope > .hm-flyout > .hm-item')];
        const i = list.indexOf(document.activeElement);
        list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
      });
      // A popover, so it's drawn in the top layer: above a modal such as New session (which covers
      // everything else on <body>), placed against the window, and not clipped by the modal.
      menu.setAttribute('popover', 'manual');
      document.body.appendChild(menu);
      if (menu.showPopover) menu.showPopover();
      btn.setAttribute('aria-expanded', 'true');
      const r = btn.getBoundingClientRect();
      // Below the button, or above it when there's no room below.
      const below = r.bottom + 4 + menu.offsetHeight <= window.innerHeight - 8;
      menu.style.top = `${Math.round(below ? r.bottom + 4 : Math.max(8, r.top - 4 - menu.offsetHeight))}px`;
      menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onEsc, true);
      window.addEventListener('resize', onResize);
      const at = menu.querySelector('.hm-item[aria-checked="true"]') || menu.querySelector('.hm-flyout .hm-check') || menu.querySelector('.hm-item');
      (at.closest('.hm-item') || at).focus();
    };
    btn.addEventListener('click', () => { if (menu) close(true); else openMenu(); });
    // Enter and Space open it through click; ↓ does too, as it does on a dropdown.
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !menu) { e.preventDefault(); openMenu(); } });
    custom.addEventListener('change', () => { if (onChange && custom.value.trim()) onChange(wrap.getValue()); });
    draw();
    return wrap;
  };

  Deck.duration = function duration(ms) {
    if (!ms && ms !== 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  // Simple modal confirm built on <dialog>.
  // extra: an optional node shown under the text (for example, a list of what will change).
  // safeDefault: Cancel has the focus, so Enter doesn't agree to something risky by accident.
  Deck.confirm = function confirmDialog({ title, body, extra = null, ok = 'OK', danger = false, safeDefault = false }) {
    return new Promise((resolve) => {
      const dlg = Deck.h('dialog', { class: 'dialog small' },
        Deck.h('form', { method: 'dialog' },
          Deck.h('h2', null, title),
          body ? Deck.h('p', { class: 'muted' }, body) : null,
          extra,
          Deck.h('div', { class: 'dialog-actions' },
            Deck.h('button', { value: 'cancel', class: 'ghost', autofocus: safeDefault }, 'Cancel'),
            Deck.h('button', { value: 'ok', class: danger ? 'danger' : 'primary', autofocus: !safeDefault }, ok))));
      dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
      document.body.appendChild(dlg);
      dlg.showModal();
    });
  };

  Deck.promptText = function promptText({ title, label, value = '', ok = 'Save' }) {
    return new Promise((resolve) => {
      const input = Deck.h('input', { type: 'text', value, 'aria-label': label });
      // Cancel is a plain button, not a submit button: pressing Enter in the text box submits the
      // form through its first submit button, which must be Save.
      const dlg = Deck.h('dialog', { class: 'dialog small' },
        Deck.h('form', { method: 'dialog' },
          Deck.h('h2', null, title),
          Deck.h('label', { class: 'field' }, Deck.h('span', null, label), input),
          Deck.h('div', { class: 'dialog-actions' },
            Deck.h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close('cancel') }, 'Cancel'),
            Deck.h('button', { value: 'ok', class: 'primary' }, ok))));
      dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok' ? input.value : null); dlg.remove(); });
      document.body.appendChild(dlg);
      dlg.showModal();
      input.select();
    });
  };
})();
