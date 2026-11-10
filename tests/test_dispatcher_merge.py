import subprocess
from pathlib import Path

import pytest

from orc import git_ops
from orc.dispatcher import CONFLICT_RETRY_LIMIT
from orc.models import Blocker, TaskStatus
from orc.handoff import REPORT_REL_PATH


def _in_merging(repo, dispatcher, project, git_repo, title="A", file_name="b.txt", target=None):
    """Starts a task only via _start_ready, not tick: a full tick would merge the previous tasks too early."""
    t = repo.add_task(project.id, title, status="todo", target_branch=target)
    dispatcher._start_ready()
    t = repo.get_task(t.id)
    wt = git_repo / ".claude" / "worktrees" / f"orc-task-{t.id}"
    (wt / file_name).write_text("x\n")
    git_ops.git(["add", file_name], wt)
    git_ops.git(["commit", "-m", "work"], wt)
    repo.update_task(t.id, status="merging", merge_queued_at=f"2026-01-01T00:00:0{t.id}+00:00")
    return repo.get_task(t.id)


def test_merge_into_checked_out_clean_branch(repo, dispatcher, project, git_repo):
    t = _in_merging(repo, dispatcher, project, git_repo)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.DONE and t.done_at is not None
    assert (git_repo / "b.txt").exists()
    assert git_ops.git(["log", "-1", "--format=%s"], git_repo) == f"orc: merge task #{t.id}: A"


def test_merge_removes_working_copy_and_branch(repo, dispatcher, project, git_repo):
    # The branch is fully in the target after the merge, so the copy only takes disk space
    t = _in_merging(repo, dispatcher, project, git_repo)
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.DONE
    assert not Path(t.worktree_path).exists()
    assert t.branch not in git_ops.list_branches(git_repo)
    assert any("removed after the merge" in e["message"] for e in repo.list_events())


def test_merge_keeps_working_copy_when_autoclean_is_off(repo, dispatcher, project, git_repo):
    repo.set_setting("worktree_autoclean", "0")
    t = _in_merging(repo, dispatcher, project, git_repo)
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.DONE
    assert Path(t.worktree_path).exists()


def test_merge_keeps_copy_of_parent_with_unfinished_subtasks(repo, dispatcher, project, git_repo):
    # Waking the parent continues its session in this folder
    t = _in_merging(repo, dispatcher, project, git_repo)
    repo.add_task(project.id, "child", status="todo", parent_task_id=t.id)
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.DONE
    assert Path(t.worktree_path).exists()


def test_merge_keeps_copy_with_uncommitted_files(repo, dispatcher, project, git_repo):
    t = _in_merging(repo, dispatcher, project, git_repo)
    (Path(t.worktree_path) / "a.txt").write_text("unsaved\n")
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.DONE
    assert Path(t.worktree_path).exists()


def test_merge_autocommits_user_changes_first(repo, dispatcher, project, git_repo):
    t = _in_merging(repo, dispatcher, project, git_repo)
    (git_repo / "a.txt").write_text("user edit\n")
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.DONE
    log = git_ops.git(["log", "--format=%s"], git_repo).splitlines()
    assert log[1] == f"wip(orc): auto-commit before merge #{t.id}"
    assert (git_repo / "a.txt").read_text() == "user edit\n"


def test_merge_fifo_one_per_tick(repo, dispatcher, project, git_repo):
    repo.update_project(project.id, max_workers=3)
    t1 = _in_merging(repo, dispatcher, project, git_repo, "A", "b1.txt")
    t2 = _in_merging(repo, dispatcher, project, git_repo, "B", "b2.txt")
    dispatcher._process_merging()
    assert repo.get_task(t1.id).status == TaskStatus.DONE
    assert repo.get_task(t2.id).status == TaskStatus.MERGING
    dispatcher._process_merging()
    assert repo.get_task(t2.id).status == TaskStatus.DONE


def _conflicting_target(git_repo, text="main edit\n"):
    """A commit on the target branch that conflicts with the task that edited a.txt."""
    (git_repo / "a.txt").write_text(text)
    git_ops.git(["commit", "-am", "main"], git_repo)


def test_conflict_goes_to_the_session_and_queue_continues(repo, dispatcher, fake_cli, project, git_repo):
    # A conflict is work, not a dead end: the dispatcher hands it to the same session that wrote
    # the task code, while the merge queue moves on without stopping.
    repo.update_project(project.id, max_workers=3)
    fake_cli.stop_marks_stopped = True  # the daemon confirms the stop: wake kills the live process and wakes the same job
    t1 = _in_merging(repo, dispatcher, project, git_repo, "A", "a.txt")
    t2 = _in_merging(repo, dispatcher, project, git_repo, "B", "b2.txt")
    _conflicting_target(git_repo)
    dispatcher._process_merging()
    t1 = repo.get_task(t1.id)
    assert t1.status == TaskStatus.IN_PROGRESS and t1.blocker is None
    assert t1.conflict_retry_count == 1
    assert repo.get_task(t2.id).status == TaskStatus.DONE
    kind, cwd, session_id, prompt, _settings = fake_cli.calls[-1]
    assert kind == "resume_bg" and cwd == t1.worktree_path
    assert "git merge main" in prompt and "a.txt" in prompt


def test_conflict_resolution_drops_stale_report(repo, dispatcher, project, git_repo):
    # Otherwise _verify would let the task back into the merge on the old success, even if the conflict
    # stayed unresolved.
    t = _in_merging(repo, dispatcher, project, git_repo, "A", "a.txt")
    report = Path(t.worktree_path) / REPORT_REL_PATH
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text('{"status": "success", "summary": "previous pass"}')
    _conflicting_target(git_repo)
    dispatcher._process_merging()
    assert not report.exists()


def test_conflict_without_session_starts_a_fresh_one(repo, dispatcher, fake_cli, project, git_repo):
    # The session is gone (taken away by job cleanup), but the working copy is in place: there is still someone to reconcile
    # the branches, so we start a new session in the same worktree.
    t = _in_merging(repo, dispatcher, project, git_repo, "A", "a.txt")
    repo.update_task(t.id, session_id=None)
    _conflicting_target(git_repo)
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.blocker is None
    assert fake_cli.calls[-1][0] == "start_bg"
    assert "git merge main" in fake_cli.calls[-1][2]


def test_conflict_calls_the_human_after_retry_limit(repo, dispatcher, project, git_repo):
    t = _in_merging(repo, dispatcher, project, git_repo, "A", "a.txt")
    repo.update_task(t.id, conflict_retry_count=CONFLICT_RETRY_LIMIT)
    _conflicting_target(git_repo)
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.MERGING and t.blocker == Blocker.CONFLICT
    assert str(CONFLICT_RETRY_LIMIT) in t.blocker_detail
    assert t.detail_code == "conflict_unresolved"


def test_conflict_calls_the_human_when_autoresolve_is_off(repo, dispatcher, fake_cli, project, git_repo):
    repo.set_setting("conflict_autoresolve", "0")
    t = _in_merging(repo, dispatcher, project, git_repo, "A", "a.txt")
    _conflicting_target(git_repo)
    calls_before = len(fake_cli.calls)
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.MERGING and t.blocker == Blocker.CONFLICT
    assert t.conflict_retry_count == 0
    assert len(fake_cli.calls) == calls_before  # the session was not touched


def test_conflict_calls_the_human_when_worktree_is_gone(repo, dispatcher, project, git_repo):
    t = _in_merging(repo, dispatcher, project, git_repo, "A", "a.txt")
    git_ops.remove_worktree(git_repo, Path(t.worktree_path))
    _conflicting_target(git_repo)
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.MERGING and t.blocker == Blocker.CONFLICT


def test_conflict_born_after_the_dry_check_also_goes_to_the_session(
        repo, dispatcher, fake_cli, project, git_repo, monkeypatch):
    # The target branch moved between the dry check and the merge itself: git runs into
    # a real conflict. It is the same conflict, and the card must not become failed.
    fake_cli.stop_marks_stopped = True  # the daemon confirms the stop: wake kills the live process and wakes the same job
    t = _in_merging(repo, dispatcher, project, git_repo, "A", "a.txt")
    _conflicting_target(git_repo)
    real_has_conflict = git_ops.has_conflict
    seen = []

    def blind_first_check(repo_path, target, branch):
        seen.append(branch)
        if len(seen) == 1:
            return False  # the dry check "did not see" the conflict
        return real_has_conflict(repo_path, target, branch)

    monkeypatch.setattr(git_ops, "has_conflict", blind_first_check)
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.conflict_retry_count == 1
    assert not git_ops.is_merge_in_progress(git_repo)  # there is no abandoned merge in the owner's copy
    assert _markers_in(git_repo) == []
    assert fake_cli.calls[-1][0] == "resume_bg"


def test_successful_merge_resets_conflict_counter(repo, dispatcher, project, git_repo):
    t = _in_merging(repo, dispatcher, project, git_repo, "A", "b.txt")
    repo.update_task(t.id, conflict_retry_count=1)
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.DONE and t.conflict_retry_count == 0


def test_merge_into_branch_not_checked_out_uses_temp_worktree(repo, dispatcher, project, git_repo):
    git_ops.git(["branch", "dev"], git_repo)
    t = _in_merging(repo, dispatcher, project, git_repo, target="dev")
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.DONE
    assert "b.txt" in git_ops.git(["ls-tree", "--name-only", "dev"], git_repo)
    assert not (git_repo / ".claude" / "worktrees" / f"orc-merge-{t.id}").exists()
    assert git_ops.current_branch(git_repo) == "main"


def test_dirty_other_worktree_blocks(repo, dispatcher, project, git_repo):
    git_ops.git(["branch", "dev"], git_repo)
    other = git_repo.parent / "dev-wt"
    git_ops.add_temp_worktree(git_repo, other, "dev")
    (other / "a.txt").write_text("dirty\n")
    t = _in_merging(repo, dispatcher, project, git_repo, target="dev")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.MERGING and t.blocker == Blocker.DIRTY_COPY


def test_answer_stops_and_resumes(repo, dispatcher, fake_cli, project):
    # The session waits for an answer, so it makes no tool calls and the hook cannot reach it:
    # the only way is to stop and resume. Here the daemon confirms the stop immediately.
    fake_cli.stop_marks_stopped = True
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.set_state("job00001", "blocked", needs="Port?")
    dispatcher.tick()
    dispatcher.answer(t.id, "8080")
    t = repo.get_task(t.id)
    assert t.blocker is None and t.job_id == "job00002"
    assert fake_cli.calls[-2] == ("stop", "job00001")
    assert fake_cli.calls[-1][0] == "resume_bg" and fake_cli.calls[-1][3] == "8080"
    assert repo.list_comments(t.id)[0]["kind"] == "answer"
    assert repo.pending_messages(t.id) == []


def test_retry_cleans_worktree_and_requeues(repo, dispatcher, fake_cli, project, git_repo):
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    repo.update_task(t.id, status="failed", auto_resume_count=1)
    dispatcher.retry(t.id)
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.TODO and t.job_id is None and t.worktree_path is None and t.auto_resume_count == 0
    assert f"orc/task-{t.id}" not in git_ops.list_branches(git_repo)
    assert ("remove", "job00001") in fake_cli.calls
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS


def test_resume_failed_keeps_session(repo, dispatcher, fake_cli, project):
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    repo.update_task(t.id, status="failed")
    fake_cli.stop_marks_stopped = True  # the daemon confirms the stop: wake kills the live process and wakes the same job
    dispatcher.resume_failed(t.id)
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.job_id == "job00002"


# ---------- merge failures and cleanup ----------


def test_merge_error_marks_failed_and_continues_to_next(repo, dispatcher, project, git_repo, monkeypatch):
    # GitError on a real merge must not stop the whole queue:
    # the failed task has already left merging (became failed), there is nothing to retry here,
    # and the next one in the queue is merged as usual in the same tick.
    repo.update_project(project.id, max_workers=3)
    t1 = _in_merging(repo, dispatcher, project, git_repo, "A", "b1.txt")
    t2 = _in_merging(repo, dispatcher, project, git_repo, "B", "b2.txt")
    real_merge_no_ff = git_ops.merge_no_ff

    def flaky_merge_no_ff(cwd, branch, message):
        if branch == t1.branch:
            raise git_ops.GitError("simulated merge failure")
        return real_merge_no_ff(cwd, branch, message)

    monkeypatch.setattr(git_ops, "merge_no_ff", flaky_merge_no_ff)
    dispatcher._process_merging()
    assert repo.get_task(t1.id).status == TaskStatus.FAILED
    assert repo.get_task(t2.id).status == TaskStatus.DONE


def test_merge_non_git_error_is_isolated_per_task(repo, dispatcher, project, git_repo, monkeypatch):
    # Not only GitError but any failure inside _merge (for example, a bug in the code,
    # not in git) must not abort the whole merge step: the failure is isolated per task, as in
    # _process_verifying.
    repo.update_project(project.id, max_workers=3)
    t1 = _in_merging(repo, dispatcher, project, git_repo, "A", "b1.txt")
    t2 = _in_merging(repo, dispatcher, project, git_repo, "B", "b2.txt")
    real_has_conflict = git_ops.has_conflict

    def flaky_has_conflict(repo_path, target, branch):
        if branch == t1.branch:
            raise RuntimeError("not a git failure (for example, a bug in the orchestration)")
        return real_has_conflict(repo_path, target, branch)

    # We patch the symbol actually called from orc/dispatcher.py: there `from orc import git_ops`
    # and the call is git_ops.has_conflict(...), so a monkeypatch on the module itself works.
    monkeypatch.setattr(git_ops, "has_conflict", flaky_has_conflict)
    dispatcher._process_merging()
    assert repo.get_task(t1.id).status == TaskStatus.FAILED
    assert repo.get_task(t2.id).status == TaskStatus.DONE


def test_temp_worktree_removed_on_merge_failure(repo, dispatcher, project, git_repo, monkeypatch):
    # finally must remove the temporary worktree on the error path too, otherwise it
    # would jam the next merge of the same branch.
    git_ops.git(["branch", "dev"], git_repo)
    t = _in_merging(repo, dispatcher, project, git_repo, target="dev")
    real_merge_no_ff = git_ops.merge_no_ff

    def flaky_merge_no_ff(cwd, branch, message):
        if "orc-merge-" in str(cwd):
            raise git_ops.GitError("simulated merge failure in a temporary worktree")
        return real_merge_no_ff(cwd, branch, message)

    monkeypatch.setattr(git_ops, "merge_no_ff", flaky_merge_no_ff)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED
    tmp = git_repo / ".claude" / "worktrees" / f"orc-merge-{t.id}"
    assert not tmp.exists()
    assert f"orc-merge-{t.id}" not in git_ops.git(["worktree", "list"], git_repo)


def test_retry_raises_for_non_failed_status(repo, dispatcher, fake_cli, project):
    # answer() already had such a test, retry()/resume_failed() did not.
    t = repo.add_task(project.id, "A", status="todo")
    with pytest.raises(ValueError):
        dispatcher.retry(t.id)
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS
    with pytest.raises(ValueError):
        dispatcher.retry(t.id)


def test_resume_failed_raises_for_non_failed_status(repo, dispatcher, fake_cli, project):
    t = repo.add_task(project.id, "A", status="todo")
    with pytest.raises(ValueError):
        dispatcher.resume_failed(t.id)
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS
    with pytest.raises(ValueError):
        dispatcher.resume_failed(t.id)


def test_resume_failed_raises_without_session_id(repo, dispatcher, project):
    t = repo.add_task(project.id, "A", status="todo")
    repo.update_task(t.id, status="failed", session_id=None)
    with pytest.raises(ValueError):
        dispatcher.resume_failed(t.id)


def test_merge_pushes_target_when_push_enabled(repo, dispatcher, project, git_repo, tmp_path):
    # A successful push moves the target branch ref in the bare repository.
    bare = tmp_path / "origin.git"
    git_ops.git(["init", "--bare", str(bare)], tmp_path)
    git_ops.git(["remote", "add", "origin", str(bare)], git_repo)
    repo.update_project(project.id, push_enabled=1)
    t = _in_merging(repo, dispatcher, project, git_repo)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.DONE
    assert git_ops.git(["rev-parse", "main"], bare) == git_ops.git(["rev-parse", "main"], git_repo)


def test_merge_push_failure_keeps_done_and_warns(repo, dispatcher, project, git_repo, tmp_path):
    # If the push failed, the merge has already happened: the status is not rolled back, only a warn event is added.
    missing = tmp_path / "does-not-exist" / "origin.git"
    git_ops.git(["remote", "add", "origin", str(missing)], git_repo)
    repo.update_project(project.id, push_enabled=1)
    t = _in_merging(repo, dispatcher, project, git_repo)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.DONE
    events = repo.list_events()
    assert any(e["level"] == "warn" and "push" in e["message"] for e in events)


# ---------- conflicts and the owner's working copy ----------


def _markers_in(path):
    """Files with conflict markers in the working copy (excluding .git)."""
    found = []
    for p in path.rglob("*"):
        if not p.is_file() or ".git" in p.parts:
            continue
        try:
            if "<<<<<<<" in p.read_text():
                found.append(str(p))
        except (UnicodeDecodeError, OSError):
            continue
    return found


def test_conflict_after_autocommit_leaves_owner_copy_clean(repo, dispatcher, project, git_repo):
    # The dry check is done against the COMMITTED target, while the auto-commit of the owner's edits
    # moves exactly this ref, so the real merge after it conflicts. The owner's working copy
    # must stay without an unfinished merge and without markers.
    t = _in_merging(repo, dispatcher, project, git_repo, "A", file_name="a.txt")
    (git_repo / "a.txt").write_text("owner-wip\n")  # the owner's edit on the same line
    before = git_ops.git(["rev-list", "--count", "main"], git_repo)
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    # merging means the conflict is left to the human, in_progress means the task went off to resolve it itself
    assert t.status in (TaskStatus.MERGING, TaskStatus.IN_PROGRESS, TaskStatus.FAILED)
    assert t.status != TaskStatus.DONE
    assert not (git_repo / ".git" / "MERGE_HEAD").exists()
    assert _markers_in(git_repo) == []
    after = int(git_ops.git(["rev-list", "--count", "main"], git_repo))
    # exactly one new commit is allowed: the auto-commit of the owner's edits; there must be no merge commit
    assert after - int(before) <= 1
    assert f"orc: merge task #{t.id}" not in git_ops.git(["log", "--format=%s"], git_repo)


def test_conflicting_first_task_does_not_poison_second(repo, dispatcher, project, git_repo):
    # Cascade. An unfinished merge after the first task fails is seen by the second as a "dirty
    # copy", and `git commit -am` carries the broken merge into a commit with markers.
    repo.update_project(project.id, max_workers=3)
    t1 = _in_merging(repo, dispatcher, project, git_repo, "A", file_name="a.txt")
    t2 = _in_merging(repo, dispatcher, project, git_repo, "B", file_name="b2.txt")
    (git_repo / "a.txt").write_text("owner-wip\n")
    dispatcher._process_merging()
    dispatcher._process_merging()
    t1, t2 = repo.get_task(t1.id), repo.get_task(t2.id)
    assert t1.status != TaskStatus.DONE
    assert t2.status == TaskStatus.DONE
    assert _markers_in(git_repo) == []
    assert "<<<<<<<" not in git_ops.git(["show", "main:a.txt"], git_repo)
    assert not (git_repo / ".git" / "MERGE_HEAD").exists()


def test_merge_in_progress_in_owner_copy_blocks_with_dirty_copy(repo, dispatcher, project, git_repo):
    # A merge is already in progress in the owner's copy: committing on top is not allowed under any conditions.
    git_ops.git(["checkout", "-b", "side"], git_repo)
    (git_repo / "a.txt").write_text("side\n")
    git_ops.git(["commit", "-am", "side"], git_repo)
    git_ops.git(["checkout", "main"], git_repo)
    (git_repo / "a.txt").write_text("main\n")
    git_ops.git(["commit", "-am", "main"], git_repo)
    t = _in_merging(repo, dispatcher, project, git_repo, "A", file_name="b3.txt")
    subprocess.run(["git", "merge", "side"], cwd=git_repo, capture_output=True, text=True)
    assert (git_repo / ".git" / "MERGE_HEAD").exists()  # the owner's merge is left unfinished
    before = git_ops.git(["rev-list", "--count", "main"], git_repo)
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.blocker == Blocker.DIRTY_COPY
    assert t.status == TaskStatus.MERGING
    assert git_ops.git(["rev-list", "--count", "main"], git_repo) == before  # not a single new commit


def test_merge_failure_aborts_merge_in_owner_copy(repo, dispatcher, project, git_repo, monkeypatch):
    # Any merge_no_ff failure must end with `git merge --abort`, not with an abandoned
    # owner's working copy in the state of an unfinished merge.
    t = _in_merging(repo, dispatcher, project, git_repo, "A", file_name="a.txt")
    (git_repo / "a.txt").write_text("owner\n")
    git_ops.git(["commit", "-am", "owner"], git_repo)
    real_has_conflict = git_ops.has_conflict
    monkeypatch.setattr(git_ops, "has_conflict", lambda *a, **kw: False)  # hide the conflict from the check
    dispatcher._process_merging()
    assert real_has_conflict(git_repo, "main", t.branch) is True
    assert repo.get_task(t.id).status == TaskStatus.FAILED
    assert not (git_repo / ".git" / "MERGE_HEAD").exists()
    assert _markers_in(git_repo) == []


def test_dirty_copy_badge_is_rechecked_and_cleared(repo, dispatcher, project, git_repo):
    # dirty_copy is a transient state, the dispatcher must re-check the other worktree
    # and clear the badge once the owner has committed their work.
    git_ops.git(["branch", "dev"], git_repo)
    other = git_repo.parent / "dev-wt"
    git_ops.add_temp_worktree(git_repo, other, "dev")
    (other / "a.txt").write_text("dirty\n")
    t = _in_merging(repo, dispatcher, project, git_repo, target="dev")
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.MERGING and t.blocker == Blocker.DIRTY_COPY
    git_ops.git(["commit", "-am", "owner work"], other)  # the owner committed
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.blocker is None
    assert t.status == TaskStatus.DONE


def test_merge_failure_without_the_branch_says_the_branch_is_gone(repo, dispatcher, project, git_repo, monkeypatch):
    t = _in_merging(repo, dispatcher, project, git_repo, "A", "b1.txt")
    git_ops.git(["worktree", "remove", "--force", t.worktree_path], git_repo)
    git_ops.git(["branch", "-D", t.branch], git_repo)
    monkeypatch.setattr(git_ops, "has_conflict", lambda *a, **kw: (_ for _ in ()).throw(git_ops.GitError("no such branch")))
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and t.detail_code == "branch_gone"


def test_other_merge_failure_keeps_its_text_without_a_code(repo, dispatcher, project, git_repo, monkeypatch):
    t = _in_merging(repo, dispatcher, project, git_repo, "A", "b1.txt")
    monkeypatch.setattr(git_ops, "merge_no_ff", lambda *a, **kw: (_ for _ in ()).throw(git_ops.GitError("simulated")))
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "simulated" in t.blocker_detail and t.detail_code is None
