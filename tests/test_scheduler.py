from orc.models import Task
from orc.scheduler import ready_tasks


def mk(id, project_id=1, priority="normal", created_at="2026-01-01T00:00:00+00:00", status="todo"):
    # Fill in only the significant fields, the rest None/0
    return Task(
        id=id, project_id=project_id, title=f"t{id}", description="", status=status, priority=priority,
        blocker=None, blocker_detail=None, target_branch=None, model=None, effort=None, permission_mode=None,
        verify_cmd=None, requires_review=0, worktree_path=None, branch=None, job_id=None, session_id=None,
        auto_resume_count=0, state_miss_count=0, quota_retry_count=0, conflict_retry_count=0,
        resume_with=None, outbox_state=None,
        merge_queued_at=None, retry_after=None, report_json=None,
        created_at=created_at, updated_at=created_at, done_at=None, archived_at=None,
    )


def test_skips_tasks_with_unfinished_deps():
    todo = [mk(2)]
    status = {1: "in_progress", 2: "todo"}
    out = ready_tasks(todo, status, {2: [1]}, {}, {1: 2}, 3)
    assert out == []


def test_dep_done_unblocks():
    todo = [mk(2)]
    out = ready_tasks(todo, {1: "done", 2: "todo"}, {2: [1]}, {}, {1: 2}, 3)
    assert [t.id for t in out] == [2]


def test_priority_then_created_at():
    todo = [mk(1, priority="low", created_at="2026-01-01T00:00:00+00:00"),
            mk(2, priority="high", created_at="2026-01-03T00:00:00+00:00"),
            mk(3, priority="high", created_at="2026-01-02T00:00:00+00:00")]
    out = ready_tasks(todo, {1: "todo", 2: "todo", 3: "todo"}, {}, {}, {1: 5}, 5)
    assert [t.id for t in out] == [3, 2, 1]


def test_respects_project_and_global_limits():
    todo = [mk(1, project_id=1), mk(2, project_id=1), mk(3, project_id=2), mk(4, project_id=2)]
    status = {i: "todo" for i in range(1, 5)}
    running = {1: 1}  # project 1 already has one worker
    out = ready_tasks(todo, status, {}, running, {1: 2, 2: 2}, 3)
    # 2 slots are free globally: one for project 1 (limit 2, 1 taken), one for project 2
    assert [t.id for t in out] == [1, 3]
    assert running == {1: 1}  # the input dict is unchanged


def test_cross_project_dep_allowed():
    todo = [mk(5, project_id=2)]
    out = ready_tasks(todo, {4: "done", 5: "todo"}, {5: [4]}, {}, {2: 1}, 3)
    assert [t.id for t in out] == [5]


def test_missing_dep_id_does_not_block():
    # The dependency (id 999) is not in status_by_id: its card was archived or deleted.
    # Waiting for done from a nonexistent task is pointless: the dependent one moves on.
    todo = [mk(2)]
    out = ready_tasks(todo, {2: "todo"}, {2: [999]}, {}, {1: 2}, 3)
    assert [t.id for t in out] == [2]


def test_project_not_in_limits_uses_default():
    # Project 2 is missing from limit_by_project, the default limit = 1 is used
    todo = [mk(1, project_id=2), mk(2, project_id=2)]
    status = {1: "todo", 2: "todo"}
    out = ready_tasks(todo, status, {}, {}, {1: 2}, 3)  # project_id=2 is not in limit_by_project
    # Exactly one task from project 2 will pass (default limit = 1)
    assert [t.id for t in out] == [1]
