# Task cards: properties and settings

A card holds what to do and a short list of properties: who does it, how urgent it is, which branch
it starts from, and a plan for people: labels and two dates. What it waits for, what follows it and its subtasks
are its relations. How a session runs (model, effort, permission mode) is not a
property: it belongs to the agent and the project.

## Assignee

A card is assigned to an agent or to nobody, and nobody means a person works on it. An unassigned
card does not go to work: moving it to "To do", creating it there and retrying it are refused, and
taking the agent off a queued card returns it to the backlog.

The rule stands at those doors rather than in the dispatcher, so nothing already in motion is
stranded. A card queued before the rule still starts. A routine run without an agent starts on the
project's parameters, and can be retried. Rework of a finished card continues its session, so it
is not one of the doors either.

A session that queues a card through `orc task` without naming an agent gets the project's default
agent, then its own. With neither, the card stays in the backlog and the response carries a warning.

## Adding a property

The creation form, the card and the settings all read one list,
`web/src/components/cardProperties/registry.tsx`. A property is an entry there plus a control:

| Field | Meaning |
|---|---|
| `id` | What the settings store. The server does not interpret it. |
| `label`, `icon` | Its name (an i18n key) and its mark in the settings. |
| `required` | Cannot be hidden: without it a card cannot do its job. |
| `optional` | Shown only when it holds a value or was added from the "+ Add property" menu. |
| `editableIn` | Statuses in which it can change. Elsewhere it stays readable and locked. |
| `isSet` | Holds a value. A hidden property with a value stays on the card. |
| `Control` | Draws itself as a pill in the form or a row in the card. |

`ui/Picker.tsx` is the dropdown for anything with a list of options.

### Progressive disclosure

An `optional` property (labels, start date, due date) stays off the card until it has a value. The "+ Add
property" menu, in the creation form and in the card, lists the optional properties that are not shown and
that the settings do not hide, and picking one adds its row and opens its picker. A row that was added stays
for as long as the card is on screen, so clearing its value does not make it vanish under the pointer. A
hidden property is never offered, but one that holds a value always shows. The regular properties (assignee,
priority, branch) behave as before. What a card waits for is a pill in the creation
form and lives in the Relations section of the card.

The status is a row above the properties but not an entry of the registry: it is never hidden and has no
setting. It offers what the board allows by drag (backlog and To do) and is locked in the working statuses,
where the status belongs to the dispatcher. Forcing a close stays in the card's footer.

## Dates and labels

`tasks.start_date` and `tasks.due_date` are calendar days, `YYYY-MM-DD`, with no time and no time zone. They
are a plan for people: the dispatcher never reads them, and they survive every status, retries and the
archive. They are separate from `start_after` and `start_before`, the deferred start that does hold the
queue, which the card shows as its own "Start" row. A due date in the past is highlighted on the card and on
the board until the card is done.

Labels are global across projects: `labels (id, name, color)` with the name unique ignoring case, and
`task_labels (task_id, label_id)`. `GET/POST/PATCH/DELETE /api/labels` manage them. A card takes label
**names** (`labels` in create, in PATCH and in a batch plan), and a missing name is created; PATCH replaces the
whole list and `null` leaves it. The task list carries `labels` for every card, read in one query, and
`GET /api/tasks?label_id=` filters. The board filters in the browser by the labels the list already carries.
Both are editable in every status.

`orc task add` and `edit` take `--label NAME` (repeatable; `edit` also `--remove-label`), `--start-date` and
`--due-date`; `orc task list --label NAME` filters. A flag that was not passed sends nothing, and a CLI newer
than the server says so instead of dropping the field silently.

## Relations

A section under the description, computed in the browser from the task list the board already holds
(`web/src/relations.ts`). The server is not asked. It has three groups:

| Group | Source | Meaning |
|---|---|---|
| Waits for | `task_deps` | Blocks the start and drives the queue. A failed blocker is highlighted, since it holds the card. |
| Comes next | `task_deps`, reversed | Starts once this card is merged. |
| Subtasks | `tasks.parent_task_id` | Grouping for decomposition, with done/total. No effect on the queue; a parent that opted in is woken when they are all done (`orc/child_wake.py`, `tasks.wake_on_children`). |

"Waits for" is edited from the section while the card has not started, and stays a pill in the creation form.
It is no longer a row in the properties column (`formOnly` in the registry). Subtasks can be added with "+",
which opens the creation form with the parent, its project, base branch and agent filled in. An existing card
can be attached through a picker that leaves out the card itself and its parents, and a subtask can be detached.
A subtask shows "Subtask of #N" with the parent's progress above its title, and a parent shows done/total on
the board.

"Tree" shows the whole connected chain of `task_deps` around the card, read top down: each card's children are
the cards that wait for it, so its blockers stand above it and what follows below. A card reached a second time,
the bottom of a diamond, shows again as a repeat without its subtree. A ring, which the server refuses to build,
is drawn the same way and marked, so bad data cannot hang the tree. Subtrees deeper than three levels start
collapsed, except the path to the card itself. Archived and deleted cards are not in the list. A blocker among them
shows as a bare number and is not walked through.

`parent_task_id` is separate from `created_by_task_id`. The generation limit for chains of agents walks the
creator, and a subtask the owner adds must not count against it. A card created from a session becomes a subtask
of the calling card unless `--no-parent` or `--parent ID` says otherwise. An upgrade fills the parents of existing
cards from their creators once. The parent is editable in every status (`PATCH parent_task_id`, `orc task edit
--parent`, `--clear parent`). The server refuses a parent that does not exist, the card itself, or one of its own
subtasks. Deleting a parent leaves its subtasks as top-level cards.

## Stages among subtasks

A subtask can carry a stage number (`tasks.stage`, `stage` in `POST /api/tasks`, `PATCH`, a batch plan, `orc task add
--stage N`, `orc task edit --stage N`, `--clear stage`). A card of stage N starts when every sibling of the nearest lower
stage is done, which means merged. `orc/stages.py` is the only place that turns this into "waits for": the dispatcher
reads it in the tick, and the API returns it as `stage_blocked_by` next to `depends_on`, which the card and the tree
draw. Nothing is stored as links, so the owner's own `depends_on` stays editable and nothing drifts.

Only cards with the same parent form a stage, and a card without a stage is outside it. A failed card is not done, so
it holds the next stage like any unfinished one. An archived or deleted sibling holds nothing, as with links. The server
refuses a stage outside 1 to 999, a stage on a card without a parent, and a stage or a link that would make a card wait
for itself. A card that changes parent leaves its stage. An empty number is skipped: stages 1 and 3 mean 3 follows 1.

## Details

A collapsed section at the bottom of the right column (`ui/SidebarSection.tsx`: chevron, `aria-expanded`, a
count and a slot for actions). It is read-only: who created the card (the owner, the agent of card #N, a
routine), created, updated, started and finished with the queue wait and the working time beside them, and
the branch, the worktree and the attach command with copy buttons. The tokens live in the execution log above
it ([execution-log.md](execution-log.md)).

## Settings

Settings live in `settings.card_settings` for all of orc and in `projects.card_settings` for one
project. A project overrides key by key, and a key it does not hold follows orc:

    {"hidden": ["priority"], "default_agent_id": 3, "default_priority": "normal"}

`orc/card_settings.py` validates them. Adding a key means adding it there and to `CardSettings` in
`web/src/cardSettings.ts`, with no migration.

## Quick actions

`quick_actions` in the same settings is a list of `{id, title, prompt}`: canned messages for the agent
("review", "write tests"). A project that holds the key replaces the whole list, an empty list means none,
and an absent key means the built-in set in `web/src/quickActions.ts` (titles are translated, the prompts
are English because the agent reads them). The editor is in the Task cards section of the orc settings
and of a project; half-filled rows are dropped on save, since the server refuses them.

An action is sent from the "Quick actions" section of the side column or from the `/` menu of the
composer (a draft that is a single word starting with `/`; arrows, Enter and Esc). Both take one road,
`quickActionSender`, which follows `composerMode`: a live session or a question gets an `answer` comment,
a finished card `rework`, a failed card with a session `resume`. Not started, verifying, merging, quota,
archived and a failed card with no session have no road: the buttons are disabled and `/` opens nothing.

Defaults fill the creation form only. A card created through the API or the CLI gets what the
request says, so a default set in the dashboard cannot silently change a script. The exception is
the session case above.

## Editing in place

There is no edit mode. The title and the description save themselves after a pause in typing, on
leaving the field and when the card closes (`hooks/useAutosave.ts`), and a property saves when it is
picked. The description and the properties can change only while the card has not started: a session
already holds its assignment, so editing them later would show one thing and do another. The title
can change at any time.
