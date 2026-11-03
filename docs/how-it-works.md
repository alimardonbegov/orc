# How orc works

This page follows one task from the card on the board to the merge, and then covers the
edges: queueing, conflicts, questions, scheduled starts, routines and cleanup. For the
reasoning behind the interface see [design/ui-design.md](design/ui-design.md); for the
delivery of answers into live sessions see [internals/](internals/).

## The flow in seven steps

1. **Add a project.** Give orc the path to a git repository, a verification command
   (`verify_cmd`, for example `make test`) and a worker limit (how many tasks of this
   project may run at once). Without a `verify_cmd` the merge trusts only the agent's own
   report, so setting one is strongly recommended.
2. **Create a task card.** Write the assignment in the "Task for the agent" field and drag
   the card to "To do", or create it there directly. Cards in "Backlog" are never picked
   up.
3. **The dispatcher picks it up.** Every `poll_interval_sec` (30 seconds by default) the
   dispatcher looks at the queue. For a task that fits under the worker limits it creates
   a branch `orc/task-<id>` from the task's target branch, checks it out in a git worktree
   at `.claude/worktrees/orc-task-<id>` inside the repository and starts `claude --bg`
   there with the assignment text. The branch is cut at the moment the
   task starts, so a task that starts later already contains everything merged before it.
4. **Report and verify gate.** When the session finishes, orc reads
   `.orchestrator/report.json` and runs `verify_cmd` in the task's worktree. If the report
   is missing or says `failed`, or the command fails, the task goes back to the same
   session once with the explanation (the command output included); a second failure
   marks the task as failed and it waits for you. If everything passes, the task joins the
   merge queue.
5. **Merge, strictly one task at a time.** Queued tasks are taken in the order they became
   ready (first in, first out). Each is merged into its target branch with
   `git merge --no-ff` and the commit message `orc: merge task #<id>: <title>`. At most
   one task is merged per dispatcher tick. If you are working in the target branch
   yourself (it is checked out in the repository's main working copy), orc first commits
   your tracked changes in a separate `wip(orc): auto-commit before merge #<id>` commit
   and then merges the task. Untracked files are left alone. Push happens only if it is
   switched on in the project settings; the task is marked done before the push, so a
   failed push never rolls the merge back.
6. **Conflicts go back to the agent, not to you.** If the task's branch no longer merges
   cleanly because other tasks changed the same files in the meantime, orc sends the
   conflict back to the **same session** that wrote the code. The session merges the
   target branch into its own branch, resolves the conflict by meaning rather than by
   gluing lines, runs the verification again and the task re-enters the merge queue.
7. **Questions from the agent.** If the session asks something (a permission, a choice
   between options, an approval of a plan, or a plain text question), the card gets a
   "waiting for reply" badge, floats to the top of its column and is counted in the header.
   Your answer, written as a comment, is delivered to the same live session within
   seconds, without a restart. See [internals/input-requests.md](internals/input-requests.md).

## The merge in detail

The merge logic lives in `orc/merging.py`.

**One merge at a time.** Merges never run in parallel, so two tasks never fight over one
working copy. A task that arrives while its target branch is busy simply waits in the merge
queue; it does not fail. A task that hits a conflict, or whose target branch is open in
another worktree with uncommitted changes, does not block the tasks behind it: the dispatcher
moves on to the next one in the queue.

**A dry run first.** Before touching any working copy, orc checks the merge with
`git merge-tree --write-tree`. This detects line-level conflicts without changing anything on
disk. Where the merge then happens depends on where the target branch is checked out:

- In the repository's main working copy: your tracked changes are auto-committed as a `wip`
  commit (see step 5), the dry run is repeated because that commit moved the target branch,
  and the merge runs there. A merge that is already in progress there (an unfinished merge,
  rebase or cherry-pick) is never completed on your behalf: the task shows a "dirty copy"
  badge and waits until you finish it.
- In another worktree: if it has uncommitted tracked changes, the task shows the same badge
  and waits; otherwise the merge runs there.
- Nowhere: orc creates a temporary worktree `.claude/worktrees/orc-merge-<id>`, merges in it
  and removes it afterwards.

If a merge fails halfway, orc runs `git merge --abort`, so a working copy is never left with
conflict markers in it.

## How conflicts are resolved

A conflict is resolved **in the opposite direction**: `git merge <target>` runs inside the
task's own worktree, so the target branch is not touched and parallel tasks do not compete
for it.

- The prompt goes to the **same session** that wrote the code, because it knows why the code
  looks the way it does. A new session is started only as a fallback when the old one no
  longer exists.
- The prompt lists the conflicting files and the commits that landed in the target branch
  since the task branched off. It tells the agent that when its decision and the target
  branch contradict each other, **the target branch wins**: it is newer and has already been
  accepted.
- The old report is deleted before the prompt is sent, so a stale "success" cannot send the
  task back into the queue.
- After the session commits the merge, the task goes through the normal path again: report,
  verification (now on the combined code), and the merge queue. It gets a new place at the
  **back** of the queue.
- There are **three attempts**. After that the task gets a "conflict" badge and waits for a
  human. Automatic resolution can be switched off with the setting `conflict_autoresolve=0`;
  then every conflict goes straight to a human.

Keep in mind that the verification gate runs on the task's own branch before the task joins
the queue, and the conflict check looks for line-level conflicts. Two tasks that touch
different files but depend on each other's behavior can therefore still merge without a
conflict.

## Edge cases

**Writing to a session without a question.** The "To session" button next to the note field
sends text to a running session without interrupting it, through a hook that orc installs
when it starts the session. On a finished card the same button is called "Rework": the task
returns to "To do", continues the previous session in the same worktree and is merged a
second time.

**A stuck task.** Close it by hand on the board by moving it to "Done" with confirmation:
the session is stopped and no merge happens.

**Archive or delete.** Archiving is reversible: the card, its conversation, report, branch
and worktree all stay, but the task disappears from the board and the dispatcher no longer
takes it. Deleting is permanent: it removes the task together with its conversation and
report, stops the session and, by default, deletes its branch and worktree (you can keep
them). A running task is deleted only with explicit confirmation.

**Scheduled start.** In the task form, "Start" then "On schedule" sets a "not before" time
and an optional "not after" time. The schedule applies only while the task is in "To do":
until the time comes it waits with a countdown on the card and does not occupy a worker slot.
If the window ends without the task starting (slots busy, blockers not ready, dispatcher on
pause), it goes back to "Backlog" with a comment. The start accuracy is the dispatcher's
polling interval.

**Recurring routines.** The "Routines" view holds an instruction plus a schedule: every N
minutes, hours or days, or a cron expression in your time zone. At the scheduled moment the
dispatcher creates an ordinary task from the routine, and that task goes through the same
flow as everything above, so every run has its own card with status, log, report and token
usage. While the previous run is unfinished, the next slot is skipped, and slots missed while
the server was down are not made up. A routine can be paused, run immediately, or limited to
a number of runs. Deleting a routine deletes only the schedule; the runs stay as tasks.
