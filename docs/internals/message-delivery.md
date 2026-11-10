# Delivering messages to a task session

Verified on Claude Code 2.1.319 with live sessions on 2026-11-06.

## The problem

Send a message to a Claude that is already working on a task, and have it behave the way a console
does: the text reaches the agent whatever it is doing, and the owner can interrupt it at any moment.
All of that without a second session in the same worktree, without losing the text, and with the
board showing what happened to the message.

## Channels

| Session state | Channel | Interruption | Card state |
|---|---|---|---|
| live: `working`, `blocked` | typed into the session's input box through `claude attach` | only on request, or when a dialog is open | none: delivered within seconds |
| live, typing unavailable | a file in the inbox, picked up by a hook | no | `message sent to session` |
| live, typing unavailable, interrupt or waiting | `stop` → confirmation → `resume` | yes | `stopping session` |
| `stopped` / `done` / `failed` | `resume` immediately | no | none |

The choice is made in `MessageDelivery.deliver` (`orc/delivery.py`).

## Typing into the session

`claude attach <id>` opens the session's own input box. `orc/session_input.py` runs that client on a
pseudo-terminal for the second or two it takes to type, then detaches. Whatever is typed goes through
the same path as console input, so these behaviours come for free:

- **Idle session, also with subagents or background commands running:** the message starts a turn at
  once. The background work stays.
- **A tool is running:** the message goes into the session's own queue (`queue-operation enqueue` in
  the transcript) and is absorbed at the next step.
- **Esc:** the running tool is cancelled, its process dies, and the queue is delivered right away. The
  process, the job id, the hooks and the background work stay. This is the "Interrupt" button
  (`Dispatcher.interrupt`, `POST /api/tasks/{id}/interrupt`), and with text in the field it presses
  Esc and then sends the text.
- **An open dialog** (a question, a permission, a tool held by a hook): Esc dismisses it, the tool is
  rejected and the hook is cancelled. Delivery presses Esc first when `tempo == "blocked"`, `needs` is
  set or a request is open, because Enter would otherwise pick the highlighted option.

### What the driver has to get right

These were each measured, and each is covered by a test in `tests/test_session_input.py`:

- **The text is typed, not pasted.** A bracketed paste of about 800 characters or more, or of many
  lines, reaches the model wrapped in `<pasted_content>`, as material from elsewhere rather than the
  owner's words. Typing in chunks of 32 characters arrives as plain text, byte for byte, including
  Cyrillic, emoji and 4 KB messages. A line break is Alt+Enter (`ESC CR`), since a bare CR submits.
- **Control characters are dropped from the text.** A raw ESC would act as a key press.
- **A leading `/`, `!`, `#` or `&` gets a space in front of it**, or the input box treats the text as
  a command and the agent never sees it. A message stays a message, as it was when it travelled in a
  prompt or a hook.
- **A backslash at the end of a line gets a space.** Backslash + Enter is a line break, so the message
  would stay in the box unsubmitted, and a backslash in front of a line break is eaten.
- **Unsubmitted text outlives the client.** A draft is still in the box after a detach and a new attach.
  So an attempt without a receipt empties the box with Ctrl+U before detaching, or the text would stick
  to the next attempt or to what the owner types next.
- **Attach only to a live session.** `claude attach` on a stopped session opens it again, behind the
  back of the dispatcher.
- **Other clients are not disturbed.** An owner attached in a terminal keeps working alongside.

### The receipt

The transcript is the delivery confirmation: `transcript.session_received` looks for the text in a
`type: "user"` row or a `queue-operation enqueue` row newer than the message. The whole text has to
match, by its letters and digits: a short reply like "ok" is part of nearly any row, agent notifications
included, and a loose match would declare a message delivered that was never typed. The client stays
attached until the receipt appears. Without a receipt the message stays pending, and the next attempt checks
the transcript first, which keeps a slow receipt from typing the text twice. After `TYPING_ATTEMPTS`
attempts, or when the client cannot reach the input box at all, the message moves to the inbox or to a
stop and resume. A session whose transcript is unknown skips typing, because an unconfirmed attempt
could not be told from a lost one.

## How the inbox works

The dispatcher writes `<worktree>/.orchestrator/inbox/msg-<id>.json`. The session is started with
hooks passed to `claude --settings` **as a JSON string in the argument** — the orchestrator creates
nothing in the user's repository. On the next tool call the `PostToolUse` hook fires: the script
`orc/hooks/inbox_hook.py` reads the inbox, returns the text in
`hookSpecificOutput.additionalContext` and moves the file to `inbox/delivered/`.

Moving the file is the delivery confirmation: the dispatcher sees it on the next tick and marks the
message `delivered`. The hook is also attached to the `Stop` event: if a message arrives at the moment
the agent is finishing, it is not allowed to finish (`{"decision": "block", "reason": "<text>"}`). By
then the files are already marked as delivered, so the next `Stop` passes freely and no loop occurs.

This channel has a real limit, which is why it is no longer the first choice: it lives on tool calls of
the main thread. A session that thinks for a long time, or whose main thread is idle while subagents
work, picks nothing up. After `DELIVERY_STALL_TICKS` ticks the card says "message not picked up", and
the modal offers "Interrupt session".

Before writing into a live session by typing, the dispatcher clears the inbox, or the hook would hand
over a second copy.

## Resume always carries the full set of options

`claude --bg --resume <sessionId>` has three outcomes, and only the flags make them predictable:

| Original session | Flags | Result |
|---|---|---|
| stopped and settled by the daemon | none | the same job is woken with its saved options |
| stopped, not settled yet | none | **a copy with no options at all** |
| any | any | a copy carrying exactly the flags passed |

`state.json` says `stopped` about a second before the daemon settles the job (1.1 to 1.6 s measured).
The dispatcher confirms a stop by `state.json` and resumes at once, so a flagless resume landed in that
window nearly every time: the CLI prints `note: session <old> is already running ..., so this started a
copy as <new>`, and the copy's `respawnFlags` are just `--model sonnet`. The session lost its hooks, so
inbox messages were never picked up; it lost its permission mode, persona and effort; and it silently
changed model. Since 2.1.299 this hit every continued session.

This section is about task sessions. Direct chats still resume without flags (`orc/chats.py`).

So `SessionRunner.resume` always passes the name, permission mode, model, effort, settings and system
prompt. The result is always a copy under a new job id and session id with the history intact, and the
dispatcher follows it (`task_sessions` keeps the chain for token accounting).

The invariant stays:

> `resume` is called only when the session state has been **read** and is `stopped`, `done` or
> `failed` (`RESUMABLE_STATES` in `orc/sessions.py`). A live session is never resumed.

Otherwise the old process would keep working next to its copy.

## If the task has left `in_progress`

An undelivered message is marked `failed` with an event in the feed — it does not hang in the queue
forever.

## What this gives plan mode

Waiting that arrives in the `tempo` and `needs` fields (tool permission, AskUserQuestion, plan) is
seen by the dispatcher (`JobState.waiting`). The owner answers those dialogs through the
`PermissionRequest`/`PreToolUse` hooks — see [input-requests.md](input-requests.md). A plain message
sent past an open dialog dismisses it with Esc, as it would in a console.
