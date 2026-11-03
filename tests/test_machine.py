from orc.machine import MachineLoad, busy_reason
from orc.models import TaskStatus


def test_busy_reason_thresholds():
    assert busy_reason(MachineLoad(13.0, 12, 50), 100, 10).startswith("load 13.0")
    assert busy_reason(MachineLoad(11.0, 12, 50), 100, 10) is None
    assert "memory" in busy_reason(MachineLoad(1.0, 12, 5), 100, 10)
    assert busy_reason(MachineLoad(99.0, 12, 1), 0, 0) is None       # 0 means the check is disabled
    assert busy_reason(MachineLoad(None, 12, None), 100, 10) is None  # nothing to measure with, so we do not block


def test_start_ready_waits_while_machine_busy(repo, dispatcher, fake_cli, project):
    dispatcher.machine_sampler = lambda: MachineLoad(30.0, 12, 50)
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.TODO
    assert dispatcher.start_blocked_reason.startswith("load 30.0")
    events = [e for e in repo.list_events(limit=50) if "task start postponed" in e["message"]]
    assert len(events) == 1  # one event per state change, not per tick
    dispatcher.machine_sampler = lambda: MachineLoad(1.0, 12, 50)
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS
    assert dispatcher.start_blocked_reason is None


def _blocked_events(repo):
    return [e for e in repo.list_events(limit=100) if "task start postponed" in e["message"]]


def test_blocked_event_not_repeated_while_numbers_drift(repo, dispatcher, project):
    t = repo.add_task(project.id, "A", status="todo")
    for load in (30.0, 30.1, 31.5, 29.9):  # same reason, only the numbers in the text change
        dispatcher.machine_sampler = lambda load=load: MachineLoad(load, 12, 50)
        dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.TODO
    assert len(_blocked_events(repo)) == 1
    assert dispatcher.start_blocked_reason.startswith("load 29.9")  # the status carries the fresh text


def test_switch_from_load_to_mem_is_new_event(repo, dispatcher, project):
    repo.add_task(project.id, "A", status="todo")
    dispatcher.machine_sampler = lambda: MachineLoad(30.0, 12, 50)
    dispatcher.tick()
    dispatcher.machine_sampler = lambda: MachineLoad(1.0, 12, 5)  # load dropped, but memory is short
    dispatcher.tick()
    dispatcher.tick()
    events = _blocked_events(repo)
    assert len(events) == 2 and "memory" in events[0]["message"]  # list_events returns newest first
    assert "memory" in dispatcher.start_blocked_reason


def test_gate_state_reset_when_nothing_waits(repo, dispatcher, project):
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.machine_sampler = lambda: MachineLoad(30.0, 12, 50)
    dispatcher.tick()
    assert dispatcher.start_blocked_reason and dispatcher.last_machine is not None
    repo.update_task(t.id, status="backlog")  # the queue emptied while the machine was busy
    dispatcher.tick()
    assert dispatcher.start_blocked_reason is None and dispatcher.last_machine is None


def test_gate_state_reset_on_pause_and_quota(repo, dispatcher, project):
    repo.add_task(project.id, "A", status="todo")
    dispatcher.machine_sampler = lambda: MachineLoad(30.0, 12, 50)
    dispatcher.tick()
    assert dispatcher.start_blocked_reason
    repo.set_setting("dispatcher_paused", "1")
    dispatcher.tick()
    assert dispatcher.start_blocked_reason is None
    repo.set_setting("dispatcher_paused", "0")
    dispatcher.tick()
    assert dispatcher.start_blocked_reason
    repo.set_setting("quota_retry_after", "2999-01-01T00:00:00+00:00")
    dispatcher.tick()
    assert dispatcher.start_blocked_reason is None


def test_sampler_skipped_when_both_thresholds_off(repo, dispatcher, project):
    repo.set_setting("start_max_load_pct", "0")
    repo.set_setting("start_min_free_mem_pct", "0")
    calls = []
    dispatcher.machine_sampler = lambda: calls.append(1) or MachineLoad(99.0, 12, 1)
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    assert calls == [] and repo.get_task(t.id).status == TaskStatus.IN_PROGRESS


def test_manual_tick_starts_despite_busy_machine(repo, dispatcher, fake_cli, project):
    # The "Run now" button is the owner's explicit will: the load gate does not hold it,
    # otherwise the button silently does nothing while load is high (e.g. right after macOS boots).
    dispatcher.machine_sampler = lambda: MachineLoad(59.7, 12, 50)
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.TODO
    assert dispatcher.try_tick(manual=True)
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS
    overrides = [e for e in repo.list_events(limit=50) if "despite the load" in e["message"]]
    assert len(overrides) == 1 and "load 59.7" in overrides[0]["message"]


def test_manual_tick_still_respects_pause(repo, dispatcher, fake_cli, project):
    dispatcher.machine_sampler = lambda: MachineLoad(59.7, 12, 50)
    t = repo.add_task(project.id, "A", status="todo")
    repo.set_setting("dispatcher_paused", "1")
    assert dispatcher.try_tick(manual=True)
    assert repo.get_task(t.id).status == TaskStatus.TODO


def test_manual_tick_without_ready_tasks_writes_no_override_event(repo, dispatcher, fake_cli, project):
    # Worker limit exhausted: nothing to start, a "despite the load" event would be a lie
    repo.set_setting("global_max_workers", "1")
    dispatcher.machine_sampler = lambda: MachineLoad(59.7, 12, 50)
    repo.add_task(project.id, "busy", status="in_progress")
    t = repo.add_task(project.id, "A", status="todo")
    assert dispatcher.try_tick(manual=True)
    assert repo.get_task(t.id).status == TaskStatus.TODO
    assert not [e for e in repo.list_events(limit=50) if "despite the load" in e["message"]]


def test_tick_endpoint_bypasses_load_gate(client, repo, dispatcher, fake_cli, project):
    dispatcher.machine_sampler = lambda: MachineLoad(59.7, 12, 50)
    t = repo.add_task(project.id, "A", status="todo")
    assert client.post("/api/dispatcher/tick").status_code == 200
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS
