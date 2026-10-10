'use strict';
// Long pastes in the reply box, as Claude Code's prompt takes them (2.1.284; see
// docs/CLAUDE-CODE-INTERNALS.md, "Pasted text"): a paste longer than 800 characters or with more
// than 2 line breaks goes in as "[Pasted text #1 +123 lines]" (the count is its line breaks), and
// the text itself is sent in its place. Kept apart from app.js so test/pasted-text.test.js can run it.

(function () {
  const MAX_CHARS = 800;
  const MAX_BREAKS = 2;
  const TOKEN = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const breaks = (text) => (text.match(/\n/g) || []).length;

  // As Claude Code takes a paste: Windows line endings become \n, and tabs four spaces.
  const normalize = (text) => String(text).replace(/\r\n|\r/g, '\n').replace(/\t/g, '    ');

  const collapses = (text) => text.length > MAX_CHARS || breaks(text) > MAX_BREAKS;

  const placeholder = (id, text) => {
    const n = breaks(text);
    return n ? `[Pasted text #${id} +${n} lines]` : `[Pasted text #${id}]`;
  };

  // The ids of the placeholders in a message, in order.
  const idsIn = (message) => [...String(message).matchAll(TOKEN)].map((m) => Number(m[1]));

  // The message as sent: each placeholder replaced by its text, and where each paste's text sits in
  // it ([start, end] pairs), so the chat can show the placeholder again. One whose text isn't kept
  // (typed by hand, say) stays as it is.
  const expand = (message, pastes) => {
    const msg = String(message);
    let text = '';
    let at = 0;
    const ranges = [];
    for (const m of msg.matchAll(TOKEN)) {
      if (!has(pastes, m[1])) continue;
      text += msg.slice(at, m.index);
      ranges.push([text.length, text.length + pastes[m[1]].length]);
      text += pastes[m[1]];
      at = m.index + m[0].length;
    }
    return { text: text + msg.slice(at), ranges };
  };

  // The other way, for a sent message: its text in pieces, each paste with its placeholder
  // (numbered from 1), for the chat to show and for ↑ to put back in the reply box.
  const pieces = (text, ranges) => {
    const out = [];
    let at = 0;
    (ranges || []).forEach(([start, end], i) => {
      if (start > at) out.push({ text: text.slice(at, start) });
      const body = text.slice(start, end);
      out.push({ id: i + 1, text: body, label: placeholder(i + 1, body) });
      at = end;
    });
    if (at < text.length || !out.length) out.push({ text: text.slice(at) });
    return out;
  };

  // A sent message back in the reply box: placeholders, and the texts they stand for.
  const collapse = (text, ranges) => {
    const texts = {};
    const value = pieces(text, ranges).map((p) => {
      if (!p.id) return p.text;
      texts[p.id] = p.text;
      return p.label;
    }).join('');
    return { value, texts };
  };

  // The next paste's number: one more than the highest still in the message, so each message
  // starts again at #1.
  const nextId = (message) => Math.max(0, ...idsIn(message)) + 1;

  // Where paste #id's placeholder is in the message, or null.
  const find = (message, id) => {
    for (const m of String(message).matchAll(TOKEN)) {
      if (Number(m[1]) === id) return { start: m.index, end: m.index + m[0].length };
    }
    return null;
  };

  const Deck = (window.Deck = window.Deck || {});
  Deck.pastedText = { MAX_CHARS, MAX_BREAKS, normalize, collapses, placeholder, idsIn, expand, pieces, collapse, nextId, find };
})();
