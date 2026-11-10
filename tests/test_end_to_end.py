"""End-to-end runs: a task goes from todo to done only through repeated tick() calls, without setting
statuses by hand. The absence of such a test is what let three bugs slip through:
all three live in the seams between tick steps."""
import json
from pathlib import Path

from orc import git_ops
from orc.models import TaskStatus
from orc.handoff import REPORT_REL_PATH


def _worker_commits(task, file_name="feature.txt", text="implemented\n"):
    """What Claude does in its worktree: an edit plus a commit."""
    wt = Path(task.worktree_path)
    (wt / file_name).write_text(text)
    git_ops.git(["add", file_name], wt)
    git_ops.git(["commit", "-m", f"feat: {file_name}"], wt)


def _worker_reports(task, status="success", summary="done"):
    p = Path(task.worktree_path) / REPORT_REL_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"status": status, "summary": summary}, ensure_ascii=False))


def _run(dispatcher, repo, task_id, worker, max_ticks=10):
    """Spin ticks, with the "worker" making itself felt between them. Returns the status history."""
    history = []
    for _ in range(max_ticks):
        dispatcher.tick()
        dispatcher.verify_pool.wait(10)
        task = repo.get_task(task_id)
        history.append(task.status)
        if task.status in (TaskStatus.DONE, TaskStatus.FAILED):
            break
        worker(task)
    return history


def test_task_goes_from_todo_to_done_through_repeated_ticks(repo, dispatcher, fake_cli, project, git_repo):
    repo.update_project(project.id, verify_cmd="test -f feature.txt")
    t = repo.add_task(project.id, "End-to-end", "description", status="todo")

    def worker(task):
        if task.status == TaskStatus.IN_PROGRESS and fake_cli.read_state(task.job_id).state == "working":
            _worker_commits(task)
            _worker_reports(task)
            fake_cli.set_state(task.job_id, "done")

    history = _run(dispatcher, repo, t.id, worker)
    assert TaskStatus.IN_PROGRESS in history
    assert history[-1] == TaskStatus.DONE

    t = repo.get_task(t.id)
    assert t.done_at is not None and t.blocker is None
    assert json.loads(t.report_json)["summary"] == "done"
    # The work really is on the target branch, and it is the orchestrator's merge commit
    assert (git_repo / "feature.txt").read_text() == "implemented\n"
    assert git_ops.git(["log", "-1", "--format=%s"], git_repo) == f"orc: merge task #{t.id}: End-to-end"
    assert git_ops.current_branch(git_repo) == "main"
    # The owner's working copy is clean: no unfinished merge, no markers
    assert not (git_repo / ".git" / "MERGE_HEAD").exists()
    assert "<<<<<<<" not in (git_repo / "feature.txt").read_text()
    assert [e["level"] for e in repo.list_events() if e["level"] == "error"] == []


def test_task_recovers_from_missing_report_and_reaches_done(repo, dispatcher, fake_cli, project, git_repo):
    # The same path, but the worker's first attempt forgets report.json: auto-resume, second attempt, done.
    t = repo.add_task(project.id, "With resume", status="todo")
    seen_resume = []

    def worker(task):
        if task.status != TaskStatus.IN_PROGRESS:
            return
        state = fake_cli.read_state(task.job_id)
        if state is None or state.state != "working":
            return
        if not seen_resume:  # first attempt: there is a commit, no report
            _worker_commits(task)
            seen_resume.append(task.job_id)
            fake_cli.set_state(task.job_id, "done")
            return
        _worker_reports(task)  # after the resume the report is finally written
        fake_cli.set_state(task.job_id, "done")

    history = _run(dispatcher, repo, t.id, worker)
    assert history[-1] == TaskStatus.DONE
    t = repo.get_task(t.id)
    assert t.auto_resume_count == 1
    assert any(c[0] == "resume_bg" for c in fake_cli.calls)
    assert (git_repo / "feature.txt").exists()


def test_two_tasks_run_in_parallel_and_both_merge(repo, dispatcher, fake_cli, project, git_repo):
    # Two workers in different worktrees and a merge queue: we check that the second merge arrives
    # on following ticks, and the target branch receives both pieces of work.
    repo.update_project(project.id, max_workers=2)
    a = repo.add_task(project.id, "A", status="todo")
    b = repo.add_task(project.id, "B", status="todo")
    files = {a.id: "a-feature.txt", b.id: "b-feature.txt"}
    for _ in range(12):
        dispatcher.tick()
        for task in repo.list_tasks():
            if task.status == TaskStatus.IN_PROGRESS:
                state = fake_cli.read_state(task.job_id)
                if state is not None and state.state == "working":
                    _worker_commits(task, files[task.id])
                    _worker_reports(task)
                    fake_cli.set_state(task.job_id, "done")
        if all(t.status == TaskStatus.DONE for t in repo.list_tasks()):
            break
    assert [t.status for t in repo.list_tasks()] == [TaskStatus.DONE, TaskStatus.DONE]
    assert (git_repo / "a-feature.txt").exists() and (git_repo / "b-feature.txt").exists()
    assert not (git_repo / ".git" / "MERGE_HEAD").exists()


def test_owner_wip_conflict_does_not_break_the_board(repo, dispatcher, fake_cli, project, git_repo):
    # The same end-to-end path, but the owner has an uncommitted edit on the target branch,
    # conflicting with the first task. With full ticks: the board must not break,
    # the second task must make it, and the owner's working copy must stay clean.
    repo.update_project(project.id, max_workers=2)
    # Conflict auto-resolution is off: what is checked here is the behaviour "did not merge:
    # the board is intact anyway". What a successful resolution looks like is checked by the test below.
    repo.set_setting("conflict_autoresolve", "0")
    a = repo.add_task(project.id, "Conflicting", status="todo")
    b = repo.add_task(project.id, "Peaceful", status="todo")
    (git_repo / "a.txt").write_text("owner-wip\n")  # the owner's edit, not committed
    work = {a.id: ("a.txt", "worker\n"), b.id: ("peaceful.txt", "peacefully\n")}
    for _ in range(12):
        dispatcher.tick()
        for task in repo.list_tasks():
            if task.status == TaskStatus.IN_PROGRESS:
                state = fake_cli.read_state(task.job_id)
                if state is not None and state.state == "working":
                    _worker_commits(task, *work[task.id])
                    _worker_reports(task)
                    fake_cli.set_state(task.job_id, "done")
        if repo.get_task(b.id).status == TaskStatus.DONE:
            break
    assert repo.get_task(b.id).status == TaskStatus.DONE          # the peaceful task made it
    assert repo.get_task(a.id).status != TaskStatus.DONE          # the conflicting one did not
    assert not (git_repo / ".git" / "MERGE_HEAD").exists()        # the merge is not abandoned halfway
    assert "<<<<<<<" not in (git_repo / "a.txt").read_text()      # no markers in the copy
    assert "<<<<<<<" not in git_ops.git(["show", "main:a.txt"], git_repo)  # and in the owner's branch
    assert (git_repo / "peaceful.txt").exists()


def _resolves_conflict_like_claude(task, text):
    """What the session does on the conflict resolution prompt: merge the target branch in and reconcile the edits."""
    wt = Path(task.worktree_path)
    try:
        git_ops.git(["merge", task.target_branch], wt)
    except git_ops.GitError:
        pass  # the conflict is the expected outcome, we resolve it below
    if git_ops.is_merge_in_progress(wt):
        (wt / "a.txt").write_text(text)
        git_ops.git(["add", "a.txt"], wt)
        git_ops.git(["commit", "--no-edit"], wt)


def test_conflicting_task_lands_after_its_session_resolves_the_conflict(
        repo, dispatcher, fake_cli, project, git_repo):
    """Two tasks edit one file. The first is merged, the second conflicts and gets through on its own.

    Exactly the scenario this was built for: while the agent was working, someone else's task
    landed on the target branch and touched the same files. The human is never called in.
    """
    repo.update_project(project.id, max_workers=2)
    first = repo.add_task(project.id, "First", status="todo")
    second = repo.add_task(project.id, "Second", status="todo")
    text = {first.id: "first\n", second.id: "second\n"}

    for _ in range(20):
        dispatcher.tick()
        for task in repo.list_tasks():
            if task.status != TaskStatus.IN_PROGRESS:
                continue
            state = fake_cli.read_state(task.job_id)
            if state is None or state.state != "working":
                continue
            if task.conflict_retry_count:
                _resolves_conflict_like_claude(task, "both edits merged\n")
            else:
                _worker_commits(task, "a.txt", text[task.id])
            _worker_reports(task)
            fake_cli.set_state(task.job_id, "done")
        if all(t.status == TaskStatus.DONE for t in repo.list_tasks()):
            break

    first, second = repo.get_task(first.id), repo.get_task(second.id)
    assert (first.status, second.status) == (TaskStatus.DONE, TaskStatus.DONE)
    # The conflict went to exactly one task, the one merged second, and its own session
    # resolved it. The counter is reset after the successful merge.
    resolutions = [c for c in fake_cli.calls if c[0] == "resume_bg" and "git merge main" in c[3]]
    assert len(resolutions) == 1
    assert sorted([first.conflict_retry_count, second.conflict_retry_count]) == [0, 0]
    assert [t.blocker for t in (first, second)] == [None, None]
    assert (git_repo / "a.txt").read_text() == "both edits merged\n"
    assert "<<<<<<<" not in git_ops.git(["show", "main:a.txt"], git_repo)
    assert not (git_repo / ".git" / "MERGE_HEAD").exists()


def test_routine_runs_end_to_end_each_run_is_its_own_card(repo, dispatcher, fake_cli, project, git_repo):
    """Routine: run #1 goes through the common pipeline to done with its own report, the next slot
    creates run #2 as a separate card, and #1 goes to the archive with the report in place."""
    from datetime import datetime, timedelta, timezone

    now = {"at": datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)}
    dispatcher.now = lambda: now["at"]
    routine = repo.add_routine(project.id, "Hourly report", description="do A, B, C",
                               schedule_kind="interval", interval_minutes=60, next_run_at=now["at"].isoformat())

    def worker(task):
        # A routine without code edits: only a report; merging an empty branch also brings it to done
        if task.status == TaskStatus.IN_PROGRESS and fake_cli.read_state(task.job_id).state == "working":
            _worker_reports(task, summary=f"run {task.routine_run}")
            fake_cli.set_state(task.job_id, "done")

    dispatcher.tick()
    first = repo.routine_runs(routine.id)[0]
    history = _run(dispatcher, repo, first.id, worker)
    assert history[-1] == TaskStatus.DONE
    assert json.loads(repo.get_task(first.id).report_json)["summary"] == "run 1"

    now["at"] += timedelta(hours=1)
    dispatcher.tick()
    runs = sorted(repo.routine_runs(routine.id), key=lambda t: t.id)
    assert [t.routine_run for t in runs] == [1, 2]
    second = runs[1]
    assert second.status == TaskStatus.IN_PROGRESS and second.worktree_path != first.worktree_path
    history = _run(dispatcher, repo, second.id, worker)
    assert history[-1] == TaskStatus.DONE
    assert json.loads(repo.get_task(second.id).report_json)["summary"] == "run 2"
    assert repo.get_task(first.id).archived_at is not None
    assert repo.get_routine(routine.id).run_count == 2
    assert [e["level"] for e in repo.list_events() if e["level"] == "error"] == []
