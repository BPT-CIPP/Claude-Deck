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
        copyBtn.textContent = '✓ Copied';
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
      Deck.clear(btn).append(h('span', { class: 'model-btn-label' }, label), h('span', { class: 'model-btn-arrow', 'aria-hidden': 'true' }, '▾'));
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
    const check = (on) => (on ? h('span', { class: 'hm-check', 'aria-hidden': 'true' }, '✓') : null);
    const item = (label, v, hint) => h('button', { type: 'button', role: 'menuitemradio', class: 'hm-item', 'aria-checked': String(!other && v === current), title: hint || null, onclick: () => choose(v) }, label, check(!other && v === current));
    const family = (f) => {
      const wrapF = h('div', { class: 'hm-flyout' });
      const mine = !other && f.items.some((i) => i.value === current);
      const open = () => {
        if (wrapF.querySelector('.hm-sub')) return;
        for (const s of menu.querySelectorAll('.hm-sub')) s.remove();
        const sub = h('div', { class: 'hm-menu hm-sub', role: 'menu', 'aria-label': f.name }, f.items.map((i) => item(i.label, i.value, i.hint)));
        wrapF.appendChild(sub);
        // Opens to the left when there's no room on the right, as Windows menus do.
        if (sub.getBoundingClientRect().right > window.innerWidth - 8) sub.classList.add('hm-sub-left');
      };
      const trigger = h('button', { type: 'button', role: 'menuitem', class: 'hm-item', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); open(); const first = wrapF.querySelector('.hm-sub .hm-item'); if (first) first.focus(); } },
        f.version || f.name, check(mine), h('span', { class: 'hm-arrow', 'aria-hidden': 'true' }, '▸'));
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
      document.body.appendChild(menu);
      btn.setAttribute('aria-expanded', 'true');
      const r = btn.getBoundingClientRect();
      menu.style.top = `${Math.round(Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
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
