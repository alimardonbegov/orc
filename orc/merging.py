"""Merging a task branch into the target and resolving conflicts by the task itself.

Two rules this code is gathered in one place for: we merge strictly one task per
pass (otherwise two tasks fight over one working copy), and a conflict goes back to the session
that wrote the code, because a line-by-line merge does not resolve a semantic conflict. The merge here goes
in the reverse direction, into the task worktree, so nobody fights over the target branch.
"""
from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Callable

from orc import failures, git_ops, handoff, inbox, task_guide, worktrees
from orc.config import Settings
from orc.models import Blocker, Project, Task, TaskStatus
from orc.prompt import CONFLICT_TEMPLATE, build_conflict_prompt
from orc.repo import Repo
from orc.sessions import SessionRunner

log = logging.getLogger("orc.merging")

# How many times in a row we send a task to resolve a conflict with the target branch before calling
# a human. Each attempt is a full cycle "session reconciles the branches -> verification -> merge queue",
# and the next conflict is possible only if in the meantime ONE MORE task landed in the target
# branch. Three cycles cover an ordinary race; more means the task is hopelessly behind.
CONFLICT_RETRY_LIMIT = 3


class Merger:
    def __init__(self, repo: Repo, settings: Settings, sessions: SessionRunner, on_event: Callable[..., None],
                 now: Callable[[], datetime], expand: Callable[[str], str], fail: Callable[..., None]):
        self.repo = repo
        self.settings = settings
        self.sessions = sessions
        self.on_event = on_event
        self.now = now
        self.expand = expand  # image markers -> paths on disk (Dispatcher.with_images)
        self.fail = fail      # the only path to failed (Dispatcher._fail)

    def _now_iso(self) -> str:
        return self.now().replace(microsecond=0).isoformat()

    # ---------- step: merge, strictly one at a time ----------

    def process(self) -> None:
        # dirty_copy is a transient state ("waiting", meaning we recheck), so
        # such tasks are NOT dropped from the queue: _merge looks again at the other's worktree and
        # clears the badge once the owner has committed their work. conflict waits for a human.
        queue = sorted(
            (t for t in self.repo.list_tasks(status=TaskStatus.MERGING)
             if t.blocker in (None, Blocker.DIRTY_COPY)),
            key=lambda t: (t.merge_queued_at or "", t.id),
        )
        for task in queue:
            try:
                project = self.repo.get_project(task.project_id)
                if project is None:
                    self.fail(task, f"project #{task.project_id} was deleted, nowhere to merge",
                              failures.PROJECT_UNAVAILABLE)
                    continue
                merged = self.merge(task, project)
            except Exception as e:
                # Any failure (not only GitError) inside _merge is isolated per task: it has already
                # left the merging queue (became failed), there is nothing to retry in this same
                # tick, and the next one in the queue is merged as usual (the "strictly FIFO,
                # one merge at a time" rule is about the absence of concurrent merges, not about a limit
                # of one task per tick).
                log.exception("merge #%s", task.id)
                self.repo.update_task(task.id, status=TaskStatus.FAILED, blocker_detail=f"merge failed: {e}",
                                      detail_code=self._merge_failure_code(task))
                self.on_event(task, f"#{task.id} merge failed: {e}", "error")
                continue
            if merged:
                return  # one SUCCESSFUL merge per tick, the next one on the next tick
            # conflict or dirty copy: try the next one in the queue

    def merge(self, task: Task, project: Project) -> bool:
        repo_path = Path(project.path)
        target, branch = task.target_branch, task.branch
        if git_ops.has_conflict(repo_path, target, branch):
            self._resolve_conflict(task, project, target, branch)
            return False
        message = f"orc: merge task #{task.id}: {task.title}"
        holder = git_ops.worktree_for_branch(repo_path, target)
        if holder is not None:
            # The copy is in the middle of a merge/rebase/cherry-pick: `git commit -am` here would not "save
            # the owner's changes" but COMPLETE someone else's unfinished operation (in the worst case
            # it would commit conflict markers). We wait until the owner sorts it out.
            if git_ops.is_merge_in_progress(holder):
                self._set_dirty_copy(task, f"a merge/rebase in {holder} is not finished: complete it")
                return False
            if holder == repo_path.resolve():
                if git_ops.autocommit_tracked(holder, f"wip(orc): auto-commit before merge #{task.id}"):
                    self.on_event(task, f"before merging #{task.id} your changes were committed in {target}")
                    # The dry run above compared the COMMITTED target with the task branch, and
                    # the auto-commit has just moved exactly this ref: the "clean" verdict no longer
                    # holds, so we recheck before touching the working copy.
                    if git_ops.has_conflict(repo_path, target, branch):
                        self._resolve_conflict(task, project, target, branch)
                        return False
            elif git_ops.is_dirty_tracked(holder):
                self._set_dirty_copy(task, f"{target} is open in {holder} with uncommitted changes")
                return False
            self._clear_dirty_copy(task, target)
            if not self._merge_here(task, project, holder, target, branch, message):
                return False
            merge_cwd = holder
        else:
            self._clear_dirty_copy(task, target)
            tmp = repo_path / ".claude" / "worktrees" / f"orc-merge-{task.id}"
            git_ops.add_temp_worktree(repo_path, tmp, target)
            try:
                if not self._merge_here(task, project, tmp, target, branch, message):
                    return False
            finally:
                git_ops.remove_worktree(repo_path, tmp)
            merge_cwd = repo_path
        # First we record the successful merge: it has already happened in the working copy, and we must not roll back
        # the status because of push problems (otherwise retry() would delete
        # the branch and worktree and send the worker to redo already integrated work).
        self.repo.update_task(task.id, status=TaskStatus.DONE, done_at=self._now_iso(),
                              blocker=None, blocker_detail=None, conflict_retry_count=0)
        self.on_event(task, f"#{task.id} merged into {target}", "success")
        if project.push_enabled:
            try:
                git_ops.push(merge_cwd, target)
            except Exception as e:
                self.on_event(task, f"#{task.id}: the merge succeeded, but pushing {target} failed: {e}", "warn")
        self._drop_merged_copy(task, project)
        return True

    def _drop_merged_copy(self, task: Task, project: Project) -> None:
        """The branch is fully in the target: the task's working copy only takes disk space, so remove it now.

        Never fails the merge: whatever stays (busy folder, uncommitted files, switched off in settings) is picked
        up later by the periodic cleanup (Dispatcher._cleanup_worktrees)."""
        if self.repo.get_setting("worktree_autoclean", "1") != "1":
            return
        try:
            fresh = self.repo.get_task(task.id) or task
            removed = worktrees.remove_merged(self.repo, project, fresh, self.settings.claude_json_path)
        except Exception:
            log.exception("removing the working copy of merged task #%s", task.id)
            return
        if removed:
            tail = f", branch {removed['dropped_branch']} deleted" if removed["dropped_branch"] else ""
            self.on_event(task, f"#{task.id}: working copy {removed['name']} removed after the merge{tail}")

    def _merge_here(self, task: Task, project: Project, cwd: Path, target: str, branch: str,
                    message: str) -> bool:
        """The merge proper. False means it did not happen, and the task has already gone off to resolve the conflict.

        Between the dry run and the merge itself the target branch may have moved (the owner
        committed, or another task managed to merge). Then `git merge` hits
        a real conflict, which is exactly the case the task session can sort out.
        Previously the card became failed here, and the only button on it ("retry")
        wiped the worktree and sent the worker to redo work that was already done.
        """
        try:
            self._merge_or_abort(cwd, branch, message)
        except Exception:
            try:
                really_conflicts = git_ops.has_conflict(Path(project.path), target, branch)
            except Exception:
                log.exception("conflict recheck after merge failure #%s", task.id)
                really_conflicts = False
            if not really_conflicts:
                raise  # not about a conflict: the failure honestly goes to failed, as before
            log.warning("merge #%s failed with a conflict after the dry run", task.id)
            self._resolve_conflict(task, project, target, branch)
            return False
        return True

    def _merge_or_abort(self, cwd: Path, branch: str, message: str) -> None:
        """A merge with a guarantee: on any failure the working copy is not left in an unfinished merge.

        Without this, `git merge --no-ff` raises an exception on conflict, while the owner's copy
        keeps MERGE_HEAD and files with `<<<<<<<` markers, and the next task in the queue
        finishes them off with an auto-commit. `git merge --abort` is safe: it rolls back exactly
        what the merge itself brought (unlike the forbidden `git reset --hard`).
        """
        try:
            git_ops.merge_no_ff(cwd, branch, message)
        except Exception:
            try:
                if git_ops.is_merge_in_progress(cwd):
                    git_ops.merge_abort(cwd)
            except Exception:
                log.exception("git merge --abort in %s failed", cwd)
            raise

    # ---------- conflict resolution by the task itself ----------

    def _resolve_conflict(self, task: Task, project: Project, target: str, branch: str) -> None:
        """A conflict with the target branch. Reconciling branches is work too, and the task session does it.

        The merge goes in the REVERSE direction: the target branch is merged into the task branch, in its
        worktree. This does not touch the target branch at all, so parallel tasks do not
        fight over it: the same "one merge at a time" invariant as in _process_merging. Once the session
        reconciles the branches and commits, the task goes through verification as usual and gets back in
        the merge queue, now without a conflict.
        """
        if self.repo.get_setting("conflict_autoresolve", "1") != "1":
            self._set_conflict(task, target, branch)
            return
        if task.conflict_retry_count >= CONFLICT_RETRY_LIMIT:
            self._set_conflict(task, target, branch,
                               f"conflict merging {branch} into {target} could not be resolved "
                               f"in {CONFLICT_RETRY_LIMIT} attempts in a row: reconcile the branches manually "
                               f"and clear the badge")
            return
        worktree = Path(task.worktree_path) if task.worktree_path else None
        if worktree is None or not worktree.exists():
            self._set_conflict(task, target, branch,
                               f"conflict merging {branch} into {target}, and the task working copy "
                               f"is gone: nobody can reconcile the branches automatically, do it manually")
            return
        prompt = self._conflict_prompt(task, project, target, branch)
        # The counter grows BEFORE the attempt: a failed launch must also count, otherwise the task
        # goes round this loop every tick until the end of time (same trick as in _handle_failure).
        attempt = task.conflict_retry_count + 1
        task = self.repo.update_task(task.id, conflict_retry_count=attempt)
        # The previous pass's handoff must disappear: otherwise verification would let the task back into
        # the merge on the old one, even if the conflict stayed unresolved.
        task = handoff.clear(self.repo, task)
        inbox.clear(worktree)
        try:
            if task.session_id:
                self.sessions.wake(task, prompt, trigger="conflict")
            else:
                self._start_conflict_session(task, project, worktree, prompt)
        except Exception as e:
            log.exception("starting conflict resolution #%s", task.id)
            self._set_conflict(task, target, branch,
                               f"conflict merging {branch} into {target}, and the conflict resolution "
                               f"session failed to start: {e}")
            return
        self.on_event(task, f"#{task.id} conflict with {target}: handed to the task session "
                          f"(attempt {attempt} of {CONFLICT_RETRY_LIMIT})", "warn")

    def _conflict_prompt(self, task: Task, project: Project, target: str, branch: str) -> str:
        repo_path = Path(project.path)
        # The lists are informational: if git did not answer for some reason, the prompt must still
        # go out, and the session will figure it out on the spot from `git status`.
        try:
            files = git_ops.conflict_files(repo_path, target, branch)
        except Exception:
            log.exception("listing conflicting files #%s", task.id)
            files = []
        try:
            incoming = git_ops.incoming_commits(repo_path, target, branch)
        except Exception:
            log.exception("listing incoming commits #%s", task.id)
            incoming = []
        return build_conflict_prompt(
            self.repo.get_setting("conflict_prompt_template") or CONFLICT_TEMPLATE,
            title=task.title, description=self.expand(task.description), branch=branch,
            target_branch=target, verify_cmd=task.verify_cmd or project.verify_cmd or "not set",
            orc_command=task_guide.cli_command(self.sessions.settings.data_dir), files=files, incoming=incoming,
        )

    def _start_conflict_session(self, task: Task, project: Project, worktree: Path, prompt: str) -> None:
        """Fallback path: the task session is gone (carried away by `claude rm` or a job cleanup).

        A new session knows only the task text and the conflict itself, and has no context for why the code was written
        this particular way. So this is a fallback, not the main path: it is better for
        whoever diverged the branches to reconcile them.
        """
        self.sessions.start(task, project, worktree, prompt, f"orc#{task.id} conflict: {task.title}",
                            trigger="conflict")

    def _merge_failure_code(self, task: Task) -> str | None:
        """A merge that broke because the task branch is gone says so; any other break stays text only."""
        try:
            project = self.repo.get_project(task.project_id)
            if project and task.branch and task.branch not in git_ops.list_branches(Path(project.path)):
                return failures.BRANCH_GONE
        except Exception:
            log.debug("could not look for the branch of #%s", task.id, exc_info=True)
        return None

    def _set_conflict(self, task: Task, target: str, branch: str, detail: str | None = None) -> None:
        self.repo.update_task(
            task.id, blocker=Blocker.CONFLICT,
            blocker_detail=detail or f"conflict merging {branch} into {target}, resolve it manually and clear the badge",
            detail_code=failures.CONFLICT_UNRESOLVED,
        )
        self.on_event(task, f"#{task.id} conflict with {target}", "warn")

    def _set_dirty_copy(self, task: Task, detail: str) -> None:
        if task.blocker != Blocker.DIRTY_COPY or task.blocker_detail != detail:
            self.on_event(task, f"#{task.id} is waiting: {detail}", "warn")
        self.repo.update_task(task.id, blocker=Blocker.DIRTY_COPY, blocker_detail=detail)

    def _clear_dirty_copy(self, task: Task, target: str) -> None:
        """The path to merge is clear: remove the waiting badge if it was hanging from the previous tick."""
        if task.blocker == Blocker.DIRTY_COPY:
            self.repo.update_task(task.id, blocker=None, blocker_detail=None)
            self.on_event(task, f"#{task.id}: {target} is free now, merging")
