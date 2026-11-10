# How orc works

This page follows one task from the card on the board to the merge, and then covers the
edges: queueing, conflicts, questions, scheduled starts, routines and cleanup. For the
reasoning behind the interface see [design/ui-design.md](design/ui-design.md); for the
delivery of answers into live sessions see [internals/](internals/).

## The flow in eight steps

1. **Add a project.** Give orc the path to a git repository, a verification command
   (`verify_cmd`, for example `make test`) and a worker limit (how many tasks of this
   project may run at once). Without a `verify_cmd` the merge trusts only the agent's own
   word, so setting one is strongly recommended.
2. **Create a task card.** Write the assignment in the "Task for the agent" field, assign an
   agent and drag the card to "To do", or use "Create and start". Cards in "Backlog" are
   never picked up, and a card with nobody assigned belongs to a person, so it cannot go to
   "To do". See [internals/task-cards.md](internals/task-cards.md).
3. **The dispatcher picks it up.** Every `poll_interval_sec` (30 seconds by default) the
   dispatcher looks at the queue. For a task that fits under the worker limits it creates
   a branch `orc/task-<id>` from the task's target branch, checks it out in a git worktree
   at `.claude/worktrees/orc-task-<id>` inside the repository and starts `claude --bg`
   there with the assignment text. The branch is cut at the moment the
   task starts, so a task that starts later already contains everything merged before it.
4. **Handoff and verify gate.** The agent ends its work by running `orc task done`, or
   `orc task fail` if it cannot complete it. When that turn is over, orc acts on the signal:
   `fail` marks the task as failed with the agent's reason, and `done` runs `verify_cmd` in
   the task's worktree. If the command fails, the task goes back to the same session once
   with the command output; a second failure marks the task as failed and it waits for you.
   If it passes, the task joins the merge queue. A turn that ends with neither command is not
   a handover: the agent stopped for your answer, and the card waits for it. If the agent
   forgot, `POST /api/tasks/{id}/accept` takes its work as handed in, and verification
   still runs. See [internals/handoff.md](internals/handoff.md). The card's execution log
   shows every run of the session with why it started and how it ended, and the output of
   every check: see [internals/execution-log.md](internals/execution-log.md).
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
   The question is the last row of the card's conversation; your answer, typed in the
   composer under it, is delivered to the same live session within seconds, without a
   restart. See [internals/input-requests.md](internals/input-requests.md).
8. **Talking to a working agent.** A message from the card is typed into the session the way
   you would type it in a console: it reaches the agent whatever it is doing, and "Interrupt"
   works like Esc. See [internals/message-delivery.md](internals/message-delivery.md).

## The card

A card describes the work once, and everything between you and the agent happens in its
conversation. One scroll, top to bottom:

- **Title and description.** A question from the agent never pushes them aside. Click to edit;
  the field grows with the text.
- **Relations.** "Waits for" and "Comes next" come from the task's dependencies, which hold the
  queue. "Subtasks" group a decomposition: a card created from a session lands under the card it
  came from, and the board shows a done/total chip on the parent. Subtasks do not hold the queue.
  A "List / Tree" toggle shows the whole chain of dependencies around the card.
- **Conversation.** The session's messages and commands, and the stages orc adds: handed in,
  verification, merge, conflict, rework. A permission, a choice or a plan arrives as a form at the
  end, in place of the composer. Under it, one composer that follows the state of the card:
  "Send to agent" while the agent works or waits, "Continue", "Retry" and "Accept the work" after
  a failure, "Rework" when the card is done, and a note that the agent never sees.

The right column holds the facts: status, assignee, priority, branch and the properties you
added (labels, start and due dates, which are a plan for people and are never read by the
queue). Below them, the **execution log** lists every run of the session with why it started,
how it ended and what it cost, every check with its output, and every merge. **Details** at the
bottom gives who created the card, when it started and finished, its branch, its worktree and
the command to attach to the session.

## Agents and chats

A task is assigned to an agent: a saved set of model, effort and permission mode plus an optional
prompt. What the agent leaves empty falls through to the project. The creation form no longer sets
these per card; a value set on the task through the CLI or the API still wins. You can also talk to an agent directly in a chat,
which runs in a private worktree and never merges anything, and appoint a project lead that plans
with you and proposes tasks for your approval. See
[internals/agents.md](internals/agents.md).

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
- The previous handoff is cleared before the prompt is sent, so a stale "done" cannot send the
  task back into the queue.
- After the session commits the merge and runs `orc task done` again, the task goes through the
  normal path: verification (now on the combined code) and the merge queue. It gets a new place at the
  **back** of the queue.
- There are **three attempts**. After that the task gets a "conflict" badge and waits for a
  human. Automatic resolution can be switched off with the setting `conflict_autoresolve=0`;
  then every conflict goes straight to a human.

Keep in mind that the verification gate runs on the task's own branch before the task joins
the queue, and the conflict check looks for line-level conflicts. Two tasks that touch
different files but depend on each other's behavior can therefore still merge without a
conflict.

## Edge cases

**Writing to a session without a question.** "Send to agent" in the card's composer sends
text to a running session without interrupting it, through a hook that orc installs when it
starts the session; "Interrupt" stops the current step first, like Esc. "Note, hidden from the
agent" keeps a remark on the card that the session never receives. On a finished card the
composer offers "Rework": the task returns to "To do", continues the previous session in the
same worktree and is merged a second time. The session is reminded to hand the work in again.

**An agent that forgets to hand in.** A turn that ends without `orc task done` leaves the card
waiting for you with the agent's last message. If the work is finished, "Accept the work" in
the composer hands it in for the agent; verification still runs. The same button is offered on a
failed card whose session did some work.

**A stuck task.** Close it by hand on the board by moving it to "Done" with confirmation:
the session is stopped and no merge happens.

**Archive or delete.** Archiving is reversible: the card, its conversation, summary, branch
and worktree all stay, but the task disappears from the board and the dispatcher no longer
takes it. Deleting is permanent: it removes the task together with its conversation and
summary, stops the session and, by default, deletes its branch and worktree (you can keep
them). A running task is deleted only with explicit confirmation.

**An agent that has to wait.** A session that cannot go on until a time or until another card is done runs
`orc task wakeup` as the last action of its turn. The card then sleeps in "In progress" without a session or a
worker slot, and resumes in the same session when its wakeup fires. The card's "Wakeups" section lists them and
cancels one. See [internals/wakeups.md](internals/wakeups.md).

**Scheduled start.** In the task form, "Start" then "On schedule" sets a "not before" time
and an optional "not after" time. The schedule applies only while the task is in "To do":
until the time comes it waits with a countdown on the card and does not occupy a worker slot.
If the window ends without the task starting (slots busy, blockers not ready, dispatcher on
pause), it goes back to "Backlog" with a comment. The start accuracy is the dispatcher's
polling interval.

**Recurring routines.** The "Routines" page in the left column holds an instruction plus a schedule: every N
minutes, hours or days, or a cron expression in your time zone. At the scheduled moment the
dispatcher creates an ordinary task from the routine, and that task goes through the same
flow as everything above, so every run has its own card with status, log, summary and token
usage. While the previous run is unfinished, the next slot is skipped, and slots missed while
the server was down are not made up. A routine can be paused, run immediately, or limited to
a number of runs. Deleting a routine deletes only the schedule; the runs stay as tasks.
A routine does not have to belong to a project: without one it needs an agent, and each run is
a new chat with that agent (the instruction is its first message) instead of a card, so there
is no worktree, verification or merge. The "Routines" tab inside a project still shows that
project's own routines.
