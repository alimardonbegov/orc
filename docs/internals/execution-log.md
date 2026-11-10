# The execution log of a card

The right column of a card shows its accounting next to the thread: what the agent spent, each run of
its session, each check of its work and each merge. `GET /api/tasks/{id}/runs` returns all of it,
built by `orc/runs.py`; the card draws it in `web/src/components/ExecutionLog.tsx`.

## Runs

A run is a row of `task_sessions`: one Claude Code job of the task. Every launch passes its cause to
`SessionRunner.start`, `wake` or `resume` as `trigger`, and `register` writes it with the agent the
card is assigned to. Nothing guesses the cause from the prompt text, and an unknown trigger is
refused before anything is launched.

| Trigger | Who starts the run |
|---|---|
| `start` | `_start`: the first session in a fresh working copy, also after Retry |
| `rework` | `_start`: the owner sent a finished card back |
| `resume` | `resume_failed`: the owner resumed a failed card |
| `crash` | `_handle_failure`: the session died and orc resumes it once |
| `quota` | `_retry_quota`: the usage limit lifted |
| `verify_failed` | `_verify_failed`: the check failed, or the session ended without handing in |
| `conflict` | `_resolve_conflict`: the merge met a conflict, in the same session or a fresh one |
| `message` | `_deliver_by_resume`: an owner's message went in by restarting the session |
| `wakeup` | `_wake_sleepers`: a wakeup the session asked for came due; `trigger_detail` says which (see [wakeups.md](wakeups.md)) |

A run ends with `ended_at` and an `outcome`. `end_run` closes only open rows, so the first outcome
recorded is the one that happened.

| Outcome | Where |
|---|---|
| `handed_in` | `_session_done`, also when the owner accepts the work |
| `failed` | `_fail`, `_count_state_miss`, and `_handle_failure` before it resumes |
| `stopped` | `stop_session`, `force_done`, `retry` |
| `quota` | `_enter_quota_wait` |
| `superseded` | `register`: a newer run of the same task started while this one was open |
| `sleeping` | `_fall_asleep`: the session asked for a wakeup and was shut down until then |

Rows written before the log have no trigger and no end. The card labels them "Run", and the log
takes their end from the next run, or from the moment the task last changed.

## Cost

There is no second accounting. `usage_ledger` already holds the task's spending as increments over
time (`_log_usage_delta`), and each increment goes to the latest run that started strictly before it.
Strictly, because the dispatcher counts tokens right before it resumes a session, in the same second
the next run starts. An increment written after a run ended, while no newer run had started, still
belongs to it. A resumed session that repeats its history counts once, the way the task's total does.

The log prices by the estimate, while the card's total may be Claude Code's exact price
(`analytics.task_cost`). So the log only gives the proportions: each run's share is scaled to the
card's total cost and tokens from `usage_json`, and the rounding remainder goes to the last run. The
runs add up to the number the card shows, to the cent. With no log entries at all, the whole total
goes to the last run.

## Checks

`_apply_verify_outcome` writes a row of `task_checks` for every check that is still about the task:
the command, whether it passed, how long it took and the last 8000 characters of its output. Before,
a failed check's output reached only the agent. The card opens it as plain text.

It also keeps the exit code (`exit_code`) and whether the timeout killed the check (`timed_out`), because a
command like `test ! -f X && ...` fails without printing anything. A check that printed nothing reads
"exited with code N" instead of "printed nothing"; a timeout reads as a timeout and has no code. Rows written
before this have `exit_code` NULL (and `timed_out` NULL, returned as false): the card shows only "printed nothing".

## Merges

A merge has no table. The log reads the merge queue's own events (`orc/merging.py`): "merged into",
"merge failed" and "conflict with". The patterns live in `runs.MERGE_EVENTS`, with a test, so a
reworded event breaks the test rather than the log.

## The card

Totals first: spent, tokens and agent time. Then the active runs, never cut, then the past newest
first, three rows in all; the rest are behind "Show all", which also holds the breakdown of tokens
by model and agent. Actions act on the task, so they sit on the row they concern: Stop and "open in
the thread" on the active run of a card in work, and "run again in the same session" on the latest
run of a failed card. Retry from scratch, which drops the working copy, stays in the composer.

## Why a card failed

`blocker_detail` is the technical text: git output, a lost `state.json`, the agent's own words. Beside it
`tasks.detail_code` holds a code from `orc/failures.py`, so the web UI can say the reason in the owner's
language and name the next step (`web/src/failures.ts`, the `card.failure.*` strings in six locales). The codes are
`session_lost`, `quota_limit`, `project_unavailable`, `branch_gone`, `check_failed_again`, `conflict_unresolved`,
`stopped_by_owner` and `agent_reported`. A test keeps the Python and TypeScript lists equal.

- The code is written by the same call that writes the text (`Dispatcher._fail(task, detail, code)`, the merge
  step). `Repo.update_task` clears `detail_code` whenever `blocker_detail` is written without one, so a code never
  outlives its text: a retry, a resume or a new blocker drops it.
- A failure no code describes (a start that broke, a merge that broke for another reason) has no code, and every
  place shows its text as it always did. So does a card from before the codes, and a code this client does not know.
- The thread's failure row and the conflict notice show the reason, the hint and the text behind "Technical
  details". The latest run of a failed card shows the reason as its second line. `now.detail_code` and
  `task.detail_code` are absent on an older server; the UI then falls back to the text.
- The hints point at the composer's buttons (Continue, Retry, Accept) and the notice's "Conflict resolved", by
  their translated labels, so a renamed button changes the hint with it.
