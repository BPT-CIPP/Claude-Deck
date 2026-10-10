'use strict';
// Markdown in Claude's replies, read the way Claude Code's terminal shows it: headings, lists,
// quotes, tables, rules, fenced and indented code, and inline code, bold, italics, strikethrough
// and links. parse() returns plain objects; lib.js (Deck.richText) builds the page's nodes from them,
// never HTML. Kept apart from lib.js so test/markdown.test.js can run it without a page.
//
// Blocks: { type: 'paragraph', inline } | { type: 'heading', level, inline }
//   | { type: 'code', lang, code, open } (open: the reply ended before the closing fence)
//   | { type: 'rule' } | { type: 'quote', blocks } | { type: 'list', ordered, start, items: [blocks] }
//   | { type: 'table', align: ['left'|'center'|'right'|null], head: [inline], rows: [[inline]] }
// Inline: { type: 'text', text } | { type: 'code', text } | { type: 'strong'|'em'|'del', children }
//   | { type: 'link', href, url, children } (href only for http and https addresses)

(function () {
  const MAX_DEPTH = 12;
  const FENCE = /^(\s*)(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
  const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
  const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
  const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
  const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
  const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  const INDENTED = /^(?: {4}|\t)/;
  const blank = (line) => !line.trim();
  const indentOf = (line) => line.length - line.trimStart().length;

  // ---- blocks ----------------------------------------------------------------------------------
  function parse(text) {
    // Leading tabs count as four spaces, as Markdown reads them.
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length)));
    return blocks(lines, 0);
  }

  function isTableStart(lines, i) {
    if (i + 1 >= lines.length || !lines[i].includes('|') || !TABLE_SEP.test(lines[i + 1])) return false;
    // The separator needs a pipe too ("---" alone is a rule), and as many cells as the header.
    return lines[i + 1].includes('|') && cells(lines[i]).length === cells(lines[i + 1]).length;
  }

  // Whether a line starts a new block, which ends a paragraph. A numbered list only interrupts one
  // when it starts at 1, so a line that happens to start with "2026." stays part of the sentence.
  function startsBlock(lines, i) {
    const line = lines[i];
    if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || isTableStart(lines, i)) return true;
    const m = ITEM.exec(line);
    return Boolean(m && m[3] && (!/\d/.test(m[2]) || parseInt(m[2], 10) === 1));
  }

  function blocks(lines, depth) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) { i++; continue; }
      let m;
      if (depth < MAX_DEPTH && (m = FENCE.exec(line))) {
        const [, indent, fence, lang] = m;
        const code = [];
        let closed = false;
        i++;
        for (; i < lines.length; i++) {
          const close = /^\s*(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
          if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { closed = true; i++; break; }
          // A fence indented inside a list item: its lines lose the same indent.
          code.push(lines[i].slice(Math.min(indent.length, indentOf(lines[i]))));
        }
        out.push({ type: 'code', lang: lang || '', code: code.join('\n'), open: !closed });
        continue;
      }
      if ((m = HEADING.exec(line))) {
        out.push({ type: 'heading', level: m[1].length, inline: inline(m[2]) });
        i++;
        continue;
      }
      if (RULE.test(line)) {
        out.push({ type: 'rule' });
        i++;
        continue;
      }
      if (depth < MAX_DEPTH && isTableStart(lines, i)) {
        const align = cells(lines[i + 1]).map((c) => {
          const left = c.startsWith(':');
          const right = c.endsWith(':');
          return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
        });
        const fit = (row) => align.map((_, k) => inline(row[k] || ''));
        const head = fit(cells(line));
        const rows = [];
        i += 2;
        while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(fit(cells(lines[i++])));
        out.push({ type: 'table', align, head, rows });
        continue;
      }
      if (depth < MAX_DEPTH && QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && (m = QUOTE.exec(lines[i]))) { inner.push(m[1]); i++; }
        out.push({ type: 'quote', blocks: blocks(inner, depth + 1) });
        continue;
      }
      if (depth < MAX_DEPTH && (m = ITEM.exec(line)) && !RULE.test(line)) {
        const list = listAt(lines, i, depth);
        out.push(list.block);
        i = list.next;
        continue;
      }
      if (INDENTED.test(line)) {
        // Indented by four: code, carrying on across blank lines while the next line is indented too.
        const code = [];
        while (i < lines.length && (INDENTED.test(lines[i]) || blank(lines[i]))) code.push(lines[i++].replace(/^ {1,4}/, ''));
        // The blank lines it ended on aren't part of it.
        while (code.length && !code[code.length - 1].trim()) { code.pop(); i--; }
        out.push({ type: 'code', lang: '', code: code.join('\n'), open: false });
        continue;
      }
      // A paragraph: lines up to a blank line or the start of another block.
      const para = [line.trim()];
      i++;
      while (i < lines.length && !blank(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++].trim());
      out.push({ type: 'paragraph', inline: inline(para.join('\n')) });
    }
    return out;
  }

  // A list starting at line i: its items, each read as blocks of its own (so an item can hold
  // paragraphs, code and nested lists), and the line after it.
  function listAt(lines, i, depth) {
    const first = ITEM.exec(lines[i]);
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    const sameKind = (m) => m && /\d/.test(m[2]) === ordered && !RULE.test(m[0]);
    const items = [];
    while (i < lines.length) {
      const m = ITEM.exec(lines[i]);
      if (!sameKind(m) || m[1].length < base || m[1].length > base + 3) break;
      const content = m[3] === undefined ? '' : m[3];
      // Where the item's text starts; its other lines are indented at least that far.
      const offset = m[0].length - content.length;
      const own = [content];
      i++;
      let gap = false;
      while (i < lines.length) {
        const line = lines[i];
        if (blank(line)) { gap = true; own.push(''); i++; continue; }
        const indent = indentOf(line);
        if (indent >= offset || (indent > base && !gap)) {
          own.push(line.slice(Math.min(offset, indent)));
          gap = false;
          i++;
          continue;
        }
        // A line that carries on the item's last paragraph without being indented.
        if (!gap && !ITEM.test(line) && !startsBlock(lines, i)) { own.push(line.trim()); i++; continue; }
        break;
      }
      // Blank lines before the next item belong to the list, not the item.
      while (own.length && blank(own[own.length - 1])) own.pop();
      items.push(blocks(own, depth + 1));
      // The list carries on across blank lines only into another item like these.
      let j = i;
      while (j < lines.length && blank(lines[j])) j++;
      const next = j < lines.length ? ITEM.exec(lines[j]) : null;
      if (j > i && !(sameKind(next) && next[1].length >= base && next[1].length <= base + 3)) break;
      i = j;
    }
    return { block: { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items }, next: i };
  }

  // A table row's cells: split on pipes, but not escaped ones (\|) or ones inside `code`.
  function cells(row) {
    let s = row.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const out = [];
    let cell = '';
    let tick = 0; // the length of the backtick run that opened a code span, 0 outside one
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === '\\' && s[k + 1] === '|') { cell += '|'; k++; continue; }
      if (c === '`') {
        let run = 1;
        while (s[k + run] === '`') run++;
        if (!tick) tick = run;
        else if (run === tick) tick = 0;
        cell += '`'.repeat(run);
        k += run - 1;
        continue;
      }
      if (c === '|' && !tick) { out.push(cell.trim()); cell = ''; continue; }
      cell += c;
    }
    out.push(cell.trim());
    return out;
  }

  // ---- inline ----------------------------------------------------------------------------------
  const INLINE = new RegExp([
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source, // 1, 2: code
    /\[([^\]\n]+)\]\(\s*<?([^\s<>()]+(?:\([^\s()]*\)[^\s<>()]*)*)>?(?:\s+"[^"\n]*")?\s*\)/.source, // 3, 4: [text](url)
    /<(https?:\/\/[^\s<>]+)>/.source, // 5: <url>
    /(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]*_~])/.source, // 6: a bare address
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 7: bold
    /(?<![\w])__(?=\S)([\s\S]*?\S)__(?![\w])/.source, // 8: bold
    /~~(?=\S)([\s\S]*?\S)~~/.source, // 9: strikethrough
    /\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?!\*)/.source, // 10: italics
    /(?<![\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\w])/.source, // 11: italics
    /\\([!-/:-@[-`{-~])/.source, // 12: an escaped punctuation mark
  ].join('|'), 'g');

  const linkOf = (url, children) => ({ type: 'link', href: /^https?:\/\//i.test(url) ? url : null, url, children });

  function inline(text, depth = 0) {
    const out = [];
    const push = (t) => {
      if (!t) return;
      const last = out[out.length - 1];
      if (last && last.type === 'text') last.text += t;
      else out.push({ type: 'text', text: t });
    };
    if (depth > MAX_DEPTH) { push(text); return out; }
    const re = new RegExp(INLINE.source, 'g');
    let at = 0;
    let m;
    while ((m = re.exec(text))) {
      push(text.slice(at, m.index));
      at = re.lastIndex;
      if (m[1] !== undefined) {
        // One space inside each end is padding (`` `a` `` shows `a`), unless that's all there is.
        let code = m[2].replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out.push({ type: 'code', text: code });
      } else if (m[3] !== undefined) out.push(linkOf(m[4], inline(m[3], depth + 1)));
      else if (m[5] !== undefined) out.push(linkOf(m[5], [{ type: 'text', text: m[5] }]));
      else if (m[6] !== undefined) out.push(linkOf(m[6], [{ type: 'text', text: m[6] }]));
      else if (m[7] !== undefined || m[8] !== undefined) out.push({ type: 'strong', children: inline(m[7] !== undefined ? m[7] : m[8], depth + 1) });
      else if (m[9] !== undefined) out.push({ type: 'del', children: inline(m[9], depth + 1) });
      else if (m[10] !== undefined || m[11] !== undefined) out.push({ type: 'em', children: inline(m[10] !== undefined ? m[10] : m[11], depth + 1) });
      else push(m[12]);
    }
    push(text.slice(at));
    return out;
  }

  const Deck = (window.Deck = window.Deck || {});
  Deck.markdown = { parse, inline };
})();
