# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0 a
minor version may contain breaking changes.

## [Unreleased]

## [0.2.0] - 2026-11-10

Since 0.1.0 orc has grown from a queue of tasks into a small team of agents that you can talk
to, schedule and let plan their own work. The four biggest changes:

- **Agents** are named sets of model, effort, permission mode, prompt and avatar. They do not
  belong to a project, have their own page with live activity, history and spending, and can
  keep their own memory across projects. A card or routine takes its run parameters from its
  agent.
- **Chats with agents** work in any project or in none: a round button in the corner opens a chat
  window on every screen. A chat runs in a private worktree, and nothing from it is merged.
- **Routines** were reworked: they live on their own page, need no project, and can be attached to
  a project, moved or detached later.
- **Agents that plan and launch work themselves.** An agent (a task session, a chat or a project
  lead) can split a large feature into cards with `orc task add`, `batch` and `link`, chain them
  with dependencies and stages, hand in files, go to sleep with `orc task wakeup` until a time or
  another card is done, and be woken when all its subtasks finish. The dispatcher then starts the
  chain on its own. See [docs/agent-tasks.md](docs/agent-tasks.md).

### Added

#### Agents, chats and leads

- Agents: a model, effort, permission mode, description, avatar and an optional prompt under a
  name. An agent can serve all projects or be limited to one, and can have optional memory in its
  own folder. Agents page: drag cards to set your own order, search, filter by status and project,
  sort by name, date or workload, and group by project or model.
- An agent page shows whether the agent is working and for how long, what it is doing, the log of
  any of its runs, its history of cards and chats across all projects with duration, tokens and
  cost, and its spending by day and by model.
- Agent activity: watch a running task or chat live, step by step: messages and thinking, every
  command with its output, the plan, background work and what the agent is stuck on. Filter and
  search the log, and read it after the run. Stop a running agent from its log; the card moves to
  Failed with its work intact and can be continued with a message.
- Chats: talk to an agent directly in a private worktree of a project or in an empty folder. A new
  chat is a blank page that exists on the server only after the first message. The chat list has
  search, filter chips (all, unread, working, needs you, archived) with counts, grouping by agent,
  project or status, and a row menu to pin, mark read, rename, archive and delete. Permission
  requests, questions and plan approvals of a chat are answered inside the chat.
- Project lead: an agent appointed from the project's or the agent's settings sees the board in its
  chats and proposes cards, which reach the backlog only with your approval. A lead can link its
  proposals into a chain, and accepting a step accepts the steps it waits for. An agent can lead
  several projects.
- A long agent message has a «Listen» button that reads it aloud with the browser's own voice (no
  server, no cost). Markup, code blocks and long paths are skipped, names such as `snake_case` are
  split into words, and years and dates become phrases.
- The header shows who is working: a chip with the busy agents and cards across all projects, and a
  list under it where each agent's cards and chats open in one click. Cards in work are also listed
  under their project in the left column, and a project shows a counter for cards asleep until a
  wakeup.

#### Agents planning and running work

- `orc task add`, `batch`, `link`, `context` and `guide` let an agent put one card or several linked
  ones on the board, all or none, with an agent per card. Task sessions and chats know the command,
  and `orc task install-skill` teaches it to Claude Code sessions outside orc.
- `orc task list`, `show`, `edit`, `move`, `archive`, `unarchive` and `delete` read and change
  cards; `current` stands for the card a session runs in.
- A session hands in its work with `orc task done` (the turn's final message is the summary) or
  stops with `orc task fail --reason TEXT`, instead of writing `.orchestrator/report.json`. Both are
  allowed in every permission mode. `POST /api/tasks/{id}/accept` takes the work of an agent that
  forgot to hand in.
- `orc task attach FILE...` hands in files as the result of a card: a report, a screenshot, an
  archive. Files show in the card, survive the cleanup of the working copy and are limited to 20 MB
  and a list of safe types.
- `orc task wakeup --in 30m`, `--at TIME` or `--card N`: an agent sleeps without a session or a
  worker slot and resumes with the reason when the time comes or the other card finishes, once even
  across a server restart. A message wakes a sleeper at once.
- A parent card can be woken when its subtasks are done ("Wake this card when all subtasks are
  done", or `--wake-on-children`). It continues in its own working copy and is verified and merged
  again. Off by default.
- Subtasks and relations: a card has a Relations section with what it waits for, what comes next and
  its subtasks, plus a dependency tree. Subtasks can have stages, so a stage starts only when the
  previous stage of the same parent is merged.
- A task that waits for another takes its base branch unless you name one. The new-task form can
  create a branch in the "Base branch" dropdown and opens with the branch of the previous task.

#### Cards and the board

- One conversation per card: your comments, your messages with a read receipt, the agent's messages
  with its steps folded between them, subagent work and the stages of the task. A question,
  permission request or plan to approve is the last row of the thread and is answered there. One
  composer offers what fits the card's state: send, interrupt, stop, accept the work, continue,
  retry, rework or leave a note the agent does not see.
- An execution log for each card: what the agent spent, each run with why it started (start,
  rework, resume, crash, usage limit, failed check, merge conflict, message, wakeup), how it ended,
  how long it took and what it cost, each check with its output and each merge. `GET
  /api/tasks/{id}/runs` returns the same.
- A failed card says why in plain words and what to do next, in your language.
- Labels (global across projects) and two planning dates on a card; the board filters by label.
- Batch actions on the board: select cards and change status, priority, agent or labels at once, or
  archive them (`POST /api/tasks/bulk`).
- Saved views: a "Views" menu keeps the current board filters under a name, per project.
- The new-card form has a "Describe" mode: write a sentence and a cheap model drafts the title, the
  task, the agent, the priority and the branch to review.
- Quick actions: canned messages such as "review" or "write tests", from a card's side column or by
  typing `/` in the reply field.
- Card settings, for all of orc or per project: the default assignee, the default priority and which
  properties a card shows. "Create and start" sends a new card straight to the queue.
- Agent messages, comments and web addresses render as markdown and clickable links.

#### Routines

- Routines have their own page and need no project. A routine without a project requires an agent,
  and every run is a new chat with it. The form is a two-column window, and a routine can be
  attached to a project, moved or detached later.

#### Documentation

- The README opens with a language switcher. Short versions in Spanish, French, German, Portuguese and
  Russian, the languages of the interface, live in `docs/readme/`.

### Changed

- The project dialog is built around agents: a new project asks only for a name, a path and how many
  agents run at once. The project's model, effort, permission mode and model list moved into a
  collapsed "Fallback run settings" block.
- A card is assigned to an agent or to nobody, and nobody means a person works on it: an unassigned
  card cannot be sent to "To do". Create an agent first on a new install. A card and a routine no
  longer have run parameters of their own; model, effort and permission mode come from the agent,
  then the project. The API, `orc task add`/`edit` and batches refuse them.
- Task cards are edited in place, with no edit button, and the creation form is a title, a
  description and a row of dropdowns.
- Talking to a working agent behaves like a console: a message reaches the agent whatever it is
  doing, and "Interrupt" works like Esc: it stops the current step and keeps the session.
- A task report can say `needs_input`, so the card waits for your answer instead of going to
  verification and merge.
- Chats are a button over the whole app instead of a sidebar page.
- A task's working copy and branch are removed right after the task is merged. Copies with
  uncommitted files, running processes or unfinished subtasks are kept for the periodic cleanup.
  Switch it off with the working-copy autoclean setting. A finished card sent back for rework gets
  its working copy made again at the same path.
- A rework, or resuming a failed card with a message, reminds the session to hand the work in again.
- The in-app guide, the README and "How orc works" describe the card as it is now.

### Fixed

- Failed cards no longer hang in the "waiting for me" strip: they already sit in Done with a red
  status.
- A verification command that exits at once, such as `true`, could fail with "No such process".
- A session whose working copy was deleted and made again can still hand in its work and ask for
  permissions: the hook secret now lives in orc's data directory.
- A task continued after a stop, a rework, a failed check or a merge conflict keeps its hooks,
  permission mode, agent prompt, effort and model. They were lost nearly every time, so messages to
  such a session never arrived and it could carry on with a different model.
- Trusting a project folder from a card also sends back to To do the project's other cards that failed
  with the untrusted-folder reason.
- Pasting text that came with a picture (from a spreadsheet, a web page or a chat) into a task
  description inserted nothing.

## [0.1.0] - 2026-11-03

Initial public release.

### Added

- A project in the sidebar shows a muted counter for cards that sleep until a wakeup. Before, a project whose only card in work was asleep showed no indicator at all.

- Kanban board with Backlog, To do, In progress and Done, and a "Waiting for me" strip for
  everything that needs the user (a question, a failure, a conflict).
- Auto-dispatcher: picks up tasks from "To do" on a timer (30 seconds by default), within
  per-project and global worker limits and task dependencies; "Run now" triggers a pass
  immediately.
- One git worktree per task on a branch `orc/task-N`, with the session started through
  `claude --bg`.
- Verify gate: the project's `verify_cmd` runs in the task's worktree, and a failure goes
  back to the session with the output.
- Auto-merge without a pull request: `git merge --no-ff` into the task's target branch,
  FIFO and one task at a time; push is off until enabled per project.
- Conflict resolution by the session that wrote the code, up to three attempts, then it is
  handed to the user.
- Questions and live replies: permission requests, multiple-choice questions and plan
  approvals on the card, with answers delivered into the same running session; notes to a
  running session.
- Scheduled start with "Not before" and optional "Not after" times.
- Recurring routines: an instruction plus a schedule (every N minutes, hours or days, or
  cron), each run becoming an ordinary task.
- Token and quota tracking: tokens per card read from Claude Code transcripts, the account's
  5-hour and weekly limits in the sidebar, pause and resume of the dispatcher on a usage
  limit.
- Summary view with finished tasks and success rate, median work time, cost at API prices, a
  forecast of Claude limits, a timeline and breakdowns by model, project, effort and
  permission mode.
- Branch management from the UI: create, rename and delete branches, with operations that
  would break running work blocked.
- Task cards with model, effort and permission mode, a target branch, dependencies on other
  tasks and screenshots pasted into the assignment.
- Six interface languages (English, Spanish, French, German, Portuguese and Russian) and
  light and dark themes.
- CLI: `orc serve`, `orc doctor`, `orc tick` and `orc db-path`.
- Installation from a clone (`make setup`), from a wheel (`make package`) and with Docker.
- Autostart at login on macOS (LaunchAgent).

[Unreleased]: https://github.com/alimardonbegov/orc/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/alimardonbegov/orc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alimardonbegov/orc/releases/tag/v0.1.0
