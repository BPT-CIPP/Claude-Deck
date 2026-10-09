# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(A local web page served by Claude Deck's own Node server on 127.0.0.1, shown in a Microsoft Edge
app window, usually installed as an Edge app with its own taskbar pin. Windows only.)

## Users

The Bastionpoint Technology team: IT / managed-service people who run many Claude
Code sessions at once on managed Windows laptops. They work in other windows most of the time
(tickets, client portals, admin consoles) and come to Claude Deck in short visits: see which
sessions need them, answer a permission prompt or question, reply, start a new session, then leave.
Confirmed by the user, 2026-09-29.

## Product Purpose

One window for all of a person's Claude Code sessions on Windows: start sessions in any folder, see
at a glance what each is doing (needs you, working, idle, ended), reply to them, approve what they
want to do, watch their subagents, review and undo the files they changed, pick up old conversations
from history, and edit Claude Code's settings. Success is never missing a session that is waiting
on you, and getting back to other work fast.

## Positioning

It drives the user's own `claude` (Claude Code's streaming JSON mode, plus tracked Windows Terminal
tabs) with their own sign-in and plan, and reads only the files Claude Code already writes. It
makes no Claude API calls and adds no cost, installs nothing new (no npm packages, no new
executables), and so runs on locked-down PCs where Defender blocks unfamiliar programs.

## Operating Context

- Short, interrupt-driven visits between other work; desktop notifications and the taskbar icon
  (the mascot sweats while working, gets an amber dot when a session needs you) pull the user back.
- Several sessions at once, in different project folders; some as in-app chats, some as Windows
  Terminal tabs, some started outside Claude Deck.
- Keyboard heavy: Ctrl+K search, Ctrl+Shift+N new chat, Ctrl+Tab between sessions, Ctrl+W end,
  arrows in the list, Esc back to the list, ↑ to recall messages.
- Desktop only: laptop screens and external monitors; the Edge app window can be any size.

## Capabilities and Constraints

- Areas: Sessions (grouped list + selected session in full: chat, header controls for model,
  effort, permission mode, plugins, context meter, cost, tokens), subagents panel, Changes (files per
  turn, diffs, restore, undo), History (search, preview, resume, fork, delete with undo), Plan usage,
  Most tokens this week, New session dialog, Claude Code Settings editor (form + raw JSON, CLAUDE.md),
  Claude Deck Preferences, Ctrl+K palette, keyboard shortcut list, notifications.
- Hard technical rules (CLAUDE.md): no build step, no npm dependencies, no new executables; plain
  browser scripts on `window.Deck`; DOM built with `Deck.h()`, never `innerHTML` (transcript text is
  untrusted); no remote fonts, CDNs or network requests from the page; system fonts only.
- All server APIs, events and behavior stay as they are; `npm run verify` must stay green.
- Status lamps (decided with the signal-box redesign, 2026-09-29, and recorded in CLAUDE.md): amber
  needs you (flashing), lit white working (the theme's own working color in the other themes), green
  idle, unlit ended.

## Brand Commitments

- Name: Claude Deck. © Bastionpoint Technology, MIT licensed.
- The 14x10 pixel mascot (tools/make-icons.js and the SVG in public/index.html) is the brand mark
  and taskbar icon; keep it. Binding, 2026-09-29.
- The 15 themes in Claude Deck Preferences (Match Windows, Dark, Light, Claude, Midnight, Graphite,
  Nord, Dracula, Forest, Ocean, Solarized Dark, High Contrast, Sepia, Solarized Light, Rose) must all
  keep working. Binding, 2026-09-29.
- Copy voice (CLAUDE.md): sentence case, plain verbs; errors say what happened and what to do.

## Evidence on Hand

- README.md (features, shortcuts, troubleshooting), docs/ARCHITECTURE.md, the running app (use the
  sandbox, `npm run sandbox`).
- No testimonials, metrics or customers exist; don't invent any.

## Product Principles

1. What needs you comes first: a waiting session must be impossible to miss.
2. Get in and out fast: every common job (reply, approve, switch session, start one) is one or two
   keystrokes or clicks away.
3. Show Claude Code truthfully: display what Claude Code reports, in its own terms, without
   inventing state.
4. Nothing new on the machine, nothing extra on the bill.

## Accessibility & Inclusion

- High Contrast theme must stay usable; keyboard access to everything that exists today.
- Status must never rely on color alone (labels and grouping already carry it).
