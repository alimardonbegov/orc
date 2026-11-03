"""Dispatcher lock: a tick and the owner's commands do not overlap."""
import threading

import pytest

from orc.dispatcher import DispatcherBusy
from orc.models import TaskStatus


def _in_progress(repo, dispatcher, project):
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    return repo.get_task(t.id)


def test_parallel_delivery_resumes_session_once(repo, dispatcher, fake_cli, project):
    """The original defect: a tick and an HTTP reply entered delivery simultaneously and started
    TWO sessions in one worktree. Now a shared lock separates them.

    The test is made deterministic by a barrier on read_state: without the lock both threads reach reading
    the state and pass the barrier together; with the lock the second thread waits outside, the first one's barrier
    times out: this is expected, BrokenBarrierError is caught and work continues.
    """
    task = _in_progress(repo, dispatcher, project)
    fake_cli.set_state(task.job_id, "stopped")
    repo.add_message(task.id, "continue")

    gate = threading.Barrier(2, timeout=0.5)
    real_read_state = fake_cli.read_state

    def read_state_at_gate(job_id):
        try:
            gate.wait()
        except threading.BrokenBarrierError:
            pass
        return real_read_state(job_id)

    fake_cli.read_state = read_state_at_gate
    errors: list[Exception] = []

    def deliver():
        try:
            dispatcher.deliver_messages(task.id)
        except DispatcherBusy:
            pass  # the second thread may get a refusal, but has no right to resume a second time
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=deliver) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(15)

    assert not errors
    resumes = [c for c in fake_cli.calls if c[0] == "resume_bg"]
    assert len(resumes) == 1
    assert repo.pending_messages(task.id) == []


def test_command_gives_up_when_dispatcher_is_busy(repo, dispatcher, project, monkeypatch):
    """While a long pass is running, a command does not wait forever but honestly answers with a refusal."""
    import orc.dispatcher as dispatcher_module

    monkeypatch.setattr(dispatcher_module, "COMMAND_LOCK_TIMEOUT_SEC", 0.1)
    task = repo.add_task(project.id, "A", status="backlog")

    holding = threading.Event()
    release = threading.Event()

    def hold():
        with dispatcher._exclusive(None):
            holding.set()
            release.wait(5)

    keeper = threading.Thread(target=hold)
    keeper.start()
    holding.wait(5)
    try:
        with pytest.raises(DispatcherBusy):
            dispatcher.archive(task.id)
    finally:
        release.set()
        keeper.join(5)
    # After release the same command goes through
    assert dispatcher.archive(task.id).archived_at is not None


def test_tick_calls_delivery_without_deadlock(repo, dispatcher, fake_cli, project):
    """A tick takes the lock and inside calls delivery, which takes it again: an RLock is needed."""
    task = _in_progress(repo, dispatcher, project)
    fake_cli.set_state(task.job_id, "stopped")
    repo.add_message(task.id, "text")
    dispatcher.tick()
    assert repo.get_task(task.id).status == TaskStatus.IN_PROGRESS
    assert [c[0] for c in fake_cli.calls if c[0] == "resume_bg"] == ["resume_bg"]


def test_answer_nested_in_delivery_does_not_deadlock(repo, dispatcher, fake_cli, project):
    """answer() takes the lock and calls deliver_messages(), which takes it again."""
    task = _in_progress(repo, dispatcher, project)
    fake_cli.set_state(task.job_id, "stopped")
    dispatcher.answer(task.id, "reply")
    assert [c[0] for c in fake_cli.calls if c[0] == "resume_bg"] == ["resume_bg"]
