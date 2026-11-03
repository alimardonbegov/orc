# Delivering messages to a task session

Verified on Claude Code 2.1.278 with a live spike on 2026-09-21.

## The problem

Send a message to a Claude that is already working on a task, while:

- not ending up with a second session in the same worktree;
- not losing the text if something goes wrong;
- showing on the board what is happening to the message.

## Why a session copy used to appear

There is exactly one cause: `claude --bg --resume <sessionId>` on a session the daemon considers
alive does not continue it but starts a copy. The daemon says so itself:
`note: session <old> is already running ..., so this started a copy as <new>`.

The old `answer()` stopped the session, waited about six seconds for confirmation and resumed it
**regardless** — otherwise the owner's reply, which lived on the stack of the HTTP request, would
simply have been lost. So the choice was between "lose the text" and "create a copy".

Now the text is stored in the `outbox` table, so there is nothing to lose, and resume obeys an
invariant:

> `resume` is called only when the session state has been **read** and is `stopped`, `done` or
> `failed` (`RESUMABLE_STATES` in `orc/sessions.py`). A live session is never resumed.

The only place where this happens is `Dispatcher.deliver_messages`.

## Two delivery channels

| Session state | Channel | Interruption | Card state |
|---|---|---|---|
| `working`, `soft` mode | a file in the inbox, picked up by a hook | no | `message sent to session` |
| `working`, `interrupt` mode | `stop` → confirmation → `resume` | yes, at the owner's choice | `stopping session` |
| `blocked` (waiting for a reply) | `stop` → confirmation → `resume` | nothing to interrupt | `stopping session` |
| `stopped` / `done` / `failed` | `resume` immediately | — | — |

`blocked` goes through a stop not by choice: a session that is waiting for a reply makes no tool
calls, so the hook cannot reach it.

## How soft delivery works

The dispatcher writes `<worktree>/.orchestrator/inbox/msg-<id>.json`. The session is started with
hooks passed to `claude --settings` **as a JSON string in the argument** — the orchestrator creates
nothing in the user's repository. On the next tool call the `PostToolUse` hook fires: the script
`orc/hooks/inbox_hook.py` reads the inbox, returns the text in
`hookSpecificOutput.additionalContext` and moves the file to `inbox/delivered/`.

Moving the file is the delivery confirmation: the dispatcher sees it on the next tick and marks the
message `delivered`. No IPC with the daemon is needed.

The hook is also attached to the `Stop` event: if a message arrives at the moment the agent is
already finishing, it is not allowed to finish (`{"decision": "block", "reason": "<text>"}`). By
then the files are already marked as delivered, so the next `Stop` passes freely and no loop
occurs.

## Spike facts

1. **Delivery to a live session works.** The session counted to thirty with pauses, and at second 25
   the message "stop counting and create INBOX_OK.txt" landed in the inbox. One tool call later the
   file appeared with the line "delivered at number 7". `claude stop` was not called, the job id did
   not change, no copy appeared.
2. **The hook survives `resume`.** After `claude stop` and `claude --bg --resume <sid>` the daemon
   prints: `note: woke session ... with its saved options (--name, --permission-mode, --settings, --model)`.
   The second message reached the resumed session the same way. That is why `resume_bg` does not
   pass the settings flag — it is already saved in the session.
3. **`cwd` in the hook is the task's worktree**, so the inbox is looked up exactly where the
   dispatcher writes it.

## Cost and limits

- Soft delivery waits for the next tool call. If the session thinks for a long time and calls
  nothing, the message sits there; after `DELIVERY_STALL_TICKS` ticks the card says plainly
  "message not picked up", and an "Interrupt session" button appears in the modal.
- The hook runs on **every** tool call, so it has to be cheap: stdlib only, one directory check,
  exit. An error inside the hook must not bring the session down — hence the top-level `except`
  and `exit 0`.
- An interruption is still an interruption: `stop` cuts off the current action. The context is not
  lost, though — `resume` restores the session history.
- If the task has already left `in_progress`, an undelivered message is marked `failed` with an
  event in the feed — it does not hang in the queue forever.

## What this gives plan mode

The same machinery covers plan approval too (see [plan-mode.md](plan-mode.md)): a session waiting
for approval sits in `blocked`, so it falls into the table row with `stop` → `resume`.

Waiting that arrives in the `tempo` and `needs` fields (tool permission, AskUserQuestion, plan) is
now seen by the dispatcher (`JobState.waiting`), but for such dialogs stop + resume is not an
answer: the agent would ask for the permission again, and a question with options would be
interrupted. They have a separate channel through the `PermissionRequest`/`PreToolUse` hooks — see
[input-requests.md](input-requests.md).
