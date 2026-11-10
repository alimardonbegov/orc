"""Recurring tasks in the dispatcher: scheduled runs, overlap, ceiling, archiving of past ones."""
from datetime import datetime, timedelta, timezone

import pytest

from orc.models import TaskStatus

NOW = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat()


@pytest.fixture
def clock(dispatcher):
    state = {"now": NOW}
    dispatcher.now = lambda: state["now"]
    return state


def _routine(repo, project, **fields):
    defaults = dict(description="do A, B, C", schedule_kind="interval", interval_minutes=60,
                    next_run_at=iso(NOW))
    return repo.add_routine(project.id, "Report", **{**defaults, **fields})


def _runs(repo, routine_id):
    return sorted(repo.routine_runs(routine_id), key=lambda t: t.id)


def test_due_routine_spawns_run_and_it_starts_same_tick(repo, dispatcher, fake_cli, project, clock):
    r = _routine(repo, project)
    dispatcher.tick()
    runs = _runs(repo, r.id)
    assert len(runs) == 1
    run = runs[0]
    assert run.title == "Report · #1" and run.description == "do A, B, C"
    assert run.routine_run == 1
    # The same tick: the run was created before _start_ready and immediately went to work
    assert run.status == TaskStatus.IN_PROGRESS
    r = repo.get_routine(r.id)
    assert r.run_count == 1 and r.last_run_at == iso(NOW)
    assert r.next_run_at == iso(NOW + timedelta(hours=1))
    assert any("run #1 created on schedule" in e["message"] for e in repo.list_events())


def test_not_due_and_disabled_routines_do_nothing(repo, dispatcher, fake_cli, project, clock):
    _routine(repo, project, next_run_at=iso(NOW + timedelta(minutes=1)))
    _routine(repo, project, enabled=0)
    dispatcher.tick()
    assert repo.list_tasks() == []
    assert fake_cli.calls == []


def test_overlap_skips_slot_while_previous_run_is_active(repo, dispatcher, fake_cli, project, clock):
    r = _routine(repo, project)
    dispatcher.tick()
    first = _runs(repo, r.id)[0]
    assert first.status == TaskStatus.IN_PROGRESS
    clock["now"] = NOW + timedelta(hours=1)
    dispatcher.tick()
    assert len(_runs(repo, r.id)) == 1  # a second one was not created in parallel
    r = repo.get_routine(r.id)
    assert r.skipped_count == 1
    assert r.next_run_at == iso(NOW + timedelta(hours=2))
    assert any(e["level"] == "warn" and "slot skipped" in e["message"] for e in repo.list_events())


def test_failed_run_does_not_block_next_and_finished_runs_are_archived(repo, dispatcher, project, clock):
    r = _routine(repo, project)
    dispatcher.tick()
    first = _runs(repo, r.id)[0]
    repo.update_task(first.id, status=TaskStatus.FAILED)
    clock["now"] = NOW + timedelta(hours=1)
    dispatcher.tick()
    runs = _runs(repo, r.id)
    assert [t.routine_run for t in runs] == [1, 2]
    # The previous result was removed from the board but stays in the routine's history
    assert runs[0].archived_at is not None
    assert runs[1].archived_at is None


def test_archive_runs_off_keeps_old_runs_on_board(repo, dispatcher, project, clock):
    r = _routine(repo, project, archive_runs=0)
    dispatcher.tick()
    first = _runs(repo, r.id)[0]
    repo.update_task(first.id, status=TaskStatus.DONE)
    clock["now"] = NOW + timedelta(hours=1)
    dispatcher.tick()
    assert all(t.archived_at is None for t in _runs(repo, r.id))


def test_missed_slots_are_not_backfilled(repo, dispatcher, project, clock):
    # The server was down for five hours: one run, the next one counts from the current moment
    r = _routine(repo, project, next_run_at=iso(NOW - timedelta(hours=5)))
    dispatcher.tick()
    assert len(_runs(repo, r.id)) == 1
    assert repo.get_routine(r.id).next_run_at == iso(NOW + timedelta(hours=1))


def test_max_runs_stops_routine(repo, dispatcher, project, clock):
    r = _routine(repo, project, max_runs=1)
    dispatcher.tick()
    r = repo.get_routine(r.id)
    assert r.run_count == 1 and not r.enabled and r.next_run_at is None
    assert any("routine stopped" in e["message"] for e in repo.list_events())


def test_archived_project_gets_no_runs_but_schedule_advances(repo, dispatcher, project, clock):
    r = _routine(repo, project)
    repo.update_project(project.id, archived_at=iso(NOW))
    dispatcher.tick()
    assert repo.routine_runs(r.id) == []
    assert repo.get_routine(r.id).next_run_at == iso(NOW + timedelta(hours=1))


def test_paused_dispatcher_still_spawns_but_only_one(repo, dispatcher, fake_cli, project, clock):
    repo.set_setting("dispatcher_paused", "1")
    r = _routine(repo, project)
    dispatcher.tick()
    clock["now"] = NOW + timedelta(hours=1)
    dispatcher.tick()
    runs = _runs(repo, r.id)
    assert len(runs) == 1 and runs[0].status == TaskStatus.TODO
    assert fake_cli.calls == []


def test_broken_routine_is_paused_and_others_still_run(repo, dispatcher, project, clock):
    broken = _routine(repo, project, schedule_kind="cron", cron="not cron", interval_minutes=None)
    ok = _routine(repo, project)
    dispatcher.tick()
    assert not repo.get_routine(broken.id).enabled
    assert len(repo.routine_runs(ok.id)) == 1
    assert any(e["level"] == "error" and "was paused" in e["message"] for e in repo.list_events())


def test_run_now_does_not_shift_schedule_and_respects_overlap(repo, dispatcher, project, clock):
    r = _routine(repo, project, next_run_at=iso(NOW + timedelta(hours=3)))
    task = dispatcher.run_routine(r.id)
    assert task.status == TaskStatus.TODO and task.routine_run == 1
    assert repo.get_routine(r.id).next_run_at == iso(NOW + timedelta(hours=3))
    with pytest.raises(ValueError, match="is not finished yet"):
        dispatcher.run_routine(r.id)


def test_delete_routine_keeps_runs_as_plain_tasks(repo, dispatcher, project, clock):
    r = _routine(repo, project)
    dispatcher.tick()
    run = _runs(repo, r.id)[0]
    repo.delete_routine(r.id)
    assert repo.get_routine(r.id) is None
    kept = repo.get_task(run.id)
    assert kept is not None and kept.routine_id is None and kept.routine_run == 1


# ---------- a routine outside a project: the schedule makes chats ----------

def test_due_free_routine_makes_a_chat_and_skips_while_it_is_active(repo, dispatcher, fake_cli, clock):
    agent = repo.add_agent("Ann")
    r = repo.add_routine(None, "Digest", description="read the news", schedule_kind="interval",
                         interval_minutes=60, next_run_at=iso(NOW), agent_id=agent.id)
    dispatcher.tick()
    chats = repo.routine_chats(r.id)
    assert [(c.routine_run, c.project_id, c.title) for c in chats] == [(1, None, "Digest · #1")]
    assert repo.list_tasks() == []  # no card on any board
    assert repo.get_routine(r.id).next_run_at == iso(NOW + timedelta(hours=1))

    # The next slot while the chat run is not finished: skipped, not piled up
    clock["now"] = NOW + timedelta(hours=1, minutes=1)
    repo.update_chat(chats[0].id, status="running")
    dispatcher.tick()
    assert len(repo.routine_chats(r.id)) == 1 and repo.get_routine(r.id).skipped_count == 1

    # After the chat is idle again the following slot makes the second run
    clock["now"] = NOW + timedelta(hours=2, minutes=1)
    repo.update_chat(chats[0].id, status="idle")
    dispatcher.tick()
    assert [c.routine_run for c in repo.routine_chats(r.id)] == [2, 1]


def test_free_routine_ignores_hidden_projects_and_stops_at_the_ceiling(repo, dispatcher, fake_cli, project, clock):
    agent = repo.add_agent("Ann")
    repo.update_project(project.id, archived_at=iso(NOW))  # an archived project must not matter to a free routine
    r = repo.add_routine(None, "Once", description="x", schedule_kind="interval", interval_minutes=60,
                         next_run_at=iso(NOW), agent_id=agent.id, max_runs=1)
    dispatcher.tick()
    fresh = repo.get_routine(r.id)
    assert len(repo.routine_chats(r.id)) == 1 and not fresh.enabled and fresh.next_run_at is None


def test_free_routine_without_an_agent_is_paused_with_an_event(repo, dispatcher, clock):
    r = repo.add_routine(None, "Broken", description="x", schedule_kind="interval", interval_minutes=60,
                         next_run_at=iso(NOW))
    dispatcher.tick()
    assert not repo.get_routine(r.id).enabled and repo.routine_chats(r.id) == []
    assert any("needs an agent" in e["message"] for e in repo.list_events())


def test_free_routine_slot_is_passed_over_while_dispatcher_is_paused(repo, dispatcher, clock):
    agent = repo.add_agent("Ann")
    r = repo.add_routine(None, "Digest", description="x", schedule_kind="interval", interval_minutes=60,
                         next_run_at=iso(NOW), agent_id=agent.id)
    repo.set_setting("dispatcher_paused", "1")
    dispatcher.tick()
    # No session is started behind the owner's back; the schedule moves on, nothing is caught up later
    assert repo.routine_chats(r.id) == []
    assert repo.get_routine(r.id).next_run_at == iso(NOW + timedelta(hours=1))


def test_free_routine_with_a_project_agent_is_paused_with_an_event(repo, dispatcher, project, clock):
    agent = repo.add_agent("Inner", project_id=project.id)
    r = repo.add_routine(None, "Digest", description="x", schedule_kind="interval", interval_minutes=60,
                         next_run_at=iso(NOW), agent_id=agent.id)
    dispatcher.tick()
    assert not repo.get_routine(r.id).enabled and repo.routine_chats(r.id) == []
    assert any("belongs to a project" in e["message"] for e in repo.list_events())
