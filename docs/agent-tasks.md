# Agents creating tasks

An agent can put work on the board: one card, several linked ones, with parameters or an agent per
card. The usual reason is decomposition: a large feature becomes a spec and a plan, and each step of
the plan runs in its own card, in order.

There are three ways in:

- **A task session or an ordinary chat** gets a short note in its system prompt with the exact command
  and, in a task, its card number. It needs nothing else: ask it, or let it decide that the work is too
  large for one session.
- **Claude Code outside orc.** Run `orc task install-skill` once, on the machine where the server runs.
  It writes the guide to `~/.claude/skills/orc-tasks/SKILL.md` with the absolute path of this orc.
- **A project lead** keeps proposing through its chat, for your approval, and can link the proposals.
  See [internals/agents.md](internals/agents.md).

The server must be running: `orc task` talks to its API. The rules live there, and there is no lock
between processes.

A card goes to work only with an agent. A `todo` card that names none gets the project's default
agent, then the agent of the calling card; with neither it stays in the backlog and the response
carries a warning.

## Commands

| Command | What it does |
| --- | --- |
| `orc task context` | Where you stand: the project, your card, the base branch, agents, open cards. |
| `orc task add "Title" --description-file spec.txt --agent NAME --after 12` | Creates one card, a subtask of the calling card unless `--parent ID` or `--no-parent` says otherwise. `orc task add --help` lists the parameters. `--stage N` puts a subtask into a stage: it starts when the previous stage of the same parent is done. |
| `orc task batch plan.json` | Creates several linked cards, all or none. |
| `orc task link 12 --after 11 --remove 9` | Changes the blockers of a card that has not started. |
| `orc task list` | The cards of a project (`--status`, `--archived`, `--project`, `--label`), or of all projects outside one. |
| `orc task show 12` | One card in full: parameters, description, comments. |
| `orc task edit 12 --title "..." --agent NAME` | Changes the fields you pass and nothing else. `--clear FIELD` empties one. `--label NAME` / `--remove-label NAME` change labels, `--start-date` / `--due-date` (YYYY-MM-DD) the plan, `--parent ID` the card it is a subtask of, `--wake-on-children` / `--no-wake-on-children` whether the card is woken when its subtasks are done. |
| `orc task move 12 --to OTHER` | Moves a card that has not started to another project. |
| `orc task archive 12` / `unarchive 12` | Takes a card off the board and brings it back. |
| `orc task delete 12 --yes` | Deletes a card for good, with its worktree and branch. `--force` for a card being worked on. |
| `orc task done` | Hands in the card this session works on: see [internals/handoff.md](internals/handoff.md). `--summary` or `--summary-file` is optional. |
| `orc task fail --reason TEXT` | Says that the card this session works on cannot be completed. |
| `orc task attach FILE...` | Hands in files as the card's result (report, screenshot, archive): see [internals/deliverables.md](internals/deliverables.md). The same name again is a new version. |
| `orc task wakeup --card 12` | Ends the turn in sleep, without a worker slot, until card 12 is done (or `--in 30m`, `--at TIME`; with `--card`, a deadline). The session resumes in its worktree: see [internals/wakeups.md](internals/wakeups.md). |
| `orc task guide` | Prints the whole contract for an agent, including how to decompose a feature. |
| `orc task install-skill` | Installs that guide as a Claude Code skill. Does not overwrite a file orc did not write. |

The project comes from the current folder, a worktree included. Elsewhere, pass `--project` with a name,
id or path. `--json` prints the server's answer as it is.

Wherever a command takes a card number, `current` means the card the command runs in. `delete` refuses
that card, since it would cut off the session that asked.

## Writing a card from a sentence

The creation form has a second mode, "Describe". The owner types a sentence, and a cheap model drafts the card: the title, the
task for the agent, the agent, the priority and the base branch. It picks the agent and the branch only from the ones that
exist in the project (the same lists `orc task context` shows), and anything it makes up is dropped with a note.

The draft is a proposal. `POST /api/tasks/draft` (`{project_id, text}`) stores nothing: the form is filled with the answer, the
owner reads and edits it, and the usual `POST /api/tasks` creates the card, so every rule of a normal card still applies. Manual
entry stays the default. A failed model answers 502 with the reason, and the form keeps the text.

The model is the `quick_create_model` setting (Haiku by default, changed in Settings). The tokens and the cost of a draft are
written to the spending ledger, so they count in the usage and the forecast.

## Changing cards

`orc task edit` is a thin client of `PATCH /api/tasks/{id}`, so it follows the rules of the board:

- Only the fields you pass change. Blockers are not among them: `orc task link` adds and removes single
  blockers, because a whole new list would drop whatever the owner added meanwhile.
- A card goes to To do only with an agent and a description. Taking the agent off a queued card puts it
  back in the backlog, and the command says so.
- A card that a chain of agents created more generations deep than the limit below stays in the backlog
  when an agent asks to promote it. Only the owner, from the dashboard, can send it to work.
- Closing a card by hand (`--status done`) skips verification and merge and needs `--force`.
- The parent (`--parent ID`, `--clear parent`) changes in any status. It groups cards and never holds the
  queue. It is kept apart from the record of which card created which: that record feeds the generation
  limit, and a subtask the owner adds by hand must not count against it.

`orc task move` is `POST /api/tasks/{id}/move`. A card moves only when nothing of it exists in the old
repository: it is in the backlog or To do, has no worktree, branch or session, and is not a run of a
routine. It gets a base branch of the new project (named with `--base`, otherwise its blockers' branch there,
otherwise the project's base) and keeps its agent if the new project may use it. A queued card left without
an agent returns to the backlog. Cards that waited for it keep waiting, and the response says which of them are
now in another project, where only the order applies. Cards of the new project that wait for it must have
the same base branch, otherwise they would start without its work.

`orc task delete` is irreversible, so it needs `--yes`, and the guide recommends `archive`, which can be
undone.

A plan for `orc task batch`:

```json
{
  "sequential": true,
  "target_branch": "feature/export",
  "create_target_from": "main",
  "defaults": {"agent": "Implementer", "status": "todo"},
  "tasks": [
    {"ref": "schema", "title": "Export: schema", "description": "the complete assignment"},
    {"ref": "api", "title": "Export: API", "description": "...", "agent": "Senior"},
    {"title": "Export: UI", "description": "...", "depends_on": [214]}
  ]
}
```

`depends_on` takes a `ref` from the same batch, the number of an existing card, or `"current"` for the
card the command runs in. The same format goes to `POST /api/tasks/batch`, together with
`project_id`, `project` or `cwd`.

## The base branch of a chain

A card starts when its blockers are `done`, which means merged into their target, and its worktree is
cut from its own target at that moment. So a card has a blocker's work only when both have the same
target. A chain with mixed bases runs in the right order and builds on nothing.

For that reason a new card takes its base branch from, in this order:

1. The branch named for the card, or for the whole batch.
2. Its blockers' branch, if they are in the same project.
3. The target of the card the command runs in. A follow-up belongs where that card merges.
4. The project's base branch.

The API refuses a named branch that differs from a blocker's, and blockers that disagree with each other.
A blocker in another project is exempt, since repositories do not share branches and only the order
applies.

`POST /api/tasks`, which the new-task form uses, inherits in the same way when no branch is sent. It does
not refuse: the form warns about a mismatch and offers a fix, and the decision stays yours.

## What else can go wrong

- **A card needs work that is not merged yet.** It sees only what is in its base branch, and the card
  creating it is not merged until it finishes. Hence `"current"`: the response warns when new cards do not
  wait for the card that made them. The same goes for spec and plan files. Only files tracked by git
  travel.
- **A blocker that will not finish by itself.** A failed blocker holds its dependents until it is fixed. A
  blocker in the backlog does not start on its own. An archived or deleted one stops holding them, and
  the card starts without it. The response lists all three.
- **A session waiting for the cards it created** holds a worker slot they may need, which can deadlock the
  queue. The guide forbids it.
- **A closed card that was not merged.** Closing a card by force counts as `done`, so the next one starts
  without its work.
- **A session repeating itself.** The command derives an idempotency key from the request, so the same
  request from the same folder within 24 hours returns the existing cards. `--no-dedupe` turns that off.
- **Half a plan.** A batch is one transaction. On any error nothing is created, a new base branch included.
  Unknown fields are refused rather than ignored.

## Limits

New cards go to the backlog unless the request says `todo`, so by default you decide what runs. To keep a
chain of agents from running away:

| Limit | Value |
| --- | --- |
| Cards in one batch | 30 |
| Cards created by one card | 60 |
| Generations that may reach To do on their own | 3; deeper cards may only go to the backlog |

A card's origin is on the card and in the event feed. These limits catch accidents and are not a security
boundary: any process of your user can reach the API, as [the security notes](../README.md#security) explain.

## Waking a parent when its subtasks are done

A card that split its work into subtasks usually hands in before they finish. To hear how they ended, it asks to be
woken: `orc task edit current --wake-on-children` (the owner can also tick it on the card, or set `wake_parent` in the
project's or orc's card settings; `wake_parent_instruction` replaces the default text the card is woken with).
It is off unless someone turns it on.

- Once every non-archived subtask is done and the parent itself is done, orc sends the parent back through the rework
  path: status todo with a message, so the wake waits for a free worker slot like any other run. The session continues
  in its own working copy; merge the target branch into it first to see the subtasks' work, then hand in with
  `orc task done` as usual (nothing new to commit is fine).
- A parent that is still queued, working, verifying or merging is woken after it lands.
- A failed subtask holds the wake and the parent gets one note in the feed. Retrying it or closing it by hand lets the wake
  go ahead once all are done.
- The same finished set wakes the parent once. A card is woken at most three times, and a card created more generations
  deep than agents may start work gets none (the owner decides).
- If the cleanup of merged working copies has already removed the parent's copy, nothing is started: a comment on the card
  says so, and the next step belongs on a new card.
- Turning the setting on does not report a tree that had already finished.
- The Execution log names the run "Woken: subtasks done" (trigger `subtasks_done`).
