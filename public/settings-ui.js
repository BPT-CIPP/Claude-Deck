'use strict';
// Claude Code settings editor. Controls come from the bundled JSON Schema (SchemaStore's
// claude-code-settings.json); keys the schema doesn't know are kept and editable as JSON.

(function () {
  const { h, api, clear, toast, when } = Deck;

  const COMMON = [
    'model', 'effortLevel', 'tui', 'theme', 'viewMode', 'outputStyle', 'alwaysThinkingEnabled',
    'autoCompactEnabled', 'language', 'respectGitignore', 'includeGitInstructions', 'cleanupPeriodDays',
    'inputNeededNotifEnabled', 'spinnerTipsEnabled', 'autoUpdatesChannel', 'verbose',
  ];
  const OWN_TABS = new Set(['permissions', 'env', '$schema']);
  // Settings easily mistaken for Claude Deck's own.
  const NOTES = {
    theme: "Claude Code's colors in terminal sessions (Windows Terminal). It doesn't change Claude Deck's look; that's Claude Deck Preferences → Appearance.",
  };
  const SUGGESTIONS = {};
  const PERMISSION_LISTS = [
    ['allow', 'Allow without asking', 'Tool rules Claude may use freely, for example Bash(git status:*) or Read(./src/**).'],
    ['ask', 'Always ask first', 'Rules that always prompt, even in permissive modes.'],
    ['deny', 'Never allow', 'Rules that are always refused, for example Read(./.env) or WebFetch.'],
    ['additionalDirectories', 'Extra folders Claude can access', 'Full paths, one per entry.'],
  ];
  // Plugin marketplaces aren't a file: Claude Code's own `claude plugin marketplace` commands
  // manage them (src/plugins.js), so they get their own page instead of the file editor.
  const MARKETPLACES = 'marketplaces';
  const SCOPE_ORDER = ['user', 'project', 'local', 'memory-user', 'memory-project', MARKETPLACES];
  const SCOPE_TABS = { user: 'User', project: 'Project', local: 'Project (local)', 'memory-user': 'User memory', 'memory-project': 'Project memory', [MARKETPLACES]: 'Plugin marketplaces' };

  const T = {
    ctx: null,
    root: null,
    schema: null,
    scope: 'user',
    folder: '',
    tab: 'common',
    search: '',
    onlySet: false,
    file: null,
    original: null,
    model: null,
    parseError: null,
    rawError: null,
    memoryText: '',
    fieldErrors: {},
    loading: false,
    loadError: null,
    conflict: false,
    backups: [],
    mounted: false,
    loaded: false,
    market: { list: null, error: null, busy: false },
  };

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const scopeDef = () => T.ctx.boot.scopes[T.scope];

  // ---- value paths ---------------------------------------------------------------------------
  function getPath(obj, p) {
    return p.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  }

  function setPath(obj, p, value) {
    const keys = p.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!o[keys[i]] || typeof o[keys[i]] !== 'object' || Array.isArray(o[keys[i]])) o[keys[i]] = {};
      o = o[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (value === undefined) delete o[last];
    else o[last] = value;
    // Drop parents that became empty so unsetting leaves no {} behind.
    for (let i = keys.length - 1; i > 0; i--) {
      const parent = getPath(obj, keys.slice(0, i).join('.'));
      if (parent && typeof parent === 'object' && !Array.isArray(parent) && !Object.keys(parent).length) {
        const grand = i > 1 ? getPath(obj, keys.slice(0, i - 1).join('.')) : obj;
        delete grand[keys[i - 1]];
      }
    }
  }

  // ---- schema --------------------------------------------------------------------------------
  function schemaProp(p) {
    if (!T.schema) return null;
    const keys = p.split('.');
    let node = { properties: T.schema.properties };
    for (const k of keys) {
      node = node && node.properties ? node.properties[k] : null;
      if (!node) return null;
    }
    return node;
  }

  function describeProp(p) {
    if (!p) return { type: 'json', description: '' };
    const description = p.description || '';
    if (Array.isArray(p.enum)) return { type: 'enum', options: p.enum, description };
    const alts = p.anyOf || p.oneOf;
    if (alts) {
      const options = alts.flatMap((a) => a.enum || []);
      if (options.length && alts.every((a) => a.type === 'string')) return { type: 'enum', options, allowCustom: alts.some((a) => !a.enum), description };
      return { type: 'json', description };
    }
    const types = (Array.isArray(p.type) ? p.type : [p.type]).filter((t) => t && t !== 'null');
    if (types.length === 1) {
      if (types[0] === 'boolean') return { type: 'boolean', description };
      if (types[0] === 'string') return { type: 'string', examples: p.examples, description };
      if (types[0] === 'integer' || types[0] === 'number') return { type: 'number', integer: types[0] === 'integer', min: p.minimum, max: p.maximum, description };
    }
    return { type: 'json', description };
  }

  function descriptionNode(text) {
    if (!text) return null;
    const wrap = h('div', { class: 's-desc' });
    const long = text.length > 200;
    const firstStop = text.search(/\.\s/);
    const short = long && firstStop > 20 ? text.slice(0, firstStop + 1) : text;
    const body = h('span');
    const fill = (t) => {
      clear(body);
      for (const part of t.split(/(https?:\/\/[^\s)]+)/)) {
        if (/^https?:\/\//.test(part)) body.appendChild(h('a', { href: part.replace(/[.,]$/, ''), target: '_blank', rel: 'noopener' }, 'docs'));
        else body.appendChild(document.createTextNode(part));
      }
    };
    fill(short);
    wrap.appendChild(body);
    if (short !== text) {
      const more = h('button', { class: 'link', type: 'button' }, 'More');
      more.addEventListener('click', () => { fill(text); more.remove(); });
      wrap.appendChild(document.createTextNode(' '));
      wrap.appendChild(more);
    }
    return wrap;
  }

  // ---- field rows ----------------------------------------------------------------------------
  function setValue(p, value) {
    setPath(T.model, p, value);
    renderSaveBar();
  }

  function control(p, def) {
    const value = getPath(T.model, p);
    const listId = `dl-${p.replace(/\W/g, '-')}`;
    if (p === 'model') {
      return Deck.modelPicker(T.ctx.boot.enums.models, typeof value === 'string' ? value : '', (v) => { setValue(p, v || undefined); refreshRow(p); }, 'Not set (default)');
    }
    if (def.type === 'boolean') {
      const seg = h('div', { class: 'seg', role: 'group', 'aria-label': p });
      const opts = [[undefined, 'Default'], [true, 'On'], [false, 'Off']];
      for (const [v, label] of opts) {
        seg.appendChild(h('button', {
          type: 'button',
          'aria-pressed': String(value === v),
          onclick: () => { setValue(p, v); refreshRow(p); },
        }, label));
      }
      return seg;
    }
    if (def.type === 'enum') {
      const options = [...def.options];
      if (value !== undefined && !options.includes(value)) options.push(value);
      const sel = h('select', { 'aria-label': p, onchange: (e) => { setValue(p, e.target.value === '' ? undefined : e.target.value); refreshRow(p); } },
        h('option', { value: '' }, 'Not set (default)'),
        options.map((o) => h('option', { value: String(o), selected: value === o }, String(o))));
      if (!def.allowCustom) return sel;
      const custom = h('input', { type: 'text', placeholder: 'or type a custom value', 'aria-label': `${p} custom value` });
      custom.addEventListener('change', () => { if (custom.value.trim()) { setValue(p, custom.value.trim()); refreshRow(p); } });
      return h('div', { class: 'row' }, sel, custom);
    }
    if (def.type === 'string') {
      const sugg = SUGGESTIONS[p] || (Array.isArray(def.examples) ? def.examples.filter((e) => typeof e === 'string') : []);
      const input = h('input', { type: 'text', value: value === undefined ? '' : String(value), placeholder: 'Not set (default)', list: sugg.length ? listId : null, spellcheck: 'false', 'aria-label': p });
      input.addEventListener('input', () => setValue(p, input.value === '' ? undefined : input.value));
      input.addEventListener('change', () => refreshRow(p, true));
      return h('div', null, input, sugg.length ? h('datalist', { id: listId }, sugg.map((s) => h('option', { value: s }))) : null);
    }
    if (def.type === 'number') {
      const input = h('input', { type: 'number', value: value === undefined ? '' : String(value), placeholder: 'Not set', min: def.min, max: def.max, step: def.integer ? '1' : 'any', 'aria-label': p });
      input.addEventListener('input', () => {
        if (input.value === '') { delete T.fieldErrors[p]; setValue(p, undefined); return; }
        const n = Number(input.value);
        if (!Number.isFinite(n) || (def.integer && !Number.isInteger(n))) T.fieldErrors[p] = def.integer ? 'Enter a whole number.' : 'Enter a number.';
        else { delete T.fieldErrors[p]; setValue(p, n); }
        showRowError(p);
      });
      input.addEventListener('change', () => refreshRow(p, true));
      return input;
    }
    const ta = h('textarea', { rows: String(Math.min(12, Math.max(3, value === undefined ? 3 : JSON.stringify(value, null, 2).split('\n').length))), spellcheck: 'false', placeholder: 'Not set. Enter JSON.', 'aria-label': p });
    ta.value = value === undefined ? '' : JSON.stringify(value, null, 2);
    ta.addEventListener('input', () => {
      if (!ta.value.trim()) { delete T.fieldErrors[p]; setValue(p, undefined); showRowError(p); return; }
      try {
        setValue(p, JSON.parse(ta.value));
        delete T.fieldErrors[p];
      } catch (err) {
        T.fieldErrors[p] = `Not valid JSON: ${err.message}`;
        renderSaveBar();
      }
      showRowError(p);
    });
    ta.addEventListener('change', () => refreshRow(p, true));
    return ta;
  }

  function row(p, def) {
    const value = getPath(T.model, p);
    const changed = !same(value, getPath(T.original, p));
    return h('div', { class: 'setting', dataset: { path: p } },
      h('div', null,
        h('div', { class: 's-key' }, changed ? h('span', { class: 'dot', title: 'Unsaved change' }) : null, p),
        NOTES[p] ? h('div', { class: 's-note' }, NOTES[p]) : null,
        descriptionNode(def.description)),
      h('div', { class: 's-control' },
        control(p, def),
        h('div', { class: 's-error', hidden: !T.fieldErrors[p] }, T.fieldErrors[p] || ''),
        value !== undefined && def.type !== 'boolean' && p !== 'model'
          ? h('button', { type: 'button', class: 'link unset', onclick: () => { delete T.fieldErrors[p]; setValue(p, undefined); refreshRow(p); } }, 'Use the default')
          : null));
  }

  function rowFor(p) {
    const prop = schemaProp(p);
    return row(p, describeProp(prop));
  }

  // Re-render one row in place. keepFocus is used after text edits so typing isn't interrupted.
  function refreshRow(p, keepFocus) {
    const el = T.root.querySelector(`.setting[data-path="${CSS.escape(p)}"]`);
    if (!el) return;
    if (keepFocus && el.contains(document.activeElement)) {
      const key = el.querySelector('.s-key');
      const changed = !same(getPath(T.model, p), getPath(T.original, p));
      const dot = key.querySelector('.dot');
      if (changed && !dot) key.prepend(h('span', { class: 'dot', title: 'Unsaved change' }));
      if (!changed && dot) dot.remove();
      return;
    }
    el.replaceWith(rowFor(p));
  }

  function showRowError(p) {
    const el = T.root.querySelector(`.setting[data-path="${CSS.escape(p)}"] .s-error`);
    if (!el) return;
    el.textContent = T.fieldErrors[p] || '';
    el.hidden = !T.fieldErrors[p];
    renderSaveBar();
  }

  // ---- tabs ----------------------------------------------------------------------------------
  function commonTab() {
    const inner = h('div', { class: 'inner' },
      h('p', { class: 'section-note' }, 'The settings people change most. Anything left at the default follows the next level up: project settings override user settings, and local overrides project.'));
    for (const k of COMMON) if (schemaProp(k)) inner.appendChild(rowFor(k));
    return inner;
  }

  function allTab() {
    const inner = h('div', { class: 'inner' });
    const search = h('input', { type: 'search', value: T.search, placeholder: 'Search settings and descriptions', 'aria-label': 'Search settings', style: { width: '100%' } });
    const onlySet = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: T.onlySet }), 'Only show settings that are set in this file');
    const list = h('div');
    const fill = () => {
      clear(list);
      const q = T.search.toLowerCase();
      const keys = Object.keys(T.schema.properties).filter((k) => !OWN_TABS.has(k)).sort((a, b) => a.localeCompare(b));
      let shown = 0;
      for (const k of keys) {
        const prop = T.schema.properties[k];
        if (T.onlySet && getPath(T.model, k) === undefined) continue;
        if (q && !k.toLowerCase().includes(q) && !(prop.description || '').toLowerCase().includes(q)) continue;
        list.appendChild(row(k, describeProp(prop)));
        shown++;
      }
      const unknown = Object.keys(T.model).filter((k) => !T.schema.properties[k] && !OWN_TABS.has(k) && (!q || k.toLowerCase().includes(q)));
      if (unknown.length) {
        list.appendChild(h('h3', { style: { margin: '22px 0 4px' } }, 'Not in the schema'));
        list.appendChild(h('p', { class: 'section-note' }, 'These keys are in the file but not in the bundled schema. They may be newer than the schema, or misspelled. They are kept as they are unless you change them.'));
        for (const k of unknown) list.appendChild(row(k, { type: 'json', description: '' }));
        shown += unknown.length;
      }
      if (!shown) list.appendChild(h('p', { class: 'faint' }, 'No settings match.'));
    };
    search.addEventListener('input', () => { T.search = search.value; fill(); });
    onlySet.querySelector('input').addEventListener('change', (e) => { T.onlySet = e.target.checked; fill(); });
    inner.appendChild(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px' } }, search, onlySet));
    inner.appendChild(list);
    fill();
    return inner;
  }

  function permissionsTab() {
    const inner = h('div', { class: 'inner' },
      h('p', { class: 'section-note' }, 'Rules use Claude Code\'s permission syntax: a tool name, optionally with a pattern in parentheses.'));
    for (const k of ['permissions.defaultMode', 'permissions.disableBypassPermissionsMode']) if (schemaProp(k)) inner.appendChild(rowFor(k));
    for (const [key, title, note] of PERMISSION_LISTS) {
      const p = `permissions.${key}`;
      const items = Array.isArray(getPath(T.model, p)) ? getPath(T.model, p) : [];
      const box = h('div', { class: 'list-editor' }, h('h3', null, title), h('p', { class: 'section-note', style: { margin: 0 } }, note));
      items.forEach((rule, i) => {
        box.appendChild(h('div', { class: 'rule' }, h('code', null, String(rule)),
          h('button', { type: 'button', class: 'ghost small', 'aria-label': `Remove ${rule}`, onclick: () => {
            const next = items.filter((_, j) => j !== i);
            setValue(p, next.length ? next : undefined);
            rerenderBody();
          } }, 'Remove')));
      });
      const input = h('input', { type: 'text', placeholder: key === 'additionalDirectories' ? 'C:\\path\\to\\folder' : 'Bash(npm run test:*)', spellcheck: 'false', 'aria-label': `Add to ${title}` });
      const add = () => {
        const v = input.value.trim();
        if (!v) return;
        setValue(p, [...items, v]);
        rerenderBody();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      box.appendChild(h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'ghost', onclick: add }, 'Add')));
      inner.appendChild(box);
    }
    return inner;
  }

  function envTab() {
    const inner = h('div', { class: 'inner' },
      h('p', { class: 'section-note' }, 'Environment variables set for every Claude Code session that uses these settings. Many options that have no dedicated setting are controlled this way.'));
    const env = T.model.env && typeof T.model.env === 'object' ? T.model.env : {};
    const rows = Object.entries(env).map(([k, v]) => ({ k, v: typeof v === 'string' ? v : JSON.stringify(v) }));
    const box = h('div');
    const commit = () => {
      const next = {};
      const seen = new Set();
      let dup = null;
      for (const r of rows) {
        if (!r.k.trim()) continue;
        if (seen.has(r.k.trim())) dup = r.k.trim();
        seen.add(r.k.trim());
        next[r.k.trim()] = r.v;
      }
      if (dup) T.fieldErrors.env = `${dup} appears twice. The last one wins.`;
      else delete T.fieldErrors.env;
      err.textContent = T.fieldErrors.env || '';
      err.hidden = !dup;
      setValue('env', Object.keys(next).length ? next : undefined);
    };
    const err = h('p', { class: 's-error', hidden: true });
    const draw = () => {
      clear(box);
      rows.forEach((r, i) => {
        const kIn = h('input', { type: 'text', value: r.k, placeholder: 'NAME', spellcheck: 'false', 'aria-label': 'Variable name' });
        const vIn = h('input', { type: 'text', value: r.v, placeholder: 'value', spellcheck: 'false', 'aria-label': 'Value' });
        kIn.addEventListener('input', () => { r.k = kIn.value; commit(); });
        vIn.addEventListener('input', () => { r.v = vIn.value; commit(); });
        box.appendChild(h('div', { class: 'env-row' }, kIn, vIn, h('button', { type: 'button', class: 'ghost small', onclick: () => { rows.splice(i, 1); commit(); draw(); } }, 'Remove')));
      });
      if (!rows.length) box.appendChild(h('p', { class: 'faint' }, 'No variables set.'));
    };
    draw();
    inner.appendChild(box);
    inner.appendChild(err);
    inner.appendChild(h('button', { type: 'button', class: 'ghost', onclick: () => { rows.push({ k: '', v: '' }); draw(); box.querySelector('.env-row:last-child input').focus(); } }, 'Add variable'));
    return inner;
  }

  function rawTab() {
    const inner = h('div', { class: 'inner' });
    const ta = h('textarea', { class: 'raw-editor', spellcheck: 'false', 'aria-label': 'Settings JSON' });
    ta.value = T.model ? JSON.stringify(T.model, null, 2) : (T.file ? T.file.text : '');
    const err = h('p', { class: 's-error', hidden: !T.rawError }, T.rawError || '');
    ta.addEventListener('input', () => {
      try {
        const parsed = ta.value.trim() ? JSON.parse(ta.value) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Settings must be a JSON object ({ ... }).');
        T.model = parsed;
        T.rawError = null;
        T.parseError = null;
      } catch (e) {
        T.rawError = e.message;
      }
      err.textContent = T.rawError || '';
      err.hidden = !T.rawError;
      renderSaveBar();
    });
    inner.appendChild(h('p', { class: 'section-note' }, 'The whole file. Other tabs pick up your edits once the JSON is valid.'));
    inner.appendChild(ta);
    inner.appendChild(err);
    return inner;
  }

  function memoryEditor() {
    const inner = h('div', { class: 'inner' });
    const ta = h('textarea', { class: 'raw-editor', spellcheck: 'true', 'aria-label': 'CLAUDE.md' });
    ta.value = T.memoryText;
    ta.addEventListener('input', () => { T.memoryText = ta.value; renderSaveBar(); });
    inner.appendChild(h('p', { class: 'section-note' }, T.scope === 'memory-user'
      ? 'Instructions Claude reads at the start of every session, in every project.'
      : 'Instructions Claude reads at the start of every session in this folder. Usually committed with the project.'));
    inner.appendChild(ta);
    return inner;
  }

  // ---- layout --------------------------------------------------------------------------------
  function isDirty() {
    if (!T.file) return false;
    if (T.file.kind === 'text') return T.memoryText !== T.original;
    return T.model !== null && !same(T.model, T.original);
  }

  function changedKeys() {
    if (!T.model || !T.original) return [];
    const keys = new Set([...Object.keys(T.model), ...Object.keys(T.original)]);
    return [...keys].filter((k) => !same(T.model[k], T.original[k]));
  }

  function renderSaveBar() {
    const bar = T.root && T.root.querySelector('.save-bar');
    if (!bar) return;
    clear(bar);
    if (!T.file) return;
    const dirty = isDirty();
    const errors = Object.keys(T.fieldErrors).length > 0 || Boolean(T.rawError);
    let text;
    if (T.conflict) text = 'This file changed on disk since you opened it.';
    else if (errors) text = 'Fix the highlighted values to save.';
    else if (!dirty) text = T.file.exists ? 'No unsaved changes.' : 'This file does not exist yet. Saving creates it.';
    else if (T.file.kind === 'text') text = 'Unsaved changes.';
    else {
      const keys = changedKeys();
      text = `${keys.length} unsaved change${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}`;
    }
    bar.appendChild(h('span', { class: `changes${dirty ? ' dirty' : ''}` }, text));
    if (T.backups.length) {
      const sel = h('select', { 'aria-label': 'Restore a backup' },
        h('option', { value: '' }, `Restore a backup (${T.backups.length})`),
        T.backups.map((b) => h('option', { value: b.name }, `${when(b.savedAt)}  (${b.size} bytes)`)));
      sel.addEventListener('change', async () => {
        const name = sel.value;
        sel.value = '';
        if (!name) return;
        const ok = await Deck.confirm({ title: 'Restore this backup?', body: 'The file goes back to that version. What is there now is backed up first, so you can undo this.', ok: 'Restore' });
        if (!ok) return;
        try {
          await api('POST', '/api/settings/restore', { scope: T.file.scope, folder: T.file.folder || '', name, baseMtimeMs: T.file.mtimeMs });
          toast('Backup restored');
          load();
        } catch (err) {
          toast(`Couldn't restore: ${err.message}`, 'error');
        }
      });
      bar.appendChild(sel);
    }
    if (T.conflict) {
      bar.appendChild(h('button', { type: 'button', class: 'ghost', onclick: () => load() }, 'Reload and discard mine'));
      bar.appendChild(h('button', { type: 'button', class: 'danger', onclick: () => save(true) }, 'Overwrite'));
      return;
    }
    bar.appendChild(h('button', { type: 'button', class: 'ghost', disabled: !dirty, onclick: () => { T.model = clone(T.original); T.memoryText = T.file.kind === 'text' ? T.original : ''; T.fieldErrors = {}; T.rawError = null; rerenderBody(); } }, 'Revert'));
    bar.appendChild(h('button', { type: 'button', class: 'primary', disabled: !dirty || errors, onclick: () => save(false), title: 'Ctrl+S' }, 'Save'));
  }

  function rerenderBody() {
    const body = T.root.querySelector('.settings-body');
    if (!body) return render();
    const scroll = body.scrollTop;
    clear(body).appendChild(bodyContent());
    body.scrollTop = scroll;
    renderTabs();
    renderSaveBar();
  }

  function bodyContent() {
    if (T.loading) return h('p', { class: 'faint' }, 'Loading…');
    if (T.loadError) return h('p', { class: 's-error' }, T.loadError);
    if (!T.file) return h('p', { class: 'faint' }, 'Choose a project folder above to edit its settings.');
    if (T.file.kind === 'text') return memoryEditor();
    if (T.parseError && T.tab !== 'raw') {
      return h('div', { class: 'inner' }, h('p', { class: 's-error' }, `This file is not valid JSON (${T.parseError}). Fix it in the JSON tab.`));
    }
    if (!T.schema) return h('p', { class: 'faint' }, 'Loading the settings schema…');
    if (T.tab === 'all') return allTab();
    if (T.tab === 'permissions') return permissionsTab();
    if (T.tab === 'env') return envTab();
    if (T.tab === 'raw') return rawTab();
    return commonTab();
  }

  function renderTabs() {
    const tabs = T.root.querySelector('.tabs');
    if (!tabs) return;
    clear(tabs);
    tabs.hidden = !T.file || T.file.kind !== 'json';
    for (const [k, label] of [['common', 'Common'], ['all', 'All settings'], ['permissions', 'Permissions'], ['env', 'Environment'], ['raw', 'JSON']]) {
      tabs.appendChild(h('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(T.tab === k),
        onclick: () => {
          if (T.tab === 'raw' && T.rawError) { toast('Fix the JSON first, or revert, before switching tabs.', 'error'); return; }
          T.tab = k;
          rerenderBody();
        },
      }, label));
    }
  }

  async function switchScope(scope) {
    if (scope === T.scope) return;
    if (isDirty() && !(await Deck.confirm({ title: 'Discard unsaved changes?', body: 'You have edits that are not saved yet.', ok: 'Discard', danger: true }))) return;
    T.scope = scope;
    load();
  }

  // ---- plugin marketplaces -------------------------------------------------------------------
  async function loadMarketplaces() {
    T.market.error = null;
    try {
      T.market.list = await api('GET', '/api/plugins/marketplaces');
    } catch (err) {
      T.market.list = null;
      T.market.error = err.message;
    }
    if (T.scope === MARKETPLACES) render();
  }

  // One change at a time; each one runs a Claude Code command, and adding or updating downloads.
  async function marketplaceAction(label, fn) {
    if (T.market.busy) return;
    T.market.busy = true;
    render();
    try {
      const res = await fn();
      toast(res && res.message ? res.message : 'Done');
    } catch (err) {
      toast(`${label}: ${err.message}`, 'error');
    }
    T.market.busy = false;
    await loadMarketplaces();
  }

  function marketplacesBody() {
    const m = T.market;
    const busy = m.busy;
    const input = h('input', { type: 'text', placeholder: 'GitHub owner/repo, a git URL, or a folder', spellcheck: 'false', 'aria-label': 'Marketplace to add', disabled: busy });
    const add = () => {
      const source = input.value.trim();
      if (!source) { input.focus(); return; }
      marketplaceAction("Couldn't add the marketplace", () => api('POST', '/api/plugins/marketplaces', { source }));
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    let list;
    if (m.error) list = h('p', { class: 's-error' }, m.error);
    else if (!m.list) list = h('p', { class: 'faint' }, 'Loading…');
    else if (!m.list.length) list = h('p', { class: 'faint' }, 'No marketplaces yet. Add one below.');
    else {
      list = h('div', { class: 'market-list' }, m.list.map((mk) => h('div', { class: 'market-row' },
        h('div', { class: 'market-name' }, h('strong', null, mk.name), h('small', { class: 'faint' }, [mk.source, mk.location].filter(Boolean).join(' · '))),
        h('button', { type: 'button', class: 'ghost small', disabled: busy, onclick: () => marketplaceAction(`Couldn't update ${mk.name}`, () => api('POST', '/api/plugins/marketplaces/update', { name: mk.name })) }, 'Update'),
        h('button', {
          type: 'button',
          class: 'danger small',
          disabled: busy,
          onclick: async () => {
            const ok = await Deck.confirm({ title: `Remove ${mk.name}?`, body: "Claude Code stops offering its plugins. Plugins you've already installed from it may stop getting updates.", ok: 'Remove', danger: true });
            if (ok) marketplaceAction(`Couldn't remove ${mk.name}`, () => api('POST', '/api/plugins/marketplaces/remove', { name: mk.name }));
          },
        }, 'Remove'))));
    }
    return h('div', { class: 'inner market' },
      h('p', { class: 'muted' }, "Where Claude Code finds plugins to install. Their plugins are listed under Marketplace in a chat's Plugins menu."),
      h('div', { class: 'market-head' }, h('h3', null, 'Your marketplaces'), h('span', { class: 'spacer' }),
        busy ? h('span', { class: 'faint' }, 'Working…') : null,
        h('button', { type: 'button', class: 'ghost small', disabled: busy || !m.list || !m.list.length, onclick: () => marketplaceAction("Couldn't update the marketplaces", () => api('POST', '/api/plugins/marketplaces/update', {})) }, 'Update all')),
      list,
      h('h3', null, 'Add a marketplace'),
      h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'primary', disabled: busy, onclick: add }, 'Add')),
      h('small', { class: 'faint' }, 'Claude Code downloads it from there. Only add marketplaces you trust: plugins run with your permissions.'));
  }

  function render() {
    const root = clear(T.root);
    const scopes = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Which file' },
      SCOPE_ORDER.map((s) => h('button', { type: 'button', 'aria-pressed': String(T.scope === s), onclick: () => switchScope(s) }, SCOPE_TABS[s])));
    const bar = h('div', { class: 'scope-bar' }, scopes);
    const title = h('header', { class: 'view-head' }, h('h1', { id: 'h-settings' }, 'Claude Code Settings'), h('div', { class: 'spacer' }),
      h('span', { class: 'faint', style: { fontSize: '13px' } }, 'Running sessions may need a restart to pick up changes.'));
    if (T.scope === MARKETPLACES) {
      root.appendChild(h('div', { class: 'settings' }, title, bar, h('div', { class: 'settings-body' }, marketplacesBody())));
      return;
    }
    const def = scopeDef();
    if (def.needsFolder) {
      const input = h('input', { type: 'text', value: T.folder, list: 'settings-folders', placeholder: 'Project folder', spellcheck: 'false', 'aria-label': 'Project folder' });
      const dl = h('datalist', { id: 'settings-folders' });
      T.ctx.folders().then((f) => { for (const p of [...(f.favorites || []), ...(f.recent || []).map((r) => r.path)]) dl.appendChild(h('option', { value: p })); });
      const go = async (value) => {
        if (value === T.folder) return;
        if (isDirty() && !(await Deck.confirm({ title: 'Discard unsaved changes?', body: 'You have edits that are not saved yet.', ok: 'Discard', danger: true }))) return;
        T.folder = value;
        load();
      };
      input.addEventListener('change', () => go(input.value.trim()));
      bar.appendChild(h('div', { class: 'folder' }, input, dl,
        h('button', { type: 'button', class: 'ghost', onclick: async () => { const p = await T.ctx.pickFolder(T.folder); if (p) go(p); } }, 'Browse…')));
    }
    root.appendChild(h('div', { class: 'settings' },
      title,
      bar,
      T.file ? h('div', { class: 'file-line' },
        h('span', null, def.label),
        h('code', null, T.file.path),
        h('span', null, T.file.exists ? `saved ${when(T.file.mtimeMs)}` : 'not created yet'),
        h('button', { type: 'button', class: 'link', onclick: () => T.ctx.openFolder(parentDir(T.file.path)) }, 'Open folder')) : null,
      h('div', { class: 'tabs', role: 'tablist' }),
      h('div', { class: 'settings-body' }, bodyContent()),
      h('div', { class: 'save-bar' })));
    renderTabs();
    renderSaveBar();
  }

  function parentDir(p) {
    return p.replace(/[\\/][^\\/]*$/, '');
  }

  async function loadBackups() {
    try {
      const res = await api('GET', `/api/settings/backups?scope=${encodeURIComponent(T.scope)}&folder=${encodeURIComponent(T.folder)}`);
      T.backups = res.backups;
    } catch {
      T.backups = [];
    }
    renderSaveBar();
  }

  async function load() {
    T.conflict = false;
    T.fieldErrors = {};
    T.rawError = null;
    T.parseError = null;
    T.loadError = null;
    T.backups = [];
    if (T.scope === MARKETPLACES) {
      T.file = null;
      T.loaded = true;
      render();
      loadMarketplaces();
      return;
    }
    if (scopeDef().needsFolder && !T.folder) {
      T.file = null;
      render();
      return;
    }
    // Only the latest load counts: switching scope or folder while one is on its way must not let
    // the earlier file's content arrive last and be saved into the newly chosen one.
    const gen = (T.loadGen = (T.loadGen || 0) + 1);
    T.file = null;
    T.model = null;
    T.loading = true;
    render();
    try {
      const f = await api('GET', `/api/settings?scope=${encodeURIComponent(T.scope)}&folder=${encodeURIComponent(T.folder)}`);
      if (gen !== T.loadGen) return;
      T.file = f;
      if (f.kind === 'json') {
        let parsed = {};
        if (f.exists && f.text.trim()) {
          try {
            parsed = JSON.parse(f.text);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the top level is not an object');
          } catch (err) {
            T.parseError = err.message;
            parsed = null;
          }
        }
        T.original = parsed || {};
        T.model = parsed ? clone(parsed) : null;
        if (T.parseError) T.tab = 'raw';
      } else {
        T.original = f.text;
        T.memoryText = f.text;
      }
    } catch (err) {
      if (gen !== T.loadGen) return;
      T.file = null;
      T.loadError = err.message;
    }
    T.loading = false;
    T.loaded = true;
    render();
    if (T.file) loadBackups();
  }

  async function save(force) {
    if (!T.file || !isDirty()) return;
    if (Object.keys(T.fieldErrors).length || T.rawError) {
      toast('Fix the highlighted values before saving.', 'error');
      return;
    }
    const text = T.file.kind === 'json' ? `${JSON.stringify(T.model, null, 2)}\n` : T.memoryText;
    try {
      // To the file this content was loaded from, whatever is selected by the time this runs.
      const f = await api('PUT', '/api/settings', { scope: T.file.scope, folder: T.file.folder || '', text, baseMtimeMs: T.file.mtimeMs, force: force === true });
      T.file = f;
      T.conflict = false;
      if (f.kind === 'json') T.original = clone(T.model);
      else T.original = T.memoryText;
      toast(f.backupPath ? 'Saved. The previous version was backed up.' : 'Saved');
      rerenderBody();
      const line = T.root.querySelector('.file-line span:nth-of-type(2)');
      if (line) line.textContent = `saved ${when(f.mtimeMs)}`;
      loadBackups();
    } catch (err) {
      if (err.status === 409) {
        T.conflict = true;
        renderSaveBar();
      } else {
        toast(`Couldn't save: ${err.message}`, 'error');
      }
    }
  }

  Deck.SettingsUI = {
    mount(root, ctx) {
      T.root = root;
      T.ctx = ctx;
      T.mounted = true;
      fetch('vendor/claude-code-settings.schema.json')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((s) => { T.schema = s; if (T.loaded) rerenderBody(); })
        .catch((err) => toast(`The settings schema didn't load (${err.message}). The JSON tab still works.`, 'error'));
    },
    show() {
      if (!T.loaded) load();
    },
    // From a chat's Plugins menu.
    showMarketplaces() {
      if (T.scope === MARKETPLACES && T.loaded) return loadMarketplaces();
      return switchScope(MARKETPLACES);
    },
    save() {
      return save(false);
    },
    isDirty,
  };
})();
