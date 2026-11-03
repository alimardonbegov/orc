"""Reaper: stops sessions that diverged from the database and touches nothing foreign."""
from orc.models import TaskStatus


def _running(repo, dispatcher, project, title="A"):
    t = repo.add_task(project.id, title, status="todo")
    dispatcher.tick()
    return repo.get_task(t.id)


def _stops(fake_cli):
    return [c[1] for c in fake_cli.calls if c[0] == "stop"]


def test_reaps_done_task_session_keeps_running_and_foreign(repo, dispatcher, fake_cli, project):
    done = _running(repo, dispatcher, project, "done")
    live = _running(repo, dispatcher, project, "live")
    repo.update_task(done.id, status=TaskStatus.DONE)
    repo.update_task(live.id, blocker="needs_input")  # waiting for an answer, but we still keep it
    for job in (done.job_id, live.job_id):
        fake_cli.set_state(job, "working", tempo="idle")
    fake_cli.foreign_sessions = [{"id": "f0reign1", "kind": "background", "state": "working"}]
    fake_cli.calls.clear()
    dispatcher._reaped_at = None
    dispatcher._reap_sessions()
    assert _stops(fake_cli) == [done.job_id]
    assert dispatcher.reaped_total == 1


def test_reaps_previous_job_after_copy(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    old_job = t.job_id
    fake_cli.set_state(old_job, "done")
    dispatcher.sessions.wake(t, "again")  # done → resume as a copy under a new job
    t = repo.get_task(t.id)
    assert t.job_id != old_job
    fake_cli.set_state(old_job, "working", tempo="idle")  # the old process came back to life / did not die
    fake_cli.calls.clear()
    dispatcher._reaped_at = None
    dispatcher._reap_sessions()
    assert _stops(fake_cli) == [old_job]


def test_reaper_respects_switch_interval_and_batch(repo, dispatcher, fake_cli, project, monkeypatch):
    import orc.dispatcher as d
    monkeypatch.setattr(d, "SESSION_REAP_BATCH", 1)
    a = _running(repo, dispatcher, project, "a")
    b = _running(repo, dispatcher, project, "b")
    for t in (a, b):
        repo.update_task(t.id, status=TaskStatus.DONE)
        fake_cli.set_state(t.job_id, "working", tempo="idle")
    repo.set_setting("session_reaper", "0")
    dispatcher._reaped_at = None
    fake_cli.calls.clear()
    dispatcher._reap_sessions()
    assert _stops(fake_cli) == []
    repo.set_setting("session_reaper", "1")
    dispatcher._reap_sessions()
    assert len(_stops(fake_cli)) == 1      # batch
    dispatcher._reap_sessions()
    assert len(_stops(fake_cli)) == 1      # the interval has not passed yet


def test_reaper_skips_pass_when_daemon_list_fails(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    repo.update_task(t.id, status=TaskStatus.DONE)
    fake_cli.sessions_error = True
    dispatcher._reaped_at = None
    fake_cli.calls.clear()
    dispatcher._reap_sessions()  # does not raise
    assert _stops(fake_cli) == []


def test_status_reports_sessions_and_load(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    repo.update_task(t.id, status=TaskStatus.DONE)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    dispatcher._reaped_at = None
    dispatcher._reap_sessions()
    s = dispatcher.status()
    assert s["reaped_total"] == 1 and s["sessions_alive"] == 0
    assert s["start_blocked_reason"] is None
    assert "load_avg" in s and "free_mem_pct" in s


def test_reaper_batch_counts_attempts_not_successes(repo, dispatcher, fake_cli, project, monkeypatch):
    """Hung `claude stop` calls must not multiply attempts: a batch counts calls, not successes."""
    import orc.dispatcher as d
    monkeypatch.setattr(d, "SESSION_REAP_BATCH", 1)
    a = _running(repo, dispatcher, project, "a")
    b = _running(repo, dispatcher, project, "b")
    for t in (a, b):
        repo.update_task(t.id, status=TaskStatus.DONE)
        fake_cli.set_state(t.job_id, "working", tempo="idle")

    def failing_stop(job_id):
        fake_cli.calls.append(("stop", job_id))
        raise RuntimeError("daemon not responding")

    monkeypatch.setattr(fake_cli, "stop", failing_stop)
    dispatcher._reaped_at = None
    fake_cli.calls.clear()
    dispatcher._reap_sessions()
    assert len(_stops(fake_cli)) == 1
    assert dispatcher.reaped_total == 0


def test_reaper_clears_stale_alive_count_when_off_or_list_fails(repo, dispatcher, fake_cli, project):
    _running(repo, dispatcher, project)
    dispatcher._reaped_at = None
    dispatcher._reap_sessions()
    assert dispatcher.sessions_alive is not None
    repo.set_setting("session_reaper", "0")
    dispatcher._reap_sessions()
    assert dispatcher.sessions_alive is None
    repo.set_setting("session_reaper", "1")
    dispatcher._reaped_at = None
    dispatcher._reap_sessions()
    assert dispatcher.sessions_alive is not None
    fake_cli.sessions_error = True
    dispatcher._reaped_at = None
    dispatcher._reap_sessions()
    assert dispatcher.sessions_alive is None
