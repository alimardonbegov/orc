# Agent activity

What a running session is doing, for the owner: the steps it took, what it is doing now, and the
controls to stop it or write to it. The code is in `orc/activity.py`, `orc/processes.py`,
`orc/api/activity.py`, and on the web side in `web/src/activity.ts` and the `Activity*` components.

## Sources

| What the owner sees | Where it comes from |
|---|---|
| Messages, thinking, commands and their output | the session transcript (`~/.claude/projects/<slug>/<sessionId>.jsonl`) |
| What it is doing now (`detail`), its tempo | `state.json` of the job |
| Plan and background work | `fan` in `state.json` |
| System processes | `~/.claude/sessions/<pid>.json` for the pid, then `ps` |
| What it is stuck on | open input requests, the task's blocker and outbox state |

Nothing is copied into the database: all of it can be read on demand, and the transcript stays on disk
after the session ends, so the log of a finished task is still available.

## The feed

The parser is stateless. The client keeps a cursor, `<session>:<byte offset>`, where `session` is the
`task_sessions` row id, and a poll reads only what was appended after it. Offsets survive a server
restart, and a line still being written is not consumed until it is whole.

- The first request has no cursor and returns the tail of the latest transcript. Transcripts reach tens
  of megabytes, and most of it is `api-request*` lines, which repeat every block of the conversation
  and are skipped.
- `before` reads an earlier window and crosses into the previous session at its beginning.
- A tool result is its own event, paired with its call on the client by `tool_use_id`. An event once
  sent never changes, so there is nothing to invalidate.
- Long fields are cut on the server. The full result of a call is requested separately, by session
  key and offset: the client never passes a path.
- Event ids are built on the transcript line's `uuid`, because a session copy repeats the history of
  the original. The client drops what it has already seen.

The transport is polling, every 1.5 seconds while a session is live and only while a panel is open and
the tab is visible. A transcript grows message by message, so a push would gain under a second, and
open streams would hold up a server restart.

Subagent lines are not in the main feed. It shows the Agent call and its result, and running subagents
are listed as background work.

## The card as one conversation

The task card shows one thread in time order instead of a log next to a list of comments:

- the owner's **comments** (labelled as invisible to the agent: `prompt.py` never includes them),
  **messages to the agent** (`answer`, `rework`) with a receipt, the agent's **messages**, its **steps**
  folded between them, **delegations** to subagents, and the **stages** of the task from its event log
  (started, verification, merge, stopped);
- the header names the agent, what it is doing now (the running command, otherwise the daemon's
  `detail`) and the step of its plan;
- what waits for the owner is part of the thread, shown once. An open input request is the last row,
  with its form, and the call that raised it is left out: the request does not carry the call's id, so
  the last unanswered call of the same tool is the one. A question at the end of a turn is the agent's
  last message, with a "waiting for your reply" mark under it; when the transcript has no message of
  this turn, the question itself comes last. The event log's "is waiting for …" entries are not stages
  in the thread, which shows the question itself. A failure replaces its stage, which the event log cuts to a
  line, with the whole detail.

`ActivityPanel` is the same in the card and in the agent window. It renders the thread and the composer
as two siblings, so the card can pin the composer to the bottom of its one scroll: a sticky element stays
inside its parent, and the thread starts below the description. The thread has no scroll of its own; it
follows the live end of the scroll root only once the reader is there, so a card opens on the task. It
opens at the end when it comes from "Waiting for me" or a request is open, and the agent window always
opens there.

The composer follows the card's state (`composerMode` in `web/src/activity.ts`):

| Card | Primary | Also |
|---|---|---|
| Not started | Note | To work (backlog) |
| Working | Send | Interrupt (and send); Stop; Note |
| Waiting for a reply | Send | Accept the work (not while a message is on its way); Note |
| Open input request | none: the request form takes its place | |
| Quota | Note | |
| Asleep until a wakeup | Send (wakes it now) | Stop, Accept the work, Note |
| Failed | Continue (without a session: Retry) | Retry, Accept the work, Close, Note |
| Done | Rework | Note |
| Verifying, merging | Note | Close |

A note (`kind=comment`) never reaches the agent. A conflict, a dirty working copy, the quota and an
untrusted folder are a one-line notice above the composer, from `blocker` and `blocker_detail` in `now`. `detail_code` turns the text into a plain-language reason: see "Why a card failed" in `execution-log.md`.

`GET /tasks/{id}/activity` returns the feed together with `comments` (each with `sent_text`, what the
session received for the message, and `delivery`, its state in the outbox), `stages` and `delegations`.
The client merges them in `buildConversation` (`web/src/activity.ts`) by time. Comments have whole
seconds and steps milliseconds, so a comment goes before the steps of the same second.

- A message to the agent arrives twice: as a comment and as a prompt in the transcript. The comment stays
  and the prompt marks it as read, found by `sent_text`. A delivered mid-run message is the same.
- Any other human prompt of a task came from orc: the first is the task statement, later ones are a failed
  verification, a resume after a crash or a conflict. The owner has no other way into a session, and the
  prompt templates can be edited, so no text is matched.
- Steps in a row are folded into one line, open while the session is live. Delegations are never folded.

**Delegation.** A call of the `Agent` tool carries `subagent_type` and a description. The call's own
result is not the end: a background subagent answers "launched" at once. Who it was handed to and
whether it is over comes from `<session>/subagents/agent-<id>.meta.json` (`toolUseId`, `finished`), then
from a `<task-notification>` for that agent id, then from `fan`. The subagent's own steps are the same
feed read with `?agent=<id>`; the server builds the path, and the id is validated, so the client never
passes a path. Delegation between orc agents does not exist yet; the delegate row is the place for it.

**The agent's report** is not shown on the card: its final message is in the thread. The summary itself
stays in `tasks.report_json`, which routine summaries read. Old `report` comments still render, as a
muted row. How orc learns that the work is handed in:
[handoff.md](handoff.md).

## Thinking

Claude Code often writes an empty `thinking` block with a signature: the text depends on the session's
display mode, which orc does not control. Such a block is shown as "thought for N s" when the duration
is at least a second, and not at all otherwise. `showThinkingSummaries` made no difference in a spike
on Claude Code 2.1.319, so orc does not set it.

## Stopping

`Dispatcher.stop_session` stops the session and moves the task to `failed` under one lock. A bare
`claude stop` would not do: the next tick would see `in_progress` with a stopped session, take it for a
crash and resume it. `failed` is the existing "your move" state: it frees the worker slot, and the
branch, the working copy and the session stay. Pending messages and open input requests are closed.

`POST /tasks/{id}/resume` takes an optional `message`, which goes into the session instead of the
routine "continue from where you left off". Writing to a running session uses the existing delivery
([message-delivery.md](message-delivery.md)): soft by default, interrupting at the owner's choice.

## Limits

- A single subagent or background command cannot be stopped on its own: the CLI has no command for it.
  Stop acts on the whole session.
- The transcript is written per message, so text does not appear token by token.
- The formats of `state.json` and of the transcript are not a contract. Unknown lines are skipped, and
  a missing `fan` gives an empty list.
