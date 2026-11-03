"""Task token collection by the dispatcher: session journal, recalculation on a tick, backfill of old tasks."""
import json
import os
import time
from pathlib import Path

from orc import token_usage
from orc.claude_cli import JobState, project_slug
from orc.config import Settings
from orc.dispatcher import Dispatcher
from orc.machine import MachineLoad
from orc.models import TaskStatus
from orc.report import REPORT_REL_PATH


def _line(msg_id, out, model="claude-opus-5"):
    return json.dumps({"type": "assistant", "message": {"id": msg_id, "model": model, "usage": {
        "input_tokens": 1, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": out}}}) + "\n"


def _transcript(tmp_path, name, lines):
    path = tmp_path / "projects" / "slug" / f"{name}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(lines), encoding="utf-8")
    return path


def _usage(repo, task_id):
    raw = repo.get_task(task_id).usage_json
    return json.loads(raw) if raw else None


def _started(repo, dispatcher, project, **fields):
    t = repo.add_task(project.id, "A", status="todo", **fields)
    dispatcher.tick()
    return repo.get_task(t.id)


def test_start_registers_session_and_first_tick_collects_usage(repo, dispatcher, fake_cli, project, tmp_path):
    path = _transcript(tmp_path, "sess-job00001", [_line("m1", 10), _line("m1", 40), _line("m2", 5)])
    fake_cli.transcript_for_new = str(path)
    t = _started(repo, dispatcher, project)
    sessions = repo.list_task_sessions(t.id)
    assert [(s["job_id"], s["session_id"], s["transcript_path"]) for s in sessions] == [("job00001", "sess-job00001", str(path))]
    # The start registered the session, and the first sync tick has already counted the tokens
    dispatcher.tick()
    usage = _usage(repo, t.id)
    assert usage["total"]["output"] == 45 and usage["total_tokens"] == 47
    assert usage["sessions"] == [{"session_id": "sess-job00001", "job_id": "job00001", "total_tokens": 47}]


def test_unchanged_transcript_is_not_rescanned(repo, dispatcher, fake_cli, project, tmp_path, monkeypatch):
    path = _transcript(tmp_path, "sess-job00001", [_line("m1", 10)])
    fake_cli.transcript_for_new = str(path)
    t = _started(repo, dispatcher, project)
    calls = []
    real = token_usage.collect
    monkeypatch.setattr(token_usage, "collect", lambda *a, **kw: calls.append(1) or real(*a, **kw))
    dispatcher.tick()
    dispatcher.tick()
    assert len(calls) == 1
    path.write_text(path.read_text() + _line("m2", 7), encoding="utf-8")
    dispatcher.tick()
    assert len(calls) == 2 and _usage(repo, t.id)["total"]["output"] == 17


def test_transcript_path_learned_later_and_session_id_change_recorded(repo, dispatcher, fake_cli, project, tmp_path):
    # The real daemon: right after the start there is no state.json yet, so the transcript path is unknown
    fake_cli.delay_state = True
    t = _started(repo, dispatcher, project)
    assert repo.list_task_sessions(t.id) == [] or repo.list_task_sessions(t.id)[0]["transcript_path"] is None
    path = _transcript(tmp_path, "sid-real", [_line("m1", 3)])
    fake_cli.set_state(t.job_id, "working", session_id="sid-real", transcript_path=str(path))
    dispatcher.tick()
    sessions = repo.list_task_sessions(t.id)
    assert [(s["job_id"], s["session_id"], s["transcript_path"]) for s in sessions] == [(t.job_id, "sid-real", str(path))]
    assert _usage(repo, t.id)["total"]["output"] == 3


def test_resume_adds_session_and_total_dedups_copied_messages(repo, dispatcher, fake_cli, project, tmp_path):
    first = _transcript(tmp_path, "sess-job00001", [_line("m1", 10)])
    fake_cli.transcript_for_new = str(first)
    t = _started(repo, dispatcher, project)
    dispatcher.tick()
    assert _usage(repo, t.id)["total"]["output"] == 10
    # The session crashed, the dispatcher resumes it: a new job, a new file with a copy of the old message
    second = _transcript(tmp_path, "sess-resumed", [_line("m1", 10), _line("m2", 4)])
    fake_cli.transcript_for_new = str(second)
    fake_cli.set_state(t.job_id, "failed", detail="crash")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.job_id == "job00002"
    assert [s["job_id"] for s in repo.list_task_sessions(t.id)] == ["job00001", "job00002"]
    dispatcher.tick()
    usage = _usage(repo, t.id)
    assert usage["total"]["output"] == 14
    assert [s["total_tokens"] for s in usage["sessions"]] == [11, 5]


def test_done_state_collects_final_usage_before_verifying(repo, dispatcher, fake_cli, project, tmp_path):
    path = _transcript(tmp_path, "sess-job00001", [_line("m1", 1)])
    fake_cli.transcript_for_new = str(path)
    t = _started(repo, dispatcher, project)
    path.write_text(path.read_text() + _line("m2", 100), encoding="utf-8")
    report = Path(t.worktree_path) / REPORT_REL_PATH
    report.parent.mkdir(exist_ok=True)
    report.write_text(json.dumps({"status": "success", "summary": "ok"}))
    fake_cli.set_state(t.job_id, "done")
    dispatcher._sync_running()
    assert repo.get_task(t.id).status == TaskStatus.VERIFYING
    assert _usage(repo, t.id)["total"]["output"] == 101


def test_collector_failure_does_not_break_sync(repo, dispatcher, fake_cli, project, tmp_path, monkeypatch):
    path = _transcript(tmp_path, "sess-job00001", [_line("m1", 1)])
    fake_cli.transcript_for_new = str(path)
    t = _started(repo, dispatcher, project)

    def boom(*_a, **_kw):
        raise RuntimeError("parser broke")

    monkeypatch.setattr(token_usage, "collect", boom)
    # The transcript is aged: the dispatcher sets the waiting badge only for a silent session
    # (WAITING_QUIET_SEC, see tests/test_input_requests.py)
    os.utime(path, (time.time() - 600, time.time() - 600))
    fake_cli.set_state(t.job_id, "blocked", needs="Which port?")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.blocker == "needs_input" and t.usage_json is None


def test_backfill_registers_sessions_of_old_tasks_once(repo, fake_cli, project, tmp_path):
    # Tasks created before the session journal: job_id exists, records do not. The first tick of a new
    # process picks up their transcripts and counts tokens, including for done and archived ones.
    done_path = _transcript(tmp_path, "old-done", [_line("d1", 20)])
    repo.add_task(project.id, "done one", status="done", job_id="old1", session_id="old-done", archived_at="2026-01-01T00:00:00+00:00")
    fake_cli.states["old1"] = JobState("done", "", None, "old-done", None, str(done_path))
    # This one no longer has a job directory: the path is derived from the working copy and session_id
    worktree = tmp_path / "wt" / "orc-task-2"
    repo.add_task(project.id, "no job directory", status="failed", job_id="old2", session_id="old-gone",
                  worktree_path=str(worktree))
    expected = tmp_path / "projects" / project_slug(str(worktree)) / "old-gone.jsonl"
    expected.parent.mkdir(parents=True)
    expected.write_text(_line("g1", 5), encoding="utf-8")
    repo.add_task(project.id, "no session", status="backlog")

    settings = Settings(data_dir=tmp_path / "data", jobs_dir=tmp_path / "jobs",
                        usage_cache_path=tmp_path / "usage-cache.json", claude_json_path=tmp_path / "claude.json")
    dispatcher = Dispatcher(repo, settings, fake_cli, sleep=lambda _: None,
                            machine_sampler=lambda: MachineLoad(0.0, 8, 100))
    dispatcher.tick()
    assert _usage(repo, 1)["total"]["output"] == 20
    assert [s["transcript_path"] for s in repo.list_task_sessions(1)] == [str(done_path)]
    assert _usage(repo, 2)["total"]["output"] == 5
    assert [s["transcript_path"] for s in repo.list_task_sessions(2)] == [str(expected)]
    assert repo.get_task(3).usage_json is None and repo.list_task_sessions(3) == []
    # A repeated tick re-reads nothing: the backfill is one-shot and finished tasks are not part of sync
    read_before = len(fake_cli.read_state_calls)
    dispatcher.tick()
    assert len(fake_cli.read_state_calls) == read_before


def test_retry_keeps_spent_tokens_and_counts_new_attempt_on_top(repo, dispatcher, fake_cli, project, tmp_path):
    first = _transcript(tmp_path, "sess-job00001", [_line("m1", 10)])
    fake_cli.transcript_for_new = str(first)
    t = _started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "failed", detail="boom")
    dispatcher.tick()  # auto-resume -> job00002 (the same transcript for simplicity)
    fake_cli.set_state("job00002", "failed", detail="boom again")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and _usage(repo, t.id)["total"]["output"] == 10
    dispatcher.retry(t.id)
    t = repo.get_task(t.id)
    assert t.job_id is None and _usage(repo, t.id)["total"]["output"] == 10  # the usage is not reset
    second = _transcript(tmp_path, "sess-job00003", [_line("n1", 3)])
    fake_cli.transcript_for_new = str(second)
    dispatcher.tick()
    dispatcher.tick()
    usage = _usage(repo, t.id)
    assert usage["total"]["output"] == 13
    assert [s["job_id"] for s in usage["sessions"]] == ["job00001", "job00002", "job00003"]


# ---------- recalculating money for the new price list ----------

def _old_usage(models, scan=None, estimated=None):
    """usage_json computed by an old version: without `pricing`, with an estimate from the old price list."""
    total = {k: sum(m.get(k, 0) for m in models.values()) for k in token_usage.COUNTER_KEYS}
    return {"total": total, "total_tokens": sum(total.values()), "models": models, "agents": [],
            "sessions": [{"session_id": "s", "job_id": "j", "total_tokens": sum(total.values())}],
            "cost_usd": None, "cost_usd_estimated": estimated, "scanned_at": "2026-10-30T10:00:00+00:00",
            "scan": scan or {"files": 0, "bytes": 0}}


def test_reprice_fills_estimate_for_models_missing_from_old_price_table(repo, dispatcher, project):
    """Sonnet 5.5 was not in the old price list: the estimate is empty and the usage journal is zeros."""
    models = {"claude-sonnet-5-5": {**token_usage.EMPTY_COUNTERS, "output": 1_000_000, "messages": 3}}
    t = repo.add_task(project.id, "A", status="done")
    repo.update_task(t.id, usage_json=json.dumps(_old_usage(models)))
    repo.add_usage_entry(t.id, project.id, 600_000, 0.0, at="2026-10-30T09:00:00+00:00")
    repo.add_usage_entry(t.id, project.id, 400_000, 0.0, at="2026-10-30T10:00:00+00:00")

    assert dispatcher.reprice_usage() == 1
    usage = _usage(repo, t.id)
    assert usage["cost_usd_estimated"] == 10.0 and usage["pricing"] == token_usage.PRICING_VERSION
    # The task journal is rewritten to the new total proportionally to tokens, the time is the same
    entries = repo.usage_entries_since("2026-10-01T00:00:00+00:00")
    assert [(e["at"], e["cost_usd"]) for e in entries] == [
        ("2026-10-30T09:00:00+00:00", 6.0), ("2026-10-30T10:00:00+00:00", 4.0)]
    # A second time for the same price list version does nothing
    assert dispatcher.reprice_usage() == 0


def test_reprice_rereads_unchanged_transcripts_for_cache_ttl_split(repo, dispatcher, project, tmp_path):
    line = json.dumps({"type": "assistant", "message": {"id": "m1", "model": "claude-opus-5", "usage": {
        "input_tokens": 0, "cache_creation_input_tokens": 1_000_000, "cache_read_input_tokens": 0, "output_tokens": 0,
        "cache_creation": {"ephemeral_5m_input_tokens": 1_000_000, "ephemeral_1h_input_tokens": 0}}}}) + "\n"
    path = _transcript(tmp_path, "sess-old", [line])
    t = repo.add_task(project.id, "A", status="done")
    repo.add_task_session(t.id, "jobold", "sess-old", str(path))
    refs = [token_usage.SessionRef("sess-old", "jobold", str(path))]
    models = {"claude-opus-5": {**token_usage.EMPTY_COUNTERS, "cache_creation": 1_000_000, "messages": 1}}
    repo.update_task(t.id, usage_json=json.dumps(_old_usage(models, scan=token_usage.signature(refs), estimated=6.25)))

    dispatcher.reprice_usage()
    usage = _usage(repo, t.id)
    # The transcript is in place: re-read, the cache write is five-minute (x1.25), not the default x2
    assert usage["models"]["claude-opus-5"]["cache_creation_1h"] == 0
    assert usage["cost_usd_estimated"] == 6.25
    assert usage["scanned_at"] == "2026-10-30T10:00:00+00:00"


def test_usage_delta_is_measured_with_one_price_list(repo, dispatcher, fake_cli, project, tmp_path):
    """The increment in the journal is the difference of two estimates under ONE price list: a price change must not show up
    as a fake usage jump on a task that is running right now."""
    path = _transcript(tmp_path, "sess-job00001", [_line("m1", 1_000_000, model="claude-sonnet-5-5")])
    fake_cli.transcript_for_new = str(path)
    t = _started(repo, dispatcher, project)
    dispatcher.tick()
    stale = _usage(repo, t.id)
    stale["cost_usd_estimated"] = None  # this is how the old price list without Sonnet 5.5 computed it
    stale["scan"] = {"files": 0, "bytes": 0}  # force a recalculation on the next tick
    repo.update_task(t.id, usage_json=json.dumps(stale))
    before = sum(e["cost_usd"] for e in repo.usage_entries_since("2000-01-01"))
    dispatcher.tick()
    after = sum(e["cost_usd"] for e in repo.usage_entries_since("2000-01-01"))
    assert after == before
