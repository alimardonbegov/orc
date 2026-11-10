"""Wakeups: `orc task wakeup`, sleeping without a worker slot, waking by time and by another card, the owner's
cancel, and no second fire."""
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from orc import task_cli, task_guide, wakeups
from orc.dispatcher import Dispatcher
from orc.machine import MachineLoad
from orc.main import parse_args
from orc.models import Blocker, TaskStatus


def _iso(at: float) -> str:
    return datetime.fromtimestamp(at, tz=timezone.utc).isoformat()


def _started(repo, dispatcher, project, **fields):
    t = repo.add_task(project.id, fields.pop("title", "A"), "the job", status="todo", **fields)
    dispatcher.tick()
    return repo.get_task(t.id)


def _end_turn(fake_cli, task, tmp_path, final_text="Waiting for #2"):
    """The session ended its turn long enough ago for orc to believe it."""
    path = tmp_path / f"session-{task.id}-{task.job_id}.jsonl"
    entries = [{"type": "user", "timestamp": _iso(time.time() - 3600), "message": {"content": "Task: do X"}},
               {"type": "assistant", "message": {"content": [{"type": "text", "text": final_text}]}}]
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n")
    old = time.time() - 600
    os.utime(path, (old, old))
    fake_cli.set_state(task.job_id, "working", tempo="idle", transcript_path=str(path))


def _hook(repo, task_id):
    return {"x-orc-hook": repo.get_task(task_id).hook_secret or ""}


def _ask(client, repo, task_id, **body):
    return client.post(f"/api/hooks/tasks/{task_id}/wakeups", json=body, headers=_hook(repo, task_id))


def _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, **body):
    fake_cli.stop_marks_stopped = True  # the daemon confirms the stop, as it does when a session is released
    t = _started(repo, dispatcher, project)
    r = _ask(client, repo, t.id, **body)
    assert r.status_code == 201, r.text
    _end_turn(fake_cli, t, tmp_path)
    dispatcher._sync_running()
    return repo.get_task(t.id)


def _shift(dispatcher, **delta):
    base = datetime.now(timezone.utc)
    dispatcher.now = lambda: base + timedelta(**delta)


# ---------- going to sleep ----------

def test_a_turn_ending_with_wakeup_sleeps_without_a_session(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=1800, note="check the CI")
    assert t.status == TaskStatus.IN_PROGRESS and t.blocker == Blocker.SLEEPING
    assert t.blocker_detail.startswith("asleep until ")
    assert ("stop", t.job_id) in fake_cli.calls
    run = repo.list_task_sessions(t.id)[-1]
    assert run["outcome"] == "sleeping" and run["ended_at"]
    # A later sync leaves the stopped session alone: it is not a crash
    fake_cli.set_state(t.job_id, "stopped")
    dispatcher._sync_running()
    assert repo.get_task(t.id).blocker == Blocker.SLEEPING
    assert not [c for c in fake_cli.calls if c[0] == "resume_bg"]


def test_the_endpoint_only_records_until_the_turn_ends(repo, dispatcher, fake_cli, project, client):
    t = _started(repo, dispatcher, project)
    r = _ask(client, repo, t.id, in_sec=600)
    assert r.status_code == 201 and r.json()["state"] == "pending" and r.json()["summary"].startswith("until ")
    t = repo.get_task(t.id)
    assert t.blocker is None and t.handoff_status == wakeups.STATUS_SLEEP
    assert ("stop", t.job_id) not in fake_cli.calls


def test_a_sleeper_does_not_hold_a_worker_slot(repo, dispatcher, fake_cli, project, client, tmp_path):
    repo.update_project(project.id, max_workers=1)
    sleeper = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=1800)
    other = repo.add_task(project.id, "B", "the job", status="todo")
    dispatcher.tick()
    assert repo.get_task(other.id).status == TaskStatus.IN_PROGRESS
    assert dispatcher.status()["running"] == 1
    assert repo.get_task(sleeper.id).blocker == Blocker.SLEEPING


def test_done_after_wakeup_in_the_same_turn_hands_in_and_cancels_it(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _started(repo, dispatcher, project)
    _ask(client, repo, t.id, in_sec=600)
    time.sleep(0.01)
    client.post(f"/api/hooks/tasks/{t.id}/handoff", json={"status": "done", "summary": "x"}, headers=_hook(repo, t.id))
    _end_turn(fake_cli, t, tmp_path)
    dispatcher._sync_running()
    assert repo.get_task(t.id).status == TaskStatus.VERIFYING
    assert [w["state"] for w in repo.list_wakeups(t.id)] == ["cancelled"]


@pytest.mark.parametrize("body,code", [
    ({}, 400),
    ({"in_sec": 10}, 400),                       # shorter than a minute is a poll
    ({"in_sec": 40 * 86400}, 400),               # more than 30 days
    ({"at": "2026-11-08T10:00:00"}, 400),        # no time zone
    ({"at": "2020-01-01T00:00:00Z"}, 400),       # in the past
    ({"watch_task_id": 99999}, 400),
])
def test_requests_that_cannot_be_right_are_refused(repo, dispatcher, project, client, body, code):
    t = _started(repo, dispatcher, project)
    assert _ask(client, repo, t.id, **body).status_code == code
    assert repo.list_wakeups(t.id) == [] and repo.get_task(t.id).handoff_status is None


def test_waiting_for_itself_or_a_finished_card_is_refused(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    assert _ask(client, repo, t.id, watch_task_id=t.id).status_code == 400
    finished = repo.add_task(project.id, "B", "x", status="done")
    r = _ask(client, repo, t.id, watch_task_id=finished.id)
    assert r.status_code == 409 and "continue now" in r.json()["detail"]


def test_the_endpoint_takes_only_the_secret_of_that_task(repo, dispatcher, project, client):
    a, b = _started(repo, dispatcher, project), _started(repo, dispatcher, project)
    url = f"/api/hooks/tasks/{a.id}/wakeups"
    assert client.post(url, json={"in_sec": 600}).status_code == 403
    assert client.post(url, json={"in_sec": 600}, headers=_hook(repo, b.id)).status_code == 403


# ---------- waking ----------

def test_a_time_wakeup_resumes_the_session_once_with_the_reason(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=600, note="check the CI")
    fake_cli.set_state(t.job_id, "stopped")
    dispatcher.tick()
    assert repo.get_task(t.id).blocker == Blocker.SLEEPING  # not yet
    _shift(dispatcher, minutes=11)
    dispatcher.tick()
    t2 = repo.get_task(t.id)
    assert t2.blocker is None and t2.status == TaskStatus.IN_PROGRESS
    resumes = [c for c in fake_cli.calls if c[0] == "resume_bg"]
    assert len(resumes) == 1 and "the time came" in resumes[0][3] and "check the CI" in resumes[0][3]
    run = repo.list_task_sessions(t.id)[-1]
    assert run["trigger"] == "wakeup" and run["trigger_detail"].startswith("the time came")
    assert [w["state"] for w in repo.list_wakeups(t.id)] == ["fired"]
    # The same tick again, or a new dispatcher over the same database after a restart: no second fire
    dispatcher.tick()
    restarted = Dispatcher(repo, dispatcher.settings, fake_cli, now=dispatcher.now, sleep=lambda _: None,
                           machine_sampler=lambda: MachineLoad(0.0, 8, 100))
    restarted.tick()
    assert len([c for c in fake_cli.calls if c[0] == "resume_bg"]) == 1


def test_a_card_wakeup_fires_when_that_card_is_done(repo, dispatcher, fake_cli, project, client, tmp_path):
    other = repo.add_task(project.id, "B", "x", status="backlog")
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, watch_task_id=other.id)
    assert f"until #{other.id} is done" in t.blocker_detail
    fake_cli.set_state(t.job_id, "stopped")
    dispatcher.tick()
    assert repo.get_task(t.id).blocker == Blocker.SLEEPING
    repo.update_task(other.id, status=TaskStatus.DONE)
    dispatcher.tick()
    assert repo.get_task(t.id).blocker is None
    run = repo.list_task_sessions(t.id)[-1]
    assert run["trigger"] == "wakeup" and run["trigger_detail"] == f"card #{other.id} is done"


@pytest.mark.parametrize("change,reason", [
    (lambda repo, tid: repo.update_task(tid, status=TaskStatus.FAILED), "failed"),
    (lambda repo, tid: repo.update_task(tid, archived_at="2026-01-01T00:00:00+00:00"), "was archived"),
    (lambda repo, tid: repo.delete_task(tid), "was deleted"),
])
def test_a_card_wakeup_does_not_sleep_forever_on_a_card_that_will_never_be_done(
        repo, dispatcher, fake_cli, project, client, tmp_path, change, reason):
    other = repo.add_task(project.id, "B", "x", status="backlog")
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, watch_task_id=other.id)
    change(repo, other.id)
    dispatcher.tick()
    assert repo.list_task_sessions(t.id)[-1]["trigger_detail"] == f"card #{other.id} {reason}"


def test_a_card_wakeup_with_a_deadline_wakes_at_the_deadline(repo, dispatcher, fake_cli, project, client, tmp_path):
    other = repo.add_task(project.id, "B", "x", status="backlog")
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, watch_task_id=other.id, in_sec=3600)
    _shift(dispatcher, hours=2)
    dispatcher.tick()
    assert "deadline" in repo.list_task_sessions(t.id)[-1]["trigger_detail"]


def test_a_due_sleeper_waits_for_a_free_slot(repo, dispatcher, fake_cli, project, client, tmp_path):
    repo.update_project(project.id, max_workers=1)
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=600)
    busy = _started(repo, dispatcher, project, title="B")
    _shift(dispatcher, minutes=11)
    dispatcher.tick()
    t2 = repo.get_task(t.id)
    assert t2.blocker == Blocker.SLEEPING and "waiting for a free worker slot" in t2.blocker_detail
    assert [w["state"] for w in repo.list_wakeups(t.id)] == ["pending"]
    repo.update_task(busy.id, status=TaskStatus.DONE)
    dispatcher.tick()
    assert repo.get_task(t.id).blocker is None


def test_a_sleeper_is_not_woken_on_pause(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=600)
    repo.set_setting("dispatcher_paused", "1")
    _shift(dispatcher, minutes=11)
    dispatcher.tick()
    assert repo.get_task(t.id).blocker == Blocker.SLEEPING


def test_a_failed_wake_fails_the_card_instead_of_retrying(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=600)
    _shift(dispatcher, minutes=11)

    def broken(*args, **kwargs):
        raise RuntimeError("daemon is down")
    fake_cli.resume_bg = broken
    dispatcher.tick()
    t2 = repo.get_task(t.id)
    assert t2.status == TaskStatus.FAILED and "could not wake" in t2.blocker_detail
    assert t2.detail_code == "session_lost"  # the card says it in plain words, as for any lost session
    assert [w["state"] for w in repo.list_wakeups(t.id)] == ["fired"]


# ---------- the owner ----------

def test_the_owner_lists_and_cancels_a_wakeup(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=600)
    listed = client.get(f"/api/tasks/{t.id}/wakeups").json()
    assert [w["state"] for w in listed] == ["pending"] and listed[0]["summary"].startswith("until ")
    r = client.post(f"/api/tasks/{t.id}/wakeups/{listed[0]['id']}/cancel")
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    assert client.post(f"/api/tasks/{t.id}/wakeups/{listed[0]['id']}/cancel").status_code == 409
    # Still asleep, not a crash: the owner decides what next
    t2 = repo.get_task(t.id)
    assert t2.blocker == Blocker.SLEEPING and "no wakeup left" in t2.blocker_detail
    _shift(dispatcher, minutes=11)
    fake_cli.set_state(t.job_id, "stopped")
    dispatcher.tick()
    assert not [c for c in fake_cli.calls if c[0] == "resume_bg"]


def test_cancel_of_a_wakeup_of_another_card_is_404(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=600)
    other = repo.add_task(project.id, "B", "x")
    wid = repo.list_wakeups(t.id)[0]["id"]
    assert client.post(f"/api/tasks/{other.id}/wakeups/{wid}/cancel").status_code == 404


def test_a_message_wakes_a_sleeper_and_cancels_its_wakeups(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=600)
    fake_cli.drop_state(t.job_id)  # days later the daemon may have forgotten the job
    r = client.post(f"/api/tasks/{t.id}/comments", json={"body": "go on now", "kind": "answer"})
    assert r.status_code in (200, 201), r.text
    t2 = repo.get_task(t.id)
    assert t2.blocker is None
    resumes = [c for c in fake_cli.calls if c[0] == "resume_bg"]
    assert len(resumes) == 1 and "go on now" in resumes[0][3]
    assert [w["state"] for w in repo.list_wakeups(t.id)] == ["cancelled"]
    assert repo.list_task_sessions(t.id)[-1]["trigger"] == "message"


def test_the_owner_can_accept_the_work_of_a_sleeper(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=600)
    r = client.post(f"/api/tasks/{t.id}/accept")
    assert r.status_code == 200, r.text
    assert repo.get_task(t.id).status == TaskStatus.VERIFYING
    assert [w["state"] for w in repo.list_wakeups(t.id)] == ["cancelled"]


def test_closing_a_sleeper_by_hand_cancels_its_wakeups(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=600)
    client.post(f"/api/tasks/{t.id}/stop")
    assert repo.get_task(t.id).status == TaskStatus.FAILED
    dispatcher.tick()
    assert [w["state"] for w in repo.list_wakeups(t.id)] == ["cancelled"]


# ---------- the command ----------

@pytest.fixture
def through_api(client, dispatcher, monkeypatch):
    monkeypatch.setenv("ORC_DATA_DIR", str(dispatcher.settings.data_dir))

    def call(method, path, payload, hook_secret=None):
        headers = {"x-orc-hook": hook_secret} if hook_secret is not None else {}
        r = client.request(method, path, json=payload, headers=headers) if payload is not None else client.request(method, path)
        if r.status_code >= 400:
            raise task_cli.CliError(task_cli._error_text(r.text))
        return r.json()
    return call


def _cli(argv, call, capsys):
    code = task_cli.run(parse_args(["task", *argv]), call)
    out = capsys.readouterr()
    return code, out.out, out.err


def test_cli_wakeup_from_the_session_folder(repo, dispatcher, project, through_api, capsys, monkeypatch):
    other = repo.add_task(project.id, "B", "x")
    t = _started(repo, dispatcher, project)
    monkeypatch.chdir(Path(t.worktree_path))
    code, out, err = _cli(["wakeup", "--card", str(other.id), "--in", "2h", "--note", "check it"], through_api, capsys)
    assert code == 0, err
    assert f"#{t.id} will sleep until #{other.id} is done" in out
    row = repo.list_wakeups(t.id)[0]
    assert row["watch_task_id"] == other.id and row["wake_at"] and row["note"] == "check it"


def test_cli_wakeup_refuses_outside_a_card(repo, project, git_repo, through_api, capsys, monkeypatch):
    monkeypatch.chdir(git_repo)
    code, _, err = _cli(["wakeup", "--in", "30m"], through_api, capsys)
    assert code == 1 and "not the worktree of any card" in err


def test_cli_wakeup_needs_a_condition(through_api, capsys):
    code, _, err = _cli(["wakeup"], through_api, capsys)
    assert code == 1 and "say when to wake" in err


def test_cli_wakeup_tells_when_the_server_is_older(repo, dispatcher, project, through_api, capsys, monkeypatch):
    """An older server has no such route: the answer comes from the real app, with the route renamed away."""
    t = _started(repo, dispatcher, project)
    monkeypatch.chdir(Path(t.worktree_path))

    def old_server(method, path, payload, hook_secret=None):
        return through_api(method, path.replace("/wakeups", "/no-such-route"), payload, hook_secret=hook_secret)
    code, _, err = _cli(["wakeup", "--in", "30m"], old_server, capsys)
    assert code == 1 and "older than this CLI" in err
    assert repo.get_task(t.id).handoff_status is None


@pytest.mark.parametrize("raw,seconds", [("30m", 1800), ("2h", 7200), ("1h30m", 5400), ("1d", 86400), ("45", 2700)])
def test_durations(raw, seconds):
    assert task_cli.parse_duration(raw) == seconds


def test_bad_duration():
    with pytest.raises(task_cli.CliError):
        task_cli.parse_duration("soon")


def test_the_session_may_run_wakeup_in_every_permission_mode(tmp_path):
    rules = task_guide.handoff_permissions(tmp_path)
    assert any(rule.endswith(" task wakeup:*)") for rule in rules)
    assert "task wakeup" in task_guide.session_note(tmp_path, 7)


def test_the_card_says_it_is_asleep(repo, dispatcher, fake_cli, project, client, tmp_path):
    from orc.activity import task_now
    t = _asleep(repo, dispatcher, fake_cli, project, client, tmp_path, in_sec=600)
    assert task_now(repo, fake_cli, repo.get_task(t.id))["phase"] == "sleeping"
