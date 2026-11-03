from datetime import datetime, timedelta, timezone

import pytest

from orc.models import TaskStatus

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat()


@pytest.fixture
def clock(dispatcher):
    """Dispatcher clock under the test's control: state["now"] can be moved between ticks."""
    state = {"now": NOW}
    dispatcher.now = lambda: state["now"]
    return state


def test_waiting_task_is_skipped_and_neighbor_starts(repo, dispatcher, fake_cli, project, clock):
    waiting = repo.add_task(project.id, "At night", "x", status="todo", start_after=iso(NOW + timedelta(hours=1)))
    other = repo.add_task(project.id, "Now", "x", status="todo")
    dispatcher.tick()
    assert repo.get_task(waiting.id).status == TaskStatus.TODO
    assert repo.get_task(other.id).status == TaskStatus.IN_PROGRESS
    assert len([c for c in fake_cli.calls if c[0] == "start_bg"]) == 1


def test_scheduled_task_starts_when_time_comes_and_schedule_cleared(repo, dispatcher, fake_cli, project, clock):
    t = repo.add_task(project.id, "A", "x", status="todo",
                      start_after=iso(NOW + timedelta(hours=1)), start_before=iso(NOW + timedelta(hours=3)))
    dispatcher.tick()
    assert fake_cli.calls == []
    clock["now"] = NOW + timedelta(hours=1, minutes=1)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS
    # The schedule is one-shot: otherwise a retry after a failure would hit a window long past
    assert t.start_after is None and t.start_before is None
    assert any("on schedule" in e["message"] for e in repo.list_events())


def test_missed_window_returns_to_backlog_even_when_paused(repo, dispatcher, fake_cli, project, clock):
    repo.set_setting("dispatcher_paused", "1")
    t = repo.add_task(project.id, "A", "x", status="todo",
                      start_after=iso(NOW - timedelta(hours=2)), start_before=iso(NOW - timedelta(minutes=1)))
    repo.update_task(t.id, position=7)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.BACKLOG
    assert t.start_after is None and t.start_before is None
    # A manual order from todo is meaningless in the backlog: the card takes its natural place
    assert t.position is None
    comments = repo.list_comments(t.id)
    assert comments and comments[-1]["author"] == "orc" and "The start window" in comments[-1]["body"]
    assert any(e["level"] == "warn" and "start window" in e["message"] for e in repo.list_events())
    assert fake_cli.calls == []


def test_expired_window_in_backlog_is_left_alone(repo, dispatcher, project, clock):
    t = repo.add_task(project.id, "A", "x", start_after=iso(NOW - timedelta(hours=2)),
                      start_before=iso(NOW - timedelta(hours=1)))  # backlog
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.BACKLOG and t.start_before is not None
    assert repo.list_comments(t.id) == []


def test_garbage_schedule_does_not_block_start(repo, dispatcher, project, clock):
    t = repo.add_task(project.id, "A", "x", status="todo", start_after="garbage", start_before="also")
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS


def test_rework_path_clears_schedule(repo, dispatcher, fake_cli, project, clock):
    fake_cli.stop_marks_stopped = True  # the daemon confirms the stop: wake kills the live process and wakes the same job
    t = repo.add_task(project.id, "A", "x", status="todo")
    dispatcher.tick()
    repo.update_task(t.id, status=TaskStatus.TODO, resume_with="rework it", start_after=iso(NOW - timedelta(minutes=1)))
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.resume_with is None and t.start_after is None


def test_resume_failed_clears_schedule(repo, dispatcher, fake_cli, project, clock):
    fake_cli.stop_marks_stopped = True  # the daemon confirms the stop: wake kills the live process and wakes the same job
    t = repo.add_task(project.id, "A", "x", status="todo")
    dispatcher.tick()
    repo.update_task(t.id, status="failed", start_after=iso(NOW + timedelta(hours=1)),
                     start_before=iso(NOW + timedelta(hours=3)))
    dispatcher.resume_failed(t.id)
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS
    # The task is in progress again: the start window has lost its meaning and must not wait for the next retry
    assert t.start_after is None and t.start_before is None
