# Why there is no `plan` among the execution modes

Verified on Claude Code 2.1.278 with a live spike on 2026-09-21.

## Short answer

The guess "`plan` was left out because it waits for approval and the orchestrator works
automatically" is only half right.

Waiting for a human is exactly what orc can do: the whole `blocker=needs_input` circuit exists for
it — the card gets a "waiting for reply" badge, the question is visible on the board, and the answer
from the UI goes into the same session (`Dispatcher.answer`). Stopping a task to wait for approval
is not a contract violation but a normal scenario.

What breaks is something else: **the orchestrator physically cannot see the wait for plan
approval**. A session that has reached "approve plan" stays in `state.json` with
`state: "working"`, while the waiting signal lives in other fields (`tempo: "blocked"`,
`needs: "approve plan"`) that the dispatcher does not read. The card stays "in progress" forever,
there is no badge, no question on the board, the worker slot is occupied, and there is no timeout
on `in_progress`. The task silently hangs until someone intervenes by hand.

There is also no recorded rationale anywhere for why `plan` was dropped. The list of four modes came
from the initial requirements and was carried over verbatim into the code. It is a default decision,
not a conclusion drawn from the architecture — but, as the spike showed, accidentally the right one.

## Where the list is hard-coded

| Place | What |
|---|---|
| `orc/api/common.py` | `PERMISSION_MODES = {"auto", "acceptEdits", "dontAsk", "bypassPermissions"}` |
| `orc/api/common.py` | `_check_mode()` — anything else gets a 400 on POST/PATCH of a project or task |
| `web/src/types.ts` | `type PermissionMode = "auto" \| "acceptEdits" \| "dontAsk" \| "bypassPermissions"` |
| `web/src/permissions.ts` | the list of modes offered by the permission-mode selects in the task form and in the project settings |

The CLI itself can do more: `claude --permission-mode` accepts `acceptEdits`, `auto`,
`bypassPermissions`, `manual`, `dontAsk`, `plan`. orc exposes four of the six; `plan` and `manual`
are cut off by validation.

## What happens if you launch plan anyway (spike facts)

**Fact 1. The session parks on approval but stays `working`.**
`claude --bg --permission-mode plan "Add a line ... to the README and commit"` a few seconds later:

    {"state": "working", "tempo": "blocked", "needs": "approve plan",
     "detail": "Show the project contents and README", ...}

It stands like that indefinitely: three minutes of observation — `state` did not change.

**Fact 2. The dispatcher does not notice.**
`ClaudeCli.read_state` (`orc/claude_cli.py`) puts `needs` into `JobState`, but `_apply_state`
(`orc/dispatcher.py`) looked only at `st.state`. The `blocked` branch does not fire, the `working`
branch does — and it even *clears* the `needs_input` badge if one happened to be set. The `tempo`
field was not read at all. Consequences:

- the card is in `in_progress` forever, and the board says "working";
- a `max_workers` slot is occupied until someone intervenes;
- the `STATE_LOST_TICKS` protection does not help: `state.json` is there and is read normally;
- there is no timeout on `in_progress`, so this will never resolve on its own.

Queue up five overnight tasks in plan mode = in the morning, five "in progress" cards, zero progress
and occupied slots.

**Fact 3. The mode survives resume.**
`ClaudeCli.resume_bg` (`orc/claude_cli.py`) does not pass `--permission-mode`, but the CLI restores
the saved options itself:

    note: woke session aaa7d388 with its saved options (--name, --permission-mode, --model).

So after `claude stop` + `claude --bg --resume` the session is in plan mode again. `respawnFlags` in
`state.json` confirm this. Since then `resume_bg` has started passing the full set of options, see
[message-delivery.md](message-delivery.md): the mode now comes from the task's parameters.

**Fact 4. Approval through this channel does work.**
Resume with the text "I approve the plan. Go ahead." — the session left planning, edited the file,
committed and finished with `state: "done"`. So if the dispatcher could show "waiting for approval",
the existing reply field on the card would be enough; no separate channel is needed.

## What it takes to enable plan

The minimal set is four changes, and the order matters: without the first two, a select with `plan`
just silently hangs tasks.

1. **See the wait.** *Done, see [input-requests.md](input-requests.md): `JobState.waiting` reads
   `tempo`/`needs`, and plan approval arrives through the `PreToolUse` hook on `ExitPlanMode`.*
   The original wording: `JobState` + `read_state`: pull in `tempo`. In `_apply_state`, treat
   `state == "working" and tempo == "blocked"` (or a non-empty `needs` while `working`) as a reason
   to set `blocker=needs_input` with the text from `needs`. Be careful with the `working` branch,
   which currently clears the badge unconditionally.
2. **Deliver the approval.** Already done: the message queue and `Dispatcher.deliver_messages`
   (see [message-delivery.md](message-delivery.md)) can hand text to a `blocked` session through a
   stop and resume without creating copies. What remains is not returning to plan after approval.
   `resume_bg` must be able to pass `--permission-mode` explicitly, and `answer()` for a plan task
   must resume in a working mode (`auto`/`acceptEdits`), otherwise the session goes back to
   planning after every approval. The spike showed that in one run it coped even without this, but
   that cannot be relied on.
3. **UI.** An "Approve plan" button next to the reply field, and the plan text from `needs` shown in
   full (currently `blocker_detail` is cut to 200 characters in the feed).
4. **The mode list.** `PERMISSION_MODES`, `PermissionMode`, two selects. The test for a 400 on an
   unknown mode (`tests/test_api.py`) stays as it is.

Separately, it is worth deciding whether a task waiting for approval should occupy a worker slot:
right now any `in_progress` task counts as running in `_start_ready`, and plan tasks would hold up
the project's parallelism.

## About `manual`

`manual` is cut off by the same list, and that is most likely right by the same logic: every tool
asks for permission, and there is nobody to answer in the background. Not checked with a spike —
this is a hypothesis, not a fact.

## Conclusion

`plan` is absent not because "you cannot wait for approval" but because the orchestrator does not
see that the session is waiting for it. Adding it to the select only makes sense together with
items 1–2 above; a lone extra line in the dropdown without them is a way to silently hang a task.
