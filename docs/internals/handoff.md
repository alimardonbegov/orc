# Handing in the work

A `claude --bg` session does not exit when its work is over, and the daemon's own `blocked` is a guess from
the text. On a project with no `verify_cmd`, the signal below is the only gate before the merge, so it is an
explicit call and not something inferred from words. The code is `orc/handoff.py` and
`Dispatcher._handoff_of_turn`.

## The signal

    orc task done [--summary TEXT | --summary-file PATH]
    orc task fail --reason TEXT

A third signal, `orc task wakeup`, ends the turn in sleep instead: see [wakeups.md](wakeups.md).

There is no card number. The command finds the card with `GET /api/tasks/context?cwd=…`, reads that card's secret
from `<data>/hook-secrets/task-<id>`, and calls `POST /api/hooks/tasks/{id}/handoff` with it in `X-Orc-Hook`. So a
chat is refused, for it is not in the worktree of a card, and a session cannot speak for a neighbouring card.

The secret lives in orc's data directory, in a 0700 folder, and not in the working copy. A working copy can be
deleted and made again under a live session: a cleanup script once removed one minutes after its card started,
and the agent restored it with `git worktree add`, without the untracked secret, so it could not hand in. A
session issued before the move still has `.orchestrator/hook-secret` in its working copy, and the command falls
back to that.

The endpoint only records. The agent is still in its turn, and shutting the session down here would cut off its
final message. It stores `tasks.handoff_at` (epoch seconds), `tasks.handoff_status` (`done` or `failed`), and the
text in `tasks.report_json` as `{status, summary, notes}`, with `status` as `success` or `failed`, the words the
board and routine summaries already read.

On `done` it refuses with 409 while tracked files have uncommitted changes, and names them: the agent can fix
that now, and nothing later would see those files. Untracked files are named as a warning. A branch with no
commits is allowed, since analysis and planning cards produce none.

## At the end of a turn

The dispatcher looks at a quiet turn as before (`_apply_state`), and compares `handoff_at` with the start of the
turn from the transcript. A new turn makes an old signal stale by itself.

| In this turn | Result |
|---|---|
| `done` | `verifying`, the session is released. An empty summary takes the turn's final message |
| `fail` | `failed` right away, with the reason. The agent has said it cannot, so it is not sent back |
| neither | The card waits for its owner |

A message on its way, a recent answer or an open input request hold the handoff back, as they always did.

The 90 s of transcript silence (`WAITING_QUIET_SEC`) guards the daemon's guess that a turn is a question. An
explicit signal is not a guess, so a turn that has a `done` or `fail` **and** that the transcript shows as over
(`LastTurn.ended`: the file ends on the agent's own text, not on a tool call or result) is acted on on the first
tick, without the quiet wait. A turn without a signal still waits for the quiet period before the card gets the
waiting badge. Why this is safe with subagents: the end of a turn counts as waiting only with no background work
(`in_flight == 0`, or only the agent's own alarms), so a live subagent keeps the card running whatever is in the
transcript. A subagent that still writes after the main turn is over has an `inFlight` entry too. The remaining
guards are the same as above (message on its way, open request), and `done` is refused with 409 while tracked
files are uncommitted, so late writes to them are caught before the signal exists.

The columns are cleared by `retry`, `rework`, resuming a failed card, and sending the task to resolve a merge
conflict: an unresolved conflict must not walk back into the merge on the signal of the previous pass.

A rework, or resuming a failed card with a message, sends the owner's words with one line from orc after them: the
card is open again, so hand it in again when it is finished. Without it a cheap model read the message as a remark
about finished work, made the change and ended its turn without `orc task done`.

## The owner's way out

`POST /api/tasks/{id}/accept` works on a card waiting for its owner with no open input request and no message on
its way, and on a failed card with a working copy where a session has run. It records `done` with the agent's last message, writes a
stage to the thread and goes to `verifying`. Verification still runs and may send the work back once. Uncommitted
changes to tracked files refuse it with 409, naming them, because they would not reach the merge.

## Permissions

`SessionRunner.session_settings` adds `permissions.allow` for exactly these two commands and `task wakeup`, built from the string
`task_guide.cli_command` gives the agent in its system prompt, including an `ORC_DATA_DIR=` prefix when the data
directory is not the default one.

Checked on real sessions in `dontAsk`, on a throwaway server and repository, with **Claude Code 2.1.319**:

| Command as the session ran it | Result |
|---|---|
| `orc task list` (control, not in the rules) | Denied |
| `ORC_DATA_DIR=… orc task done --summary "spike ok"` | Allowed, reached `verifying` |
| `orc task done` | Allowed, reached `verifying`, final message taken as the summary |
| `orc task fail --reason "one line"` | Allowed, reached `failed` |
| `orc task done --summary $'line one\nline two'` | **Denied** |
| `ORC_DATA_DIR=… orc task wakeup --card 1 --note "…"` | Allowed, the card went to sleep (checked later on the same version) |

The last row is why `task_guide.HANDOFF_RULE` asks for the plain form, with the summary in the final message. Claude
Code does not match an `allow` prefix against a command with `$'…'` quoting, and may do the same for other
expansions. An agent that was refused this way, and did not retry, leaves the card waiting with its last message,
and the owner can accept it. One session in that spike also assumed that a denied command meant these two would be
denied as well, so the rule says outright that they are allowed. Check this table again when upgrading Claude Code
past a major change in permissions.

## The transition from report.json

Sessions started under the old prompt keep writing `.orchestrator/report.json`, and a report from the current turn
counts as a handoff: `success` as `done`, `failed` as `fail`, `needs_input` as waiting. A task that sat in `verifying`
during the upgrade reads the file the same way. `handoff.ingest_report` copies the result into the database, and it
is the only reader of that file. An unreadable file is not a handoff, and the card waits for its owner.

Migration 5 removes the report block from a stored `prompt_template` by exact match, keeps the old text in the setting
`prompt_template_before_handoff`, and writes an event. A template that mentions `{report_path}` or `report.json` in any
other way is left alone, and the settings dialog shows a warning with a reset. `build_prompt` still fills `{report_path}`,
so such a template keeps working.

Remove the file half of `orc/handoff.py` once no session can still be following the old prompt.
