---
name: Claude Deck
description: A railway signal box for Claude Code sessions. Enamel frame, cream reading shelf, engraved plates, lamps in bezels.
colors:
  frame: "#44524b"
  frame-2: "#4f5e56"
  frame-3: "#5b6b62"
  frame-text: "#f3eedf"
  frame-muted: "#d3d8c9"
  shelf-cream: "#f4f0e4"
  panel-cream: "#fbf8ef"
  panel-sunk: "#ebe5d5"
  raise: "#fffdf6"
  ink: "#1f2421"
  ink-muted: "#4f5650"
  ink-faint: "#626862"
  plate: "#1d2320"
  plate-text: "#f1ebd8"
  bezel: "#1b201d"
  lamp-waiting: "#e39a0b"
  lamp-working: "#a9d0f5"
  lamp-idle: "#2d9a5d"
  lamp-ended: "#7c847e"
  danger: "#b8322a"
  focus-ring: "#2f6db5"
  link: "#265d9c"
  diff-add: "#217a41"
  diff-del: "#b3261e"
  mascot-coral: "#d97757"
  frame-dark: "#34423b"
  shelf-dark: "#1a1f1d"
  panel-dark: "#202624"
  ink-dark: "#ebe6d6"
  plate-dark: "#0e1210"
  lamp-waiting-dark: "#f2b01e"
  lamp-working-dark: "#f7f3e3"
  lamp-idle-dark: "#3db872"
typography:
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  prose:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.5
  meta:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  plate-label:
    fontFamily: "Bahnschrift, Segoe UI Variable Display, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.06em"
  mono:
    fontFamily: "Cascadia Code, Cascadia Mono, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  enamel: "3px"
  control: "4px"
  menu: "6px"
  pill: "9px"
  lamp: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  gutter: "32px"
  shelf-height: "44px"
  track-width: "300px"
  track-narrow: "58px"
  column: "560px"
components:
  button-default:
    backgroundColor: "{colors.panel-cream}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-default-hover:
    backgroundColor: "{colors.raise}"
  button-primary:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.plate-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  plate:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.plate-text}"
    typography: "{typography.plate-label}"
    rounded: "{rounded.enamel}"
    padding: "3px 9px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.frame-muted}"
    typography: "{typography.plate-label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
  nav-item-current:
    backgroundColor: "{colors.shelf-cream}"
    textColor: "{colors.ink}"
  track-row:
    backgroundColor: "transparent"
    textColor: "{colors.frame-text}"
    rounded: "{rounded.control}"
    padding: "7px 34px 7px 10px"
  track-row-selected:
    backgroundColor: "{colors.shelf-cream}"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.panel-cream}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "6px 9px"
  menu:
    backgroundColor: "{colors.panel-cream}"
    textColor: "{colors.ink}"
    rounded: "{rounded.menu}"
    padding: "4px"
  lamp:
    backgroundColor: "{colors.lamp-ended}"
    rounded: "{rounded.lamp}"
    size: "10px"
---

# Design System: Claude Deck

## Overview

**Creative North Star: "The Signal Box"**

Claude Deck is one signal-box panel. A gray-green stove-enamel frame (the shelf across the top, the track panel down the left, the History list) surrounds a calm reading shelf. In the day world the shelf is cream enamel. In the dark world the roles swap: the frame is the lighter green and the shelf is the darker surface. Every session is a line with a lamp, and the line you pick "sets a route" into the reading shelf. It is a working tool that sits maximized on its own monitor and is glanced at all day, so the theming stays in the materials (enamel, engraved plates, lamps, hairline rules) and never becomes props such as levers, track drawings or bells.

Rank comes from four things only: weight, capitals, reversed plates and rules. There are two type sizes. There are no cards, gradients, glow or blur; structure is hairline rules and flat enamel planes, and depth exists only on things that float (menus, popovers, dialogs, toasts).

The system must survive 15 themes. Each theme supplies base colors; the frame, plates, bezel, lines and washes are mixed from them in one shared theme block, so the signal-box grammar holds in every palette.

**Key Characteristics:**
- Frame around a reading shelf; the selected row takes the shelf's color and runs flush into it.
- Black enamel plates with engraved capitals name views, groups, dialogs and fact labels.
- Status is a lamp in a dark bezel, never a colored card or badge.
- Two sizes (14px, 12px), one reading column (560px, about 72ch).
- Mechanical motion: 120-160ms, no bounce.
- System fonts only, drawn SVG icons, one preserved 14x10 pixel mascot.

## Colors

Weathered green enamel and warm cream, with signal lamps as the only saturated color. Values in the frontmatter are the day world; the `-dark` entries are the default dark world.

### Primary
- **Frame Enamel Green** (frame, #44524b day; frame-dark #34423b): the shelf, track panel and History list. Hover steps to frame-2, deeper steps to frame-3. Text on it is frame-text, secondary frame-muted.
- **Reading Shelf Cream** (shelf-cream, #f4f0e4; shelf-dark #1a1f1d in the dark world): the page the conversation is read on, and the color the selected row and current view plate take.

### Secondary
- **Engraved Black Plate** (plate, #1d2320; plate-dark #0e1210): reversed plates for engraved labels, the primary button, active segments, toasts. Its text is plate-text.

### Tertiary (the lamps)
- **Waiting Amber** (lamp-waiting, #e39a0b; #f2b01e dark): needs you; flashes at 1 Hz.
- **Lunar White** (lamp-working, #a9d0f5 day, a blue-white that stays lit on cream; warm white #f7f3e3 dark): working. Other themes use their own working color.
- **Signal Green** (lamp-idle, #2d9a5d; #3db872 dark): idle.
- **Unlit** (lamp-ended, #7c847e): ended.
- **Stop Red** (danger, #b8322a): errors, destructive actions, over-limit needles.

### Neutral
- **Cream Panel / Sunk / Raised** (panel-cream #fbf8ef, panel-sunk #ebe5d5, raise #fffdf6): field and code surfaces, hover and pressed washes.
- **Ink** (ink #1f2421, ink-muted #4f5650, ink-faint #626862): text ranks on the shelf.
- **Bezel** (bezel #1b201d): the dark ring round every lamp.
- **Rules**: line, line-soft and line-strong are ink at 13%, 7% and 24% (day). Never solid gray borders.
- **Focus and link** (focus-ring #2f6db5, link #265d9c): interaction only.
- **Diff** (diff-add, diff-del) and seven tag colors (slate, cyan, amber, sage, rose, violet, sand) carry their own tokens and never stand in for status.
- **Mascot Coral** (mascot-coral, #d97757): the pixel mascot only (and the working spinner mark). The Claude theme also uses it as that theme's plate and focus color.

### Named Rules
**The Lamp-Only Status Rule.** Status is shown by a lamp lens in a bezel (10px lens, 2px bezel). Amber, white, green and unlit belong to status; no other element borrows them as decoration.
**The Derived Frame Rule.** A theme sets base colors only. Frame, plates, bezel, lines and washes are `color-mix` results of those bases in the shared theme block; do not hand-set them per theme except where a theme must (high-contrast).

## Typography

**Body Font:** Segoe UI Variable Text (with Segoe UI, system-ui, sans-serif)
**Plate Font:** Bahnschrift (with Segoe UI Variable Display, Segoe UI), set at font-stretch 87.5%
**Mono Font:** Cascadia Code (with Cascadia Mono, Consolas, monospace)

**Character:** Windows' own DIN lettering engraved in capitals on plates, over a quiet system UI face. Only system faces load, by product rule (no remote fonts).

**User choice:** Preferences → Appearance → Text font and Label font replace the body and plate stacks (`--font`, `--font-plate`) with another font that ships with Windows (`FONTS` in `src/prefs.js`, `FONT_CHOICES` in `public/app.js`). The sizes, weights, capitals and tracking above stay the same in any font; build against the variables, never a literal family.

### Hierarchy
- **Title** (700, 14px, 1.5): session names, headings inside content, rename input. Headings are not larger, only bolder.
- **Body** (400, 14px, 1.5): UI and lists. Row titles and your turns take weight 600.
- **Prose** (400, 14px, 1.6): assistant replies, in the 560px column (about 72ch).
- **Meta** (400 or 600, 12px): status text, since, sub-lines, fact readings, tool lines.
- **Plate label** (Bahnschrift 600, 12px, 0.06em, uppercase, stretch 87.5%): view names, group labels, dialog titles, fact labels, section labels. The brand name is 700 at 0.08em.
- **Mono** (Cascadia, 12px): code, paths, ids, model ids, tool names, diffs.

### Named Rules
**The Two Sizes Rule.** 14px and 12px. Rank comes from weight, capitals, reversed plates and rules, not from a third size.
**The Engraved Capitals Rule.** Capitals belong to short plate labels only; running text, buttons and values stay in sentence case.
**The Your-Turn Rule.** Your turns are weight 600 under a hairline rule with an engraved "YOU" label. No bubble, band or card.

## Layout

A viewport-height grid: a 44px shelf, then the view. Sessions is a two-column grid: the track panel (300px default, resizable by a splitter on the boundary, Ctrl+B narrows to 58px lamps-only) and the reading shelf. History uses the same grammar with a 300-380px list. Below 900px the columns stack and the shelf wraps.

One reading column (560px, about 72ch) is shared by prose, your turns, tool lines, the attachment tray and the reply bar, centered with a stable scrollbar gutter so the column stays over the reply bar. The line plate at the top of a session is one flex line (lamp, name, menu, status, since, extras, folder, id, actions), then one instrument row: engraved labels beside readings, spaced with gap rather than ruled, so a wrapped row starts flush. Content gutters are 28-32px; small gaps step 4, 8, 12, 16, 24.

Instruments show a value plus the last-turn change (context, cost, tokens). Needles move by `transform: scaleX` over 600ms.

## Elevation & Depth

Flat by default; depth is tonal. The frame, shelf and plates are flat enamel planes separated by hairline rules. Only floating surfaces (menus, plugin popover, usage popover, slash list, toasts, dialogs) carry a soft offset shadow and a 1px strong rule. No blur, glass or glow anywhere; the dialog backdrop is a flat wash of the frame color.

### Shadow Vocabulary
- **Pop** (day `box-shadow: 0 10px 26px -8px rgba(40,36,24,0.3), 0 2px 6px -2px rgba(40,36,24,0.18)`; dark `0 10px 28px -6px rgba(0,0,0,0.55), 0 2px 6px -2px rgba(0,0,0,0.4)`): menus, popovers, toasts.

### Named Rules
**The Flat Enamel Rule.** Surfaces at rest have no shadow. A shadow means the surface floats above the page.

## Shapes

Small, square-shouldered enamel. Plates are 3px, controls and rows 4px, menus, popovers and dialogs 6px, count and state pills 9px, lamps circular. The selected track row and History row round only their left corners (4px 0 0 4px) because their right edge is flush into the shelf. The current view plate rounds only its top corners and drops into the page below. Borders are 1px hairlines; lamps carry a 2px bezel. On the cream shelf a lamp gets a 2.5px outline in the frame green, as if mounted in its plate.

## Components

### Buttons
- **Shape:** 4px radius, 1px strong rule, padding 5px 12px (small 2px 8px).
- **Default:** cream panel fill, ink text; hover raises to the raise tone, pressed sinks to panel-sunk.
- **Primary:** the black plate fill with plate-text, weight 600. On the shelf, the New session button is frame-text on frame.
- **Ghost / Danger / Link:** ghost is transparent until hover; danger is transparent with a red rule and red wash on hover; link is underlined text.
- **Icon buttons:** drawn SVG only.

### Plates
- Black enamel, 3px radius, padding 3px 9px, engraved plate label type. Used for the view name, group labels in the track panel and History, lane and section headings, dialog titles, active tabs and segments, selected question options.

### Navigation (view plates on the shelf)
- Engraved capitals on the frame, muted; hover lightens to frame-2. The current view plate is cream, ink text, top corners rounded, margin-top 8px so it drops into the page. A waiting count is an amber pill with a bezel-colored ring.

### Track rows (signature: setting the route)
- Rows sit on the frame: lamp, name at weight 600 (tag color as an 8px enamel tab before it), sub-line in meta. Hover is frame-2. The selected row takes the shelf color and text, runs flush to the shelf edge, and a newly picked row reveals with a 160ms `clip-path` from the lamp side. Re-selecting the same row does not replay it. The row's trash action is quiet until hover or selection.

### Lamps
- 10px lens, 2px bezel. Waiting flashes at 1 Hz from one page clock (`html.lamps-dim` toggled every 500ms, dimmed to 55% toward the bezel); under reduced motion it is steady with an inset notch so it still differs from working.

### Inputs / Fields
- 4px radius, 1px strong rule, panel fill, padding 6px 9px. Focus: 2px focus-ring outline, inset 1px, border becomes transparent. Field labels are plate labels in muted ink.

### Menus, popovers, dialogs
- Overlay fill, 1px strong rule, 6px radius, Pop shadow, `pop-in` (160ms, 3px rise). The model menu is a popover in the top layer with flyouts touching their parent item so the pointer never crosses a gap. Dialogs start with a plate title and end with a ruled action row.

### Instruments
- Engraved label beside a reading; needle bar 44-56px by 5px; over-limit turns amber then red. Context, cost and tokens append the last-turn change in faint 500 weight.

### Tool lines and code
- Ruled lines in a register (top and bottom soft rules, mono names), disclosure via a drawn chevron. Code blocks are a panel fill with a 1px rule and 4px radius.

### Icons
- Drawn SVG through `Deck.icon`: 16 grid, 1.5 stroke, `currentColor`.

## Do's and Don'ts

### Do:
- **Do** rank with weight, capitals, reversed plates and hairline rules within the 14px and 12px sizes.
- **Do** show status as a lamp in a bezel and mix any new wash from the status token with `color-mix`.
- **Do** put the selected list item on the reading shelf's color, flush to the shelf.
- **Do** use 120-160ms with `cubic-bezier(0.22, 0.8, 0.3, 1)`; disable animation under reduced motion.
- **Do** keep prose, turns, tool lines and the reply bar in the shared 560px column.
- **Do** use Cascadia for code, paths, ids and model ids.
- **Do** derive new theme surfaces from the theme's base colors in the shared block.

### Don't:
- **Don't** use boxed stat cards, a left icon rail, glow, gradients, blur or glass.
- **Don't** use bounce or spring easing.
- **Don't** load remote fonts.
- **Don't** use emoji or text glyphs as icons; draw them.
- **Don't** use amber, white, green or unlit gray for anything but status.
- **Don't** add railway props (levers, track drawings, bells) that get in the way of work.
- **Don't** put engraved capitals on running text or button labels.
