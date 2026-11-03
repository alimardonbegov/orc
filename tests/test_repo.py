import pytest

from orc.models import Priority, Task, TaskStatus


def test_add_and_get_project(repo, tmp_path):
    p = repo.add_project("demo", str(tmp_path), verify_cmd="pytest")
    assert p.id == 1
    assert p.max_workers == 2
    assert p.default_permission_mode == "auto"
    assert repo.get_project(1).verify_cmd == "pytest"
    assert [x.name for x in repo.list_projects()] == ["demo"]


def test_update_project_rejects_unknown_column(repo, tmp_path):
    p = repo.add_project("demo", str(tmp_path))
    with pytest.raises(ValueError):
        repo.update_project(p.id, nope=1)


def test_add_task_defaults(repo, tmp_path):
    p = repo.add_project("demo", str(tmp_path))
    t = repo.add_task(p.id, "Do X", "description")
    assert isinstance(t, Task)
    assert t.status == TaskStatus.BACKLOG
    assert t.priority == Priority.NORMAL
    assert t.blocker is None
    assert t.created_at == t.updated_at


def test_update_task_bumps_updated_at(repo, tmp_path, monkeypatch):
    p = repo.add_project("demo", str(tmp_path))
    t = repo.add_task(p.id, "A")
    monkeypatch.setattr("orc.repo.now_iso", lambda: "2030-01-01T00:00:00+00:00")
    t2 = repo.update_task(t.id, status="todo", blocker=None)
    assert t2.status == "todo"
    assert t2.updated_at == "2030-01-01T00:00:00+00:00"


def test_list_tasks_filters(repo, tmp_path):
    p = repo.add_project("demo", str(tmp_path))
    a = repo.add_task(p.id, "A")
    b = repo.add_task(p.id, "B")
    repo.update_task(b.id, status="todo")
    assert [t.id for t in repo.list_tasks(status="todo")] == [b.id]
    assert [t.id for t in repo.list_tasks(project_id=p.id)] == [a.id, b.id]


def test_deps(repo, tmp_path):
    p = repo.add_project("demo", str(tmp_path))
    a = repo.add_task(p.id, "A")
    b = repo.add_task(p.id, "B", depends_on=[a.id])
    assert repo.deps_of(b.id) == [a.id]
    assert repo.all_deps() == {b.id: [a.id]}
    repo.set_deps(b.id, [])
    assert repo.deps_of(b.id) == []


def test_comments_and_events(repo, tmp_path):
    p = repo.add_project("demo", str(tmp_path))
    t = repo.add_task(p.id, "A")
    repo.add_comment(t.id, "user", "answer", "yes")
    assert repo.list_comments(t.id)[0]["body"] == "yes"
    repo.add_event("hello", level="warn", task_id=t.id)
    assert len(repo.list_events(unread_only=True)) == 1
    repo.mark_events_read()
    assert repo.list_events(unread_only=True) == []


def test_events_carry_project_and_task(repo, tmp_path):
    """The feed is shared across all projects: a row must itself say where it is and what it is about."""
    p = repo.add_project("Orchestrator API", str(tmp_path))
    t = repo.add_task(p.id, "Limits on the page")
    repo.add_event(f"#{t.id} awaits an answer", level="warn", task_id=t.id, project_id=p.id)
    # A dispatcher event itself: it has no project, but it must not drop out of the feed
    repo.add_event("dispatcher step failed", level="error")
    # An old event without project_id: the project name is taken from the task
    repo.add_event("#%d started" % t.id, task_id=t.id)

    by_message = {e["message"]: e for e in repo.list_events()}

    task_event = by_message[f"#{t.id} awaits an answer"]
    assert task_event["project_id"] == p.id
    assert task_event["project_name"] == "Orchestrator API"
    assert task_event["task_title"] == "Limits on the page"
    assert task_event["task_status"] == "backlog"

    orphan = by_message["dispatcher step failed"]
    assert orphan["project_id"] is None
    assert orphan["project_name"] is None
    assert orphan["task_title"] is None

    legacy = by_message[f"#{t.id} started"]
    assert legacy["project_id"] == p.id
    assert legacy["project_name"] == "Orchestrator API"


def test_events_survive_deleted_task(repo, tmp_path):
    """The task was deleted: the event stays in the feed, but now without a title and without a link."""
    p = repo.add_project("demo", str(tmp_path))
    t = repo.add_task(p.id, "A")
    repo.add_event(f"#{t.id} failed", level="error", task_id=t.id, project_id=p.id)
    repo.delete_task(t.id)

    event = repo.list_events()[0]
    assert event["task_id"] is None
    assert event["task_title"] is None
    # project_id is stored in the event itself, so "where is this" is known even after the task is deleted
    assert event["project_name"] == "demo"


def test_settings(repo):
    assert repo.get_setting("x") is None
    assert repo.get_setting("x", "d") == "d"
    repo.set_setting("x", "1")
    repo.set_setting("x", "2")
    assert repo.get_setting("x") == "2"
    repo.delete_setting("x")
    assert repo.get_setting("x") is None


def test_task_sessions_journal(repo, tmp_path):
    p = repo.add_project("demo", str(tmp_path))
    t = repo.add_task(p.id, "A", job_id="job1")
    assert repo.tasks_without_sessions() == [t]
    row = repo.add_task_session(t.id, "job1", "sess-1", None)
    assert row["task_id"] == t.id and row["transcript_path"] is None
    # Repeating the same pair is neither an error nor a duplicate
    repo.add_task_session(t.id, "job1", "sess-1", "/x/sess-1.jsonl")
    repo.add_task_session(t.id, "job2", "sess-2", "/x/sess-2.jsonl")
    sessions = repo.list_task_sessions(t.id)
    assert [(s["job_id"], s["transcript_path"]) for s in sessions] == [("job1", None), ("job2", "/x/sess-2.jsonl")]
    repo.update_task_session(sessions[0]["id"], transcript_path="/x/sess-1.jsonl")
    assert repo.list_task_sessions(t.id)[0]["transcript_path"] == "/x/sess-1.jsonl"
    assert repo.tasks_without_sessions() == []
    assert repo.get_task(t.id).usage_json is None
    repo.update_task(t.id, usage_json='{"total_tokens": 1}')
    assert repo.get_task(t.id).usage_json == '{"total_tokens": 1}'
    # Deleting a task takes the journal with it (ON DELETE CASCADE)
    repo.delete_task(t.id)
    assert repo.list_task_sessions(t.id) == []
