# Agents, leads, chats and memory

An agent is a named set of run parameters: model, effort, permission mode, plus a description,
an avatar and an optional prompt. It holds no process and no conversation. A session is still
started per task; the agent only decides how.

## Allocation and what a session runs with

A task or a routine has an optional `agent_id`. A task without one belongs to a person and does not
go to work (see [task-cards.md](task-cards.md)); a routine without one runs on the project's parameters.
When a session starts, each parameter resolves as:

    the agent's → the project's → Claude Code's default

A card or a routine holds no model, effort or permission mode of its own: it is tied to its agent, and to
run it differently you pick another agent. The API, the CLI and a batch refuse those fields. The columns
stay in the database for older builds, are cleared by a migration, and are never read.

The project lead is deliberately not a step here: a lead coordinates, and appointing one must not
change what the project's tasks run on.

Parameters are read at session start, not copied into the task. A task that has not started
follows an edited agent, exactly as it follows an edited project. A running session keeps what it
was started with, and so does waking it.

An agent cannot be deleted while it has a task that may still run (anything but `done` or archived,
because a failed task can be retried) or a routine: such work would quietly fall back to the
project's model and lose the prompt. Finished tasks simply lose the label.

## Scope

An agent does not belong to a project: it lives at the level of the whole orc and can work in any of
them. Limiting it is optional: `agents.project_id` is NULL for an agent usable everywhere, the default,
or the project it is internal to. The API refuses a task,
routine, lead or chat that would use an agent of another project, and narrowing an agent's scope is
refused while another project still uses it. A single save can narrow the scope and release the
leadership that stands in its way.

## Delivering the prompt

The prompt, and a short note on how to reach the board, go through `--append-system-prompt`, not a `CLAUDE.md` in the worktree: that file is
tracked in your repository and would land in the merge.

The flag follows the same rule as `--settings`, verified on Claude Code 2.1.319:

- **Start:** passed.
- **Waking a stopped session:** not passed. The daemon restores the saved options, and any extra
  flag would turn the wake-up into a copy.
- **Resuming a finished session (a copy):** passed again. A copy has no saved options, and after
  compaction the system prompt comes from the current launch.

## Memory

Claude Code's auto memory is per repository and shared between its worktrees, so by default an
agent has no memory of its own: tasks in one repository share one store whichever agent runs them,
and the conversation itself continues only within a task's or a chat's session.

The per-agent switch `memory_enabled` adds `autoMemoryDirectory` to the session's `--settings`,
pointing at `<data_dir>/agents/<id>/memory`. What the agent learns then follows it across projects.
The agent writes it itself, using Claude Code's ordinary memory mechanism, and orc only shows and
clears the folder. It is off by default for these reasons:

- **Facts cross projects.** A shared agent may repeat something from one repository in another.
  An agent internal to a project does not have this problem.
- **It replaces the repository's auto memory** for that agent's sessions, rather than adding to it.
- **Concurrent sessions are last-writer-wins.** Two running tasks of one agent can overwrite each
  other's notes.
- **Memory is persistent input.** Text a session read from an untrusted source can end up there and
  influence later runs, so review the folder for an agent that handles foreign content.

## Chats

A chat is one Claude Code session with an agent. It is not a task: it has no board status,
verification or merge.

- **Isolation.** A project chat works in its own worktree, `.claude/worktrees/orc-chat-<id>` on the
  branch `orc/chat-<id>`, never in your working copy, and nothing from it is merged. A chat outside a
  project gets an empty folder under the data directory, which orc trusts itself because it made it.
  A project chat needs a project Claude Code already trusts, like a task.
- **Turns.** A message is queued and the chat loop (`orc/chats.py`, its own thread, not the
  dispatcher pass) starts the turn: `claude --bg` the first time, a wake-up afterwards. Messages sent
  during a turn go together as the next one.
- **Replies come from the transcript**, read from a stored byte offset, so a server restart in the
  middle of a turn neither loses nor repeats anything. `state.json` only says when the turn ended.
  Right after a launch it may still describe the previous turn, so a turn with no transcript progress
  is not considered over for its first 30 seconds.
- **Processes.** The session is stopped after each turn: an idle `claude` costs hundreds of megabytes,
  and waking it is cheap. Chat jobs are not in `task_sessions`, so the task session reaper never
  touches them, and `orc/chats.py` is their only owner.
- **Limits.** A chat turn is your explicit action and is not held by worker limits, but its tokens
  go into the same spending log as tasks, with no task id.
- **Approvals.** Input request hooks are bound to a task, so a chat has none. A session stuck on a
  permission dialog shows what it waits for, and your next message stops it and continues with that
  text. Pick a permission mode that fits what you want the agent to do in a chat.

- **The list.** `chats.pinned` and `chats.archived_at` organise the list: pinned chats stay on top,
  archived ones leave the default view and do not count towards the unread badge. Neither, nor a read
  mark, changes `updated_at` (`update_chat(touch=False)`), since the list is ordered by it. A message
  sent to an archived chat restores it. Unread is derived: replies and proposals past
  `last_read_message_id`; "mark as unread" moves that pointer to just before the newest reply, and
  a read mark never runs past the newest message. Filters, search and grouping are only in the
  browser (`web/src/chatsView.ts`, saved in localStorage).

An edited prompt reaches new chats. An existing chat keeps the prompt its session started with.

## The project lead

`projects.lead_agent_id` appoints a lead. A project has one lead, and an agent can lead several
projects. The appointment can be made from either side: the project's settings set
`lead_agent_id`, and the agent's settings set the whole list with `lead_project_ids` in
`POST` or `PATCH /api/agents`. Both change the same column, so they cannot disagree. Rules for the list:

- A project left out loses this agent as its lead. Leaving the field out of a `PATCH` changes nothing.
- A listed project led by another agent changes hands, and the event log records whom it replaced.
- An archived project takes no new lead but keeps the one it has.
- An agent internal to one project can lead only that project.

A chat started from the agent's card is about its own project or the only project it leads. An agent
leading several gets a chat outside any project there, so use the chat button of the project itself.

Its chats about that project differ in two ways:

- Each message arrives with the current board and the team, marked as data rather than instructions.
- The lead can propose tasks with a fenced block in its reply, with the info string `orc-tasks` and a
  JSON array of `{"title", "description", "agent"}` inside.

- An object may also carry `"ref"` and `"depends_on"`: refs from the same block, or numbers of tasks on
  the board. Accepting a step also accepts the open proposals it waits for, on one base branch. A
  dismissed step is not waited for. Links that cannot be read are dropped with a note in the chat.

A proposal becomes a card in the chat. Only the owner can turn it into a backlog task, and the lead
cannot start anything: a coordinator that cannot create work by itself cannot loop or run away with
the limits. At most ten proposals are taken per reply. The block lives in the reply text rather than
in a file so that it needs no tool permission and works in every permission mode, including a
read-only lead.

Other sessions work differently: a task session or an ordinary chat is told about `orc task` and may
create cards directly, under the limits in [agent-tasks.md](../agent-tasks.md). A lead is not told.
That is a matter of what its prompt says, not a wall: see the note on local processes in
`orc/security.py`.

## The agent's own page

Clicking an agent's card opens its page (`web/src/components/AgentDetailPage.tsx`), with three tabs.
"Activity" lists what the agent is doing now, with how long each run has been going, and the latest finished
runs; picking one shows its log (the same panel as on a card). "History" is a table of every run of the
agent in all projects, tasks (archived ones too) and chats together: status, start, duration, tokens and
cost, with "show more" for older rows. "Tokens" splits the spending by day (last 14 days) and by model.
Above the tabs, tiles show what is running right now, the task counts, the token and dollar totals and the
time spent in finished tasks. A card on the list gets a pulsing dot and a "Working on N" badge while the
agent runs something.

Who is working right now comes from the same poll as the list (`GET /api/agents/activity`, every 3 s). The
history and the totals come from `GET /api/agents/{id}/work` (`orc/agent_work.py`, polled every 10 s,
`limit` and `offset` page the runs), which reads what orc already stores: tasks, chats and their `usage_json`.
The daily series reads the spending log, which has no agent column and records chat turns without a task,
so it covers the agent's tasks only. The totals include chats.

## Not done yet

Per-agent concurrency limits and budgets, per-agent
skills, MCP servers and tool allowlists, images in chats, and answering a chat session's permission
dialog in place. `plan` stays out of the permission modes for the reasons in
[plan-mode.md](plan-mode.md).
