---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/app.css","public/app.js","public/lib.js","public/settings-ui.js"]
---

# Claude Deck app shell (all views)

Scope: the whole Claude Deck page (public/index.html, app.css, app.js, lib.js, settings-ui.js):
the shelf, Sessions, History, Claude Code Settings, Preferences, dialogs, menus, toasts.
Visitor mode: Operate.

Audience and job: the Bastionpoint team; Claude Deck lives maximized on its own monitor
all day. Most used: reading long replies and starting sessions; glancing for sessions that need
them. Must not feel over-themed: no railway props (levers, track drawings, bells) in the way of
work. Keep: the pixel mascot; all 15 themes working.

## Direction contract

THESIS: Claude Deck is one signal-box panel: every session is a line with a lamp, and the line you
pick sets a route into a calm enamel reading shelf. It refuses the dark neon dev dashboard (left
nav rail, boxed stat cards, glow, glass).

OWN-WORLD: Gray-green stove-enamel frame (shelf across the top, track panel down the left) around
a cream enamel reading shelf; black enamel plates with engraved Bahnschrift capitals for headers,
group labels and primary actions; lamps in dark bezels (amber needs you, lit white working, signal
green idle, unlit ended, red stop). Hairline rules, not cards. Two type sizes; rank by weight,
capitals, reversed plates, rules. No gradients, glow or blur.

STORY: The user glances at the lamps, opens the calling line, reads the reply at a comfortable
measure, answers, and starts the next session from the shelf's New session plate.

FIRST VIEWPORT: 1920x1080. Shelf 44px: mascot and name plate, view plates, plan-usage
instruments, search, connection lamp, New session plate at the right. Track panel 300px: filter,
reversed group plates, session lines. Right: one-row line plate (lamp, name, folder, id), one
instrument row (model, effort, permissions, plugins, context, cost, tokens, End), then a 72ch
reading column with the reply bar docked beneath it.

Signature interaction: setting the route. The selected line's plate turns cream and runs flush
into the reading shelf, so the list and the conversation read as one route; needs-you lamps flash
at 1 Hz (steady with a notch under reduced motion). Motion: mechanical detents, 120-160 ms
ease-out, no bounce. Raises: instruments show value and last-turn change, damped (from the
night-flight six-pack); two type sizes (from the timetable rack); name plates rename in place
(from HyperCard).

FORM: candidate 6 of 7 (railway signal box), seed key c9b0b51c.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Status colors: working moves from cyan to lit white in the default themes; CLAUDE.md's status
  color line is updated with it.
