# Wakeups

A task session can ask to be resumed later: at a time, or when another card is done. Until then the card keeps
its worktree and its conversation on disk, but has no live process and does not count against the worker limits.
Before this, an agent that had to wait could only keep its session busy, holding a slot, or give up. The code is
`orc/wakeups.py`, `Dispatcher._fall_asleep` and `Dispatcher._wake_sleepers`.

## The command

    orc task wakeup --in 30m [--note TEXT]
    orc task wakeup --at 2026-11-08T15:00:00Z [--note TEXT]
    orc task wakeup --card 12 [--in 2h] [--note TEXT]

Like `orc task done`, it takes no card of its own: it speaks for the card of the current worktree, with that card's
hook secret, at `POST /api/hooks/tasks/{id}/wakeups`. `--card` waits for another card; with `--in` or `--at` as
well, whichever comes first. `--in` takes `30m`, `2h`, `1h30m`, `1d`, or a bare number of minutes. The note is given
back to the session when it wakes.

The server refuses a time less than a minute ahead or more than 30 days ahead, a time without a zone, a missing or
archived card, and the card itself. A watched card that is already done or failed is a 409 that says "continue now":
the agent should hear it now, not after a sleep.

The permission rules of a session allow this command next to `done` and `fail`, so it runs in `dontAsk` too.

## Going to sleep

The endpoint only records: a pending row in `task_wakeups`, and the handoff signal `sleep` in `tasks.handoff_status`
with the time in `handoff_at`. At the end of a quiet turn the dispatcher reads the turn's signal as for `done` and
`fail` (see [handoff.md](handoff.md)), with the same guards: a message on its way, a recent answer or an open input
request hold it back. The last signal of a turn wins, so `done` after `wakeup` hands the work in, and the wakeup is
cancelled.

A turn that ends in sleep closes its run with the outcome `sleeping`, sets `blocker = sleeping` with the condition in
`blocker_detail` ("asleep until #12 is done"), and shuts the session process down. The card stays `in_progress`. It
is a blocker rather than a status so that every exit of a card in work keeps working on a sleeper: close by hand,
delete, Stop, Retry, accept. In exchange four places skip it:

| Where | Why |
|---|---|
| `_start_ready`, `Dispatcher.status()["running"]` | A sleeper holds no worker slot (`dispatcher.holds_slot`) |
| `_sync_running` | Its `stopped` job is not a crash to resume |
| `_reap_sessions` | Its job is not kept alive |
| `isRunning`, `needsAttention` in the web UI | It is neither running nor waiting for a human |

## Waking

`_wake_sleepers` runs on every tick after the merge step and before `_start_ready`, so a card merged in this tick
wakes its watchers in the same tick, and a sleeper gets a free slot before a new card does. It does nothing on pause
or while the quota pause is on. The machine-load gate that postpones new starts does not hold a wakeup: the sleeper
already has its worktree and a half-done job, like a session resumed after a crash. For each sleeper it takes the first pending wakeup whose condition holds:

| Condition | Reason written |
|---|---|
| The time came | `the time came (…)` |
| The watched card is done | `card #N is done` |
| It failed, was archived or deleted | `card #N failed` / `was archived` / `was deleted`: it would never be done |
| The deadline of a card wakeup passed | `the deadline … passed while #N was not done` |

Within the project's and the global worker limits it marks the wakeup `fired` with the reason, cancels the card's
other pending wakeups, and resumes the session with `trigger = wakeup` and the reason in the run's
`trigger_detail`, which the execution log shows. The prompt says why it woke and repeats the note; the agent checks
the current state itself. A due sleeper with no free slot stays asleep with "woken: …; waiting for a free worker
slot" and is taken on a later tick. A wake that fails marks the card failed.

**No second fire.** The wakeup goes from `pending` to `fired` by a conditional update, under the tick lock, before
the session is resumed. Everything lives in the database and the time comes from the dispatcher's clock, so a
restart neither repeats a fired wakeup nor loses a pending one. A crash between the update and the resume leaves a
card in progress with a stopped session, which the next sync resumes once as after a crash.

**Pending wakeups never outlive their purpose.** Every new run of the card cancels them (`SessionRunner.register`):
the session is awake, and a later fire would resume it a second time. Handing in and failing cancel them too, and
every tick cancels those of a card that is no longer in progress.

## The owner

`GET /api/tasks/{id}/wakeups` lists them; `POST /api/tasks/{id}/wakeups/{wakeup_id}/cancel` cancels a pending one.
The card's right column has a "Wakeups" section, hidden on a card that never had one: the pending wakeups with their
condition, note and a cancel button, the watched card as a link, and the history folded below.

Cancelling the last pending wakeup leaves the card asleep, with nothing to wake it: falling back to plain in-progress
would make its stopped session look like a crash. The composer of a sleeping card offers a message, which wakes the
session now (the run's trigger is `message`, and it cancels the wakeups), Accept the work, and Stop.

## Not built

A shell-command condition: the server would run the agent's text outside Claude Code's permissions. A pull request
condition, which needs `gh`. Repeating wakeups, and wakeups set by the owner. `kind` in `task_wakeups` leaves room
for them.
