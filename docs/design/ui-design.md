# orc design: decisions and their reasons

This document is for anyone who will work on the interface. It explains not "how it is
done" (the code shows that) but **why it is done this way**, so that the next change does
not break the system piece by piece.

## What this thing is

orc is a local control room from which one developer keeps several autonomous agents. The
agents work in parallel in git worktrees, verify their own results and merge them
themselves. They need a human rarely and at an unpredictable moment: to answer a question,
resolve a conflict, restart a failed task.

So the main job of the interface is not "to show tasks" but **to direct attention**: to
answer at a glance whether intervention is needed right now, and if so, where exactly.
Everything else is subordinate to that.

## The metaphor: flight strips

The reference image is an air traffic controller's paper strips. Each flight is a strip in
a colored holder; the strip moves from bay to bay without changing shape, and the color of
the holder tells the state. The controller does not reread the strips: they look at the
colors and step in where needed.

This maps onto the domain without a stretch: a task travels through phases, the shape of
the card is the same everywhere, and only the colored tick on the left changes. Hence:

- the card (`TaskCard`) is a "strip" with a `w-[3px]` holder at the left edge;
- the column (`Column`) is a "bay", not just a list;
- dragging draws the strip in a separate layer (`DragOverlay`) with a slight tilt: it
  follows the cursor instead of pushing the layout around.

There are four bays: "Backlog", "To do", "In progress", "Done", because the human cares
about the outcome, not about the stage inside the work. The dispatcher's intermediate
statuses (`verifying`, `merging`) have no column of their own: they live in "In progress"
and are read from the badge on the card and the color of the holder. The layout is defined
by the `COLUMN_OF` map in `Board.tsx`, the one place where a backend status is mapped to a
column.

Inside a bay, cards that are waiting for an answer float to the top (`withWaitingFirst`):
a question at the tail of a long list gets lost, while the board looks as if everything is
going fine on its own.

## The palette rule: color = status

**The chrome is colorless. Any colored spot on the screen means a task state.**

An unobvious consequence: the primary button is monochrome (ink on paper in the light
theme, paper on ink in the dark one). A brand-blue button would compete with the status
badges and devalue color as a signal.

The status wheel is chosen so that neighboring hues differ in more than lightness (see
`--st-*` in `web/src/index.css`):

| status | hue | why |
| --- | --- | --- |
| Backlog | gray-blue | an inert state, almost no color |
| To do | light blue | put in the queue |
| In progress | amber | the only warm hue among the working ones, noticeable in peripheral vision |
| Verifying | violet | has no column of its own, lives as a badge in "In progress" |
| Merging | teal | the same: a badge, not a column |
| Done | green | — |
| Failed | red | — |
| **Awaiting reply** | **magenta** | does not coincide with anything else: it is a direct call for the human |

The single exception to the rule is `--live`, the phosphor color of the dispatcher's
heartbeat. There is only one on the whole screen, and it means "the system is alive". The
orc's eyes in the mark (`web/src/brand/OrcMark.tsx`) glow with the same color under the
same rule: it is not a second brand color but the same signal, visible even when the
sidebar is collapsed.

In the light theme the same hues are darkened to a contrast of at least 4.5:1 on white: a
neon version on paper is unreadable.

The same rule implies that **projects have no color of their own**. The temptation to give
every project a tint label is strong: the event feed is shared across all projects, and
they have to be told apart at a glance. But a colored project label would sit in a row next
to the status color and the event level color, and none of the three spots would mean
anything anymore. A project is distinguished **by shape, not by color**: by a two-letter
monogram (`web/src/lib/initials.ts`) that stands in the same place in every row, the same
one as in the collapsed sidebar. One monogram per project across the whole interface:
otherwise the same project would look different in two places.

## Brand: an orc at the control room

The name `orc` reads as the word "orc", and the brand is built on that: the mark is an
orc's head with tusks whose eyes glow while the dispatcher is alive; five orc glyphs (horn,
campfire, banner, axe, tusk) stand where they carry meaning: the horn by "Waiting for me",
the campfire by "agents are free". This does not change the interface metaphor: cards stay
flight strips, and the words stay dispatcher, agents and tasks. The rules and reasons are
in `docs/design/brand.md`, and the live page is `/brand/index.html` on a running server.

## Typography

IBM Plex Sans for the interface, IBM Plex Mono **only for machine strings**: task numbers,
branches, paths, session identifiers, event times. Monospace here is not decoration but a
sign that "this can be copied and pasted into a terminal". Field labels are set in regular
case: an all-caps "eyebrow" over every block is the most recognizable sign of templated
layout, and in columns one after another it reads as a fence.

The base is 13px: the tool is dense, with four columns on screen at once.

## Motion

Animation answers a human action: open, close, expand, drag. There are no background
effects except two, and both carry meaning:

- the pulse of the dispatcher dot means "agents are busy right now";
- the thread under the header means the same, but is visible from anywhere on the screen.

Both turn off under `prefers-reduced-motion`.

## Overlays

All popup layers are built on Radix (`web/src/ui/Modal.tsx`, `Overlays.tsx`): a portal to
the end of `body`, a focus trap, focus return to the source button, Escape, background
scroll lock, positioning that accounts for screen edges.

Before that, the modal was a homemade `div` with an `onClick` on the backdrop: it closed on
a click anywhere inside, did not hold focus or return it, and the event panel was
`absolute` inside the header, so it got clipped and covered buttons.

The closing rule: **a click outside the window is blocked while there is unsaved input;
Escape always closes.** Missing the window is an accident, Escape is a deliberate action,
and the human's way out from the keyboard must not be taken away.

An irreversible action always goes through `ui/Confirm.tsx`, not through
`window.confirm`: the system dialog can neither explain the consequences nor name the
button after the action. The rule for confirmation text is to say **what will disappear and
what will have to be done by hand afterwards**: for closing a task by hand, that is an
unmerged branch; for deletion, irreversibility, the fate of the branch and worktree (they
can be kept by unticking the box), and the list of tasks that were waiting on this
dependency. Archiving needs no confirmation: it is reversible with one button.

Dropdowns stayed native `<select>` elements in their own "box": the system list opens
instantly, works from the keyboard and does not break inside a modal. A custom dropdown
would add nothing here except weight.

## An image in the task text

A task statement is the human's line to the agent, and in a line a screenshot has its
place: "like this now", an image, "but it should be like this", an image. That is why the
task field accepts an image in three ordinary ways (`Ctrl+V`, drag-and-drop, the "Image"
button) and puts it **at the cursor position**, not into a separate gallery under the text.
A gallery would break the link "this piece of text is about this image", which is exactly
what the image is inserted for.

The field shows the marker `![caption](orc-image:7)`, not the image itself: a marker is a
string, and it can be selected, moved and deleted with the same gestures as text. So that
people are not forced to read markers by eye, there is a "Text / Preview" switch above the
field: the preview shows exactly what the agent will see. In the task card and in the
conversation the text is always rendered as a preview (`DescriptionView`): there is no
reason to show the owner a raw marker there.

## Persistence and performance

- The interface state lives in `localStorage` under the key `orc.ui.v1` and is mirrored in
  the page address (`useUiState`). Values from storage are sanitized: garbage must not end
  up in requests.
- Polling (`usePolling`) does not update state if the response matches the previous one,
  and stops while the tab is hidden. Without that, the whole board was redrawn every five
  seconds even when nothing was happening on the server.

## Dashboard: a summary next to the board

The board answers one question: "do I need to step in right now". After a month of use,
other questions appear: where the money goes, which model pays off, whether the queue is
piling up or clearing. They need a different screen, so the summary is a **second view**,
not widgets mixed into the board: a "Board / Summary" switch in the header (or `D`), and
the columns give way entirely to cards with numbers.

- **Filters stand in one row above everything they cut**: scope (this project or all) and
  period (7 / 30 / 90 days, all time). The cards have no filters of their own: otherwise
  the numbers on one screen start living in different periods and cannot be compared.
  While the answer to new filters is being computed, the old one is shown dimmed, which is
  more honest than a skeleton that makes the layout jump on every click.
- **The order of cards goes from the result to the cause**: five period tiles with a delta
  against the previous period (completed, success rate, spent, median work time, human
  called), the Claude limits forecast, a chart over time, a breakdown of completed tasks
  next to the distribution of durations, and a "Most expensive" table from which you go
  back to a specific card. The cross-cutting theme of the screen is spending: it is in the
  forecast, in the chart, in the breakdown and in the table.
- **The limits forecast is always visible.** It is the only block that speaks about the
  future, and a toggle that hid it would only add state. The limit is shared per account,
  so the block is not cut by scope and period: it is about "now".
- **One card, one measure, one dimension.** The chart over time shows money, tokens or
  tasks, one at a time, via a switch in the header; the breakdown shows one table by model,
  project, effort or access mode. These are views of the same data, not different data:
  three panels with a shared coloring across three cuts and four tables side by side added
  up to a matrix that had to be read rather than looked at. The choice of measure, stack
  and dimension is remembered (`useUiState`). A switch with a single option is not shown:
  the stack and the by-project breakdown exist only in the "all projects" scope.
- **The palette rule is not suspended here either.** Colored are the "done" and "failed"
  statuses in the breakdown rows, in the same hues as on the board, and the stack
  categories in the chart over time: models and projects get a `--cat-*` palette slot in a
  fixed order, not by position in the ranking, so the color stays attached to the name
  (`series.ts`). There is no cut by status on the chart: completed tasks are almost all
  "done", and a stack of one color told nothing. Durations are drawn in one neutral color,
  because they are not a status.
- **There is no charting library.** Bars and strips are ordinary blocks with percentage
  width and height. Recharts or Chart.js would bring their own visual language, their own
  fonts in axis labels and hundreds of kilobytes for three shapes, for exactly the same
  reason there is no MUI here.
- **Where a table beats a chart, there is a table.** For model, effort level and project at
  once, four numbers are needed (tasks, tokens, money, median), and there can be more than
  seven rows: a pie chart or seven colored series would answer fewer questions and eat the
  palette. A chart stays where the shape is read rather than the value: the flow over time
  and the distribution of durations.
- **No value is locked inside a tooltip.** A tooltip on a bar complements the axis label
  and the legend with numbers, but does not replace them.
- **There is no cumulative flow diagram (CFD) here, and that is not an omission.** The
  orchestrator does not store the history of status changes, and drawing stages from
  guesses would be lying. The chart over time counts completed tasks by completion date,
  entirely from data the database does have. For the same reason time has two different
  measures, lead time from creation and work time from session start, and they are
  computed over one set of tasks so as not to contradict each other (`orc/analytics.py`).

## Viewing results: "Done" as an inbox

Agents close tasks on their own and in several projects at once, so "Done" is not an
archive that a human fills by hand but a stream that arrives without them. Such a stream has
a question that status does not answer: "which results have I not yet seen". The answer is
built like a mailbox (`web/src/viewing.ts`, `orc/viewing.py`).

- **It has no column and no status of its own.** An "Under review" stage between "In
  progress" and "Done" would mean the task is not finished until a human has looked at it,
  but it is finished: merged, and dependent cards have already moved on. Viewing is the
  owner's note, not a stage of work; the dispatcher does not know about it. So it is a shelf
  inside "Done", following the same pattern as the "Waiting for input" shelf in "In
  progress".
- **Unviewed stands on top, viewed goes into a by-day archive.** The "Not viewed" shelf sits
  above the column's chosen order and is not cut into days: it is short, and the main thing
  about it is that it is new. Mark one, and the card moves down to its place by time while
  the next one comes under the cursor, so the shelf can be cleared without moving the mouse.
- **The mark in the card's corner is both a state and a checkbox.** An unviewed result is a
  green dot and a denser title, a viewed one is a quiet check mark and a muted title: as in
  mail, the new stands out by the read stepping back. There is no new color: the dot is
  green because it means "a finished result is here", the same meaning as the "Done" status.
  Magenta stays reserved for "Waiting for me": an unviewed result holds nobody up, and must
  not call the human with the same color as a stuck task.
- **Opening means viewed, but it can be undone.** The task window marks a finished card when
  opened, once: if the owner unticks "Viewed" in the header ("I'll come back later"), the
  window does not put it back. A task that finished while its window was already open stays
  unviewed: nobody has read its report yet.
- **The counter lives where people look, without entering a project:** on the "Done" button
  in the header (the column is often hidden) and at the project in the sidebar, next to "in
  progress" and "waiting for me", using the same "dot + number" device. In the collapsed
  rail the green dot yields to both magenta and amber: it is the calmest of the three
  signals.
- **Failures do not take part.** A failed task is already in "Waiting for me"; a second mark
  on top would be noise. Archived ones do not either: a card that has been put away does not
  wait for a look.
- **It is a project setting, on by default.** Where results are not meant to be viewed,
  "Done" looks as before: no marks, shelf or counters.

## What is deliberately not here

- Charts and metrics **on the board**: it has one job, to route attention, and numbers blur
  it. Everything about numbers lives in the separate "Summary" view.
- The "queued" tile, the "where tasks are now" strips and the "friction" list **in the
  summary**: the number of created cards says nothing about the work, a cut of the board by
  status is the board itself one click away, and five heterogeneous friction counters did
  not answer any question that is asked of a summary. The server still computes these
  numbers (`/api/analytics`); the screen does not show them.
- A ready-made component library (MUI, Chakra): it would bring a foreign visual language and
  weight. Only Radix's unstyled primitives and lucide icons are used.
- Placeholder rows where emptiness is good news. The "Waiting for me" strip simply
  disappears: its absence by itself means "everything is fine".
