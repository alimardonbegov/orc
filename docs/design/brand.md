# The orc brand: an orc at the controls

This document is for anyone who touches the mark, the name or the interface copy. It explains
**why** the brand is built the way it is; the "how" is visible in the code and on the brand
book page served by the server itself: `http://127.0.0.1:8765/brand/index.html` (source:
`web/public/brand/index.html`). The interface styling rules live separately, in
`docs/design/ui-design.md`; the brand is subordinate to them, not the other way round.

## Name

`orc` is short for "orchestrator". It reads as the word "orc", and we lean into that
instead of being shy about it.

- Always lowercase and monospaced: it is the name of the command in the terminal. "Orc" and
  "ORC" never appear in the interface.
- The expansion is needed once, at first contact: "orc, a task orchestrator for Claude
  Code". After that, just orc.
- The word "orc" as a character never appears in interface copy. The interface speaks of
  the dispatcher, agents, tasks and branches. The orc is how the control room looks and
  behaves, not its vocabulary.

## The idea: a squad that goes to work on its own

The orc of fantasy games is not a villain but a worker: blunt, direct, tireless and always
part of a squad. That is an exact description of what orc does: agents take tasks from the
queue, each goes off to its own worktree and comes back with a result; they need a human
rarely and at an unpredictable moment.

Three visible decisions follow from the idea:

1. **The mark is an orc's head**, not an abstract glyph. It is recognizable at 16 pixels
   and needs no backing plate.
2. **The orc's eyes glow while the dispatcher is alive.** This is the only place where the
   brand meets the system state, and it obeys the interface rule "color = state".
3. **Five orc glyphs** (horn, campfire, banner, axe, tusk) appear only where they carry
   meaning, and do not replace the status icons from lucide.

## The mark

A skull with a heavy brow and ears, a slit mouth, and two tusks growing from the lower jaw
and overlapping the slit. Five outlines on a 32x32 grid, straight segments only, so the
mark stays sharp at any scale. The silhouette is drawn in `currentColor`, the eyes are a
separate layer.

The geometry lives in one place, `web/src/brand/markPaths.ts`, and is repeated in static
files (`web/public/favicon.svg`, `web/public/brand/*.svg`, the brand book page script). If
you change the mark, change every copy; that is the price of keeping the favicon and the
brand book free of a build step.

Rules:

- The minimum size is 16 px: below that the tusks disappear, and the mark is not used at
  all.
- The clear space is a quarter of the mark's side on every side. Nothing inside it except
  the name in the lockup.
- Not allowed: a square backing plate, a different eye color, a recolored silhouette,
  rotation, non-proportional scaling, gradients, shadows, outlines.
- The full-color variant with bone tusks (`--tusk`) is for use outside the interface only
  (cover art, stickers). On screen, bone would compete with the amber "in progress" status.

## The eyes mean state

The interface has one palette rule: the chrome is colorless, any colored spot is a task
state, and the single exception is the phosphor `--live`, the dispatcher's heartbeat. The
orc's eyes glow in that same color under that same rule: they are not a second brand color,
but the same signal shown where it is visible even when the panel is collapsed.

| eyes | meaning | where |
| --- | --- | --- |
| dimmed (silhouette, 35 %) | the dispatcher is paused or not responding; there is no work | sidebar, empty states |
| glowing `--live` | the dispatcher is alive, agents are free | sidebar, the "About orc" block in settings |
| glowing and breathing | at least one agent is working right now | sidebar, in rhythm with the header dot |

The eyes never have another color. "Red eyes for a failure" is out: a failure is shown by
the card.

In code these are two `OrcMark` flags: `awake` and `working`. `working` without `awake`
does not light the eyes: work is impossible without a live dispatcher, and the mark must
not lie.

## Palette

The brand has no color of its own on top of the interface palette. Graphite is the
surface, ink is the mark, phosphor is life.

| role | dark | light |
| --- | --- | --- |
| canvas | `#0b0d11` | `#f3f4f7` |
| ink (silhouette) | `#e9ebf0` | `#14171d` |
| phosphor `--live` (eyes) | `#4ade80` | `#16a34a` |
| bone `--tusk` (outside the UI only) | `#d8c9a8` | `#a89a78` |

Status shades are in `docs/design/ui-design.md`; the brand does not touch them.

## Typography

IBM Plex Sans for everything a human reads; IBM Plex Mono for machine strings, and the name
`orc` is one of them. In the "mark + name" lockup (`OrcLogo`) the gap is half the mark's
side, the name's font size is three quarters of the side, the weight is 600, and the
tracking is negative. The "agent control room" tagline appears only in the sidebar and in
the lockup for documents.

## Glyphs

`web/src/brand/glyphs.tsx` holds five icons in the lucide language (24 grid, 2 stroke,
round caps):

| glyph | meaning | where it appears |
| --- | --- | --- |
| horn `Horn` | a call for the human | the "Waiting for me" strip, the "Waiting for me" filter in the header |
| campfire `Campfire` | the squad is resting | "agents are free" in the dispatcher panel |
| banner `Banner` | a project, the squad's standard | the brand book only, for now |
| axe `Axe` | work is under way | the brand book only, for now |
| tusk `Tusk` | the mark in a single stroke | a marker, a bullet |

The rule: a glyph replaces a lucide icon only if it says the same thing more clearly. Task
status icons (`STATUS_META`, `BLOCKER_META`) stay lucide.

## Voice

Short, verbs first, to the point. Not pathos and not a roar: the confidence of someone who
knows what to do. Humor is allowed in two places: empty states and the brand book. Never in
errors, confirmations or agent instructions: there the text explains what happened and what
to do by hand.

| do | don't |
| --- | --- |
| Agents are free | The horde rests by the campfire 🔥 |
| The task is not written. Finish the task | The orc did not understand what is wanted of it |
| No connection to the server: check that it is running | The chief does not answer the horn's call |

## Where the brand shows in the interface

- The sidebar header: the lockup of mark + `orc` + "agent control room"; in the collapsed
  rail, the mark alone with a state tooltip. The eyes follow the table above.
- Empty states of the board (`EmptyState` in `App.tsx`): a sleeping orc above the text.
- The dispatcher panel: a campfire next to "agents are free".
- The "Waiting for me" strip and filter: the horn.
- The orc settings: an "About orc" block with the lockup and a link to the brand book.
- The browser tab: the favicon adapts to the browser theme itself
  (`prefers-color-scheme` inside the SVG). Once the app has loaded, the tab title is `orc`,
  with the number of unread events in parentheses when there are any (`EventsPanel.tsx`).
  The static title in `web/index.html`, shown only before that, is just `orc`.

## Files

- `web/src/brand/markPaths.ts`: the mark geometry.
- `web/src/brand/OrcMark.tsx`: the mark as a component (`size`, `awake`, `working`, `title`).
- `web/src/brand/OrcLogo.tsx`: the mark + name lockup.
- `web/src/brand/glyphs.tsx`: the orc glyphs.
- `web/public/favicon.svg`: the tab icon.
- `web/public/brand/orc-mark-{dark,light,mono,full,asleep}.svg`: the mark for documents.
- `web/public/brand/orc-lockup-{dark,light}.svg`: the lockup for documents.
- `web/public/brand/glyph-{horn,campfire,banner,axe,tusk}.svg`: the glyphs.
- `web/public/brand/index.html`: the brand book page, `/brand/index.html` on a running server.
