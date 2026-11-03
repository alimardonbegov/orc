"""Input requests from the session: wait detection via state.json, hook → API → decision → hook.

Facts about state.json and the hook format come from the spikes of 2026-09-21 (docs/internals/input-requests.md).
"""
from __future__ import annotations

import json
import os
import shlex
import time
from pathlib import Path

import pytest

from orc import inputs
from orc.claude_cli import ClaudeCli, JobState
from orc.hooks import input_hook
from orc.models import Blocker, TaskStatus


def started(repo, dispatcher, project):
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    return repo.get_task(t.id)


def _age(path: Path, seconds: int = 600) -> None:
    """Pretend the session wrote nothing for `seconds` seconds: the fallback channel trusts silence."""
    old = time.time() - seconds
    os.utime(path, (old, old))


def _hook(repo, task_id):
    """A task hook header: the secret is issued together with the session (see test_hook_auth.py)."""
    return {"x-orc-hook": repo.get_task(task_id).hook_secret or ""}


# ---------- JobState.waiting: waiting arrives in tempo/needs, not in state ----------

def test_waiting_is_read_from_tempo_and_needs():
    assert JobState("blocked", "", None, None, None).waiting
    assert JobState("working", "", None, None, None, tempo="blocked").waiting
    assert JobState("working", "", "approve Bash: ls", None, None, tempo="active").waiting
    assert not JobState("working", "", None, None, None, tempo="active").waiting
    assert not JobState("working", "", None, None, None).waiting
    assert not JobState("stopped", "", None, None, None, tempo="blocked").waiting


def test_read_state_reads_tempo(tmp_path):
    jobs = tmp_path / "jobs"
    (jobs / "ab12cd34").mkdir(parents=True)
    (jobs / "ab12cd34" / "state.json").write_text(json.dumps({
        "state": "working", "tempo": "blocked", "needs": "approve Bash: echo hi", "detail": "starting…", "sessionId": "sid-1",
    }))
    st = ClaudeCli(bin="claude", jobs_dir=jobs).read_state("ab12cd34")
    assert st.tempo == "blocked" and st.needs == "approve Bash: echo hi" and st.waiting


# ---------- fallback channel: the dispatcher sees waiting via state.json ----------

def test_working_with_blocked_tempo_sets_needs_input(repo, dispatcher, fake_cli, project):
    t = started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", detail="Reading files", needs="approve Bash: echo hi", tempo="blocked")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.blocker == Blocker.NEEDS_INPUT
    assert t.blocker_detail == "Requests permission: Bash: echo hi"
    assert any("is waiting for reply" in e["message"] for e in repo.list_events())
    # The session came back to life: the badge is cleared, as before for state=blocked
    fake_cli.set_state(t.job_id, "working", tempo="active")
    dispatcher.tick()
    assert repo.get_task(t.id).blocker is None


def test_stale_state_after_answer_does_not_bring_badge_back(client, repo, dispatcher, fake_cli, project):
    # The daemon rewrites tempo/needs with a delay: right after the answer state.json still "waits"
    t = started(repo, dispatcher, project)
    rid = client.post("/api/hooks/input-requests", json={
        "task_id": t.id, "kind": "permission", "tool_name": "Bash", "tool_input": {"command": "ls"},
    }, headers=_hook(repo, t.id)).json()["id"]
    client.post(f"/api/tasks/{t.id}/input-requests/{rid}/answer", json={"decision": {"behavior": "allow"}})
    fake_cli.set_state(t.job_id, "working", needs="approve Bash: ls", tempo="blocked")
    dispatcher.tick()
    assert repo.get_task(t.id).blocker is None
    # And after a pause the same state.json is a real wait (e.g. the next request
    # came in bypassing the hook)
    from datetime import timedelta
    from orc.util import utc_now
    dispatcher.now = lambda: utc_now() + timedelta(seconds=600)
    dispatcher.tick()
    assert repo.get_task(t.id).blocker == Blocker.NEEDS_INPUT


# ---------- false waits: the daemon heuristic and a live session ----------

def test_blocked_with_background_work_is_not_waiting():
    # The daemon sets `state=blocked` BY THE TEXT at the end of a turn: a line to a subagent ("please
    # improve") is indistinguishable for it from a question to a human. While the session has background
    # work, it will be woken by the subagent's report, not by the owner.
    assert not JobState("blocked", "", None, None, None, in_flight=1).waiting
    assert JobState("blocked", "", None, None, None, in_flight=0).waiting
    # tempo/needs are explicit signs of a dialog, background work does not cancel them
    assert JobState("working", "", None, None, None, tempo="blocked", in_flight=2).waiting


def test_read_state_counts_in_flight(tmp_path):
    jobs = tmp_path / "jobs"
    (jobs / "ab12cd34").mkdir(parents=True)
    (jobs / "ab12cd34" / "state.json").write_text(json.dumps({
        "state": "blocked", "detail": "please improve", "sessionId": "sid-1",
        "inFlight": {"tasks": 1, "queued": 2, "kinds": [], "drainableMonitors": 0},
    }))
    st = ClaudeCli(bin="claude", jobs_dir=jobs).read_state("ab12cd34")
    # The message queue is a separate counter: background work is only tasks + monitors
    assert st.in_flight == 1 and st.queued == 2 and not st.waiting


def _read_in_flight(tmp_path, in_flight: dict, **state) -> JobState:
    jobs = tmp_path / "jobs"
    (jobs / "ab12cd34").mkdir(parents=True, exist_ok=True)
    (jobs / "ab12cd34" / "state.json").write_text(json.dumps({
        "state": "working", "tempo": "idle", "sessionId": "sid-1", "inFlight": in_flight, **state,
    }))
    return ClaudeCli(bin="claude", jobs_dir=jobs).read_state("ab12cd34")


def test_artifact_watch_is_not_background_work(tmp_path):
    # The agent published an artifact, and the harness for the rest of the session's life
    # keeps a subscription to its comments: {tasks: 1, kinds: [artifact_watch], drainableMonitors: 1}.
    # It does not wake the session (only a human comment does), yet orc counted it as background
    # work: an end of turn with a report was not recognized, and the task hung "in progress".
    st = _read_in_flight(tmp_path, {"tasks": 1, "queued": 0, "kinds": ["artifact_watch"], "drainableMonitors": 1})
    assert st.in_flight == 0 and st.turn_ended and st.waiting


def test_real_background_work_next_to_artifact_watch_still_counts(tmp_path):
    st = _read_in_flight(tmp_path, {"tasks": 2, "queued": 0, "kinds": ["artifact_watch", "local_bash"],
                                    "drainableMonitors": 1})
    assert st.in_flight == 1 and not st.waiting
    # A monitor without `tasks` (the daemon format is a hint, not a contract) is also background work
    st = _read_in_flight(tmp_path, {"tasks": 0, "queued": 0, "kinds": [], "drainableMonitors": 1})
    assert st.in_flight == 1 and not st.waiting


def test_queued_counter_alone_does_not_hide_waiting(tmp_path):
    # The agent picked up the owner's message mid-turn (queue-operation remove,
    # reason absorbed_mid_turn), yet the daemon's `inFlight.queued` stayed at 1. A real
    # queued message is taken by the harness right after the turn: the transcript grows, and silence
    # (the dispatcher's check) will not confirm a wait. The counter alone does not cancel the wait.
    jobs = tmp_path / "jobs"
    (jobs / "ab12cd34").mkdir(parents=True)
    (jobs / "ab12cd34" / "state.json").write_text(json.dumps({
        "state": "blocked", "tempo": "blocked", "sessionId": "sid-1",
        "inFlight": {"tasks": 0, "queued": 1, "kinds": [], "drainableMonitors": 0},
    }))
    st = ClaudeCli(bin="claude", jobs_dir=jobs).read_state("ab12cd34")
    assert st.in_flight == 0 and st.queued == 1 and st.waiting


def test_idle_counts_subagent_transcripts(tmp_path):
    # Subagents write to `<session>/subagents/agent-*.jsonl`, not to the main transcript:
    # while a subagent works the main file is silent, but the session is not idle.
    main = tmp_path / "sess.jsonl"
    main.write_text("{}\n")
    _age(main, 3600)
    st = JobState("blocked", "", None, None, None, transcript_path=str(main))
    assert st.idle_sec(time.time()) >= 3600 - 5
    sub = tmp_path / "sess" / "subagents"
    sub.mkdir(parents=True)
    (sub / "agent-a1.jsonl").write_text("{}\n")
    assert st.idle_sec(time.time()) < 60


def test_blocked_session_with_subagents_keeps_working(repo, dispatcher, fake_cli, project):
    # A session with subagents ended its turn with a line to a subagent, the daemon wrote
    # blocked, and an "awaiting an answer" alert hung on the board although there was nothing to ask.
    t = started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "blocked", detail="please make one fix before review", in_flight=1)
    dispatcher.tick()
    assert repo.get_task(t.id).blocker is None
    assert not any("is waiting for reply" in e["message"] for e in repo.list_events())


def test_long_silence_overrides_stale_background_counter(repo, dispatcher, fake_cli, project, tmp_path):
    # The inFlight counters are a daemon hint, and they stick (an eternal artifact_watch, an un-drained
    # queue). Brief silence during background work is not a wait: the harness will wake it. But if
    # the session stays silent longer than IN_FLIGHT_STALE_SEC, nobody can wake it except a human.
    from orc.dispatcher import IN_FLIGHT_STALE_SEC
    transcript = tmp_path / "sess.jsonl"
    transcript.write_text("{}\n")
    _age(transcript, 600)
    t = started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "blocked", detail="Which port?", transcript_path=str(transcript), in_flight=1)
    dispatcher.tick()
    assert repo.get_task(t.id).blocker is None
    _age(transcript, IN_FLIGHT_STALE_SEC + 60)
    dispatcher.tick()
    assert repo.get_task(t.id).blocker == Blocker.NEEDS_INPUT


def test_waiting_is_confirmed_by_quiet_transcript(repo, dispatcher, fake_cli, project, tmp_path):
    # The transcript is growing: the session is working, whatever the daemon writes in state.json.
    transcript = tmp_path / "sess.jsonl"
    transcript.write_text("{}\n")
    t = started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "blocked", detail="Which port?", transcript_path=str(transcript))
    dispatcher.tick()
    assert repo.get_task(t.id).blocker is None
    # It went silent: the wait is real
    _age(transcript)
    dispatcher.tick()
    assert repo.get_task(t.id).blocker == Blocker.NEEDS_INPUT


def test_badge_drops_when_blocked_session_writes_again(repo, dispatcher, fake_cli, project, tmp_path):
    transcript = tmp_path / "sess.jsonl"
    transcript.write_text("{}\n")
    _age(transcript)
    t = started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "blocked", detail="Which port?", transcript_path=str(transcript))
    dispatcher.tick()
    assert repo.get_task(t.id).blocker == Blocker.NEEDS_INPUT
    # The session continued on its own: the daemon's `state` is still blocked, but the transcript is growing
    transcript.write_text("{}\n{}\n")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.blocker is None and t.blocker_detail is None
    assert any("resumed work on its own" in e["message"] for e in repo.list_events())


# ---------- end of turn: report versus question ----------

def _iso(ts: float) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _turn_transcript(path: Path, prompt_at: float, final_text: str) -> Path:
    """The transcript of one turn: prompt, tool call, the agent's final text."""
    entries = [
        {"type": "user", "timestamp": _iso(prompt_at), "message": {"role": "user", "content": "Task: do X"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Writing the report."}]}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Write", "input": {}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": final_text}]}},
    ]
    path.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n")
    _age(path)
    return path


def _write_report(task, mtime: float | None = None) -> Path:
    report = Path(task.worktree_path) / ".orchestrator" / "report.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({"status": "success", "summary": "done", "notes": ""}))
    if mtime is not None:
        os.utime(report, (mtime, mtime))
    return report


def test_parse_last_turn_takes_text_after_last_tool_call():
    from orc.transcript import parse_last_turn
    lines = [json.dumps(e) for e in [
        {"type": "user", "timestamp": "2026-09-24T12:00:00Z", "message": {"content": "old prompt"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "old result"}]}},
        {"type": "user", "timestamp": "2026-09-24T13:00:00Z", "message": {"content": [{"type": "text", "text": "answer"}]}},
        # a skill's service insertion, not a human line
        {"type": "user", "isMeta": True, "timestamp": "2026-09-24T13:30:00Z", "message": {"content": [{"type": "text", "text": "skill"}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "intermediate"}]}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t", "name": "Bash", "input": {}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t", "content": "ok"}]}},
        {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "subagent"}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Result, part 1"}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Result, part 2"}]}},
        "not json",
    ]]
    turn = parse_last_turn(lines)
    assert turn.final_text == "Result, part 1\n\nResult, part 2"
    assert turn.started_at == _parse_iso("2026-09-24T13:00:00Z")


def _parse_iso(raw: str) -> float:
    from datetime import datetime
    return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()


def test_blocked_turn_with_fresh_report_goes_to_verify(repo, dispatcher, fake_cli, project, tmp_path):
    # The agent handed in work with a report containing a "what I need from you" list, the daemon took it for
    # a question and wrote blocked with needs "coordinate with backend on: …". There is nothing to wait for.
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 3600, "Done.\n\nWhat I need from you: read the spec.")
    _write_report(t)
    fake_cli.set_state(t.job_id, "blocked", detail="awaiting backend alignment",
                       needs="coordinate with backend on: ETag/304 caching", transcript_path=str(transcript))
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.blocker != Blocker.NEEDS_INPUT
    assert t.status != TaskStatus.IN_PROGRESS
    assert any("ended its turn with a report" in e["message"] for e in repo.list_events())
    assert not any("is waiting for reply" in e["message"] for e in repo.list_events())


def test_report_turn_with_stuck_queue_counter_goes_to_verify(repo, dispatcher, fake_cli, project, tmp_path):
    # The owner wrote into the session mid-turn, the agent picked up the message, handed in
    # the work with a report listing decisions; the daemon wrote blocked, and `inFlight.queued` stuck at 1.
    # The dispatcher counted this as background work and stayed silent: the card was forever "in progress".
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 3600, "The spec is ready. What you decide: 1) …")
    _write_report(t)
    fake_cli.set_state(t.job_id, "blocked", detail="6 decisions needed", tempo="blocked",
                       needs="decide: 1) start date", transcript_path=str(transcript), queued=1)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status != TaskStatus.IN_PROGRESS
    assert any("ended its turn with a report" in e["message"] for e in repo.list_events())


def test_question_with_stuck_queue_counter_sets_badge(repo, dispatcher, fake_cli, project, tmp_path):
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 60, "Which port to choose?")
    fake_cli.set_state(t.job_id, "blocked", needs="port?", transcript_path=str(transcript), queued=1)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.blocker == Blocker.NEEDS_INPUT and t.blocker_detail == "Which port to choose?"


def test_fallback_badge_is_released_by_fresh_report(repo, dispatcher, fake_cli, project, tmp_path):
    # The badge is already there (set before the fix or before the report was written): the next tick clears it
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 3600, "Done.")
    fake_cli.set_state(t.job_id, "blocked", needs="coordinate with backend", transcript_path=str(transcript))
    dispatcher.tick()
    assert repo.get_task(t.id).blocker == Blocker.NEEDS_INPUT
    _write_report(repo.get_task(t.id))
    dispatcher.tick()
    assert repo.get_task(t.id).status != TaskStatus.IN_PROGRESS


def test_real_question_shows_agent_text_not_daemon_summary(repo, dispatcher, fake_cli, project, tmp_path):
    # The report from the previous pass is older than the line that opened the turn: it is a real question. On the card
    # are the agent's words in full, not the daemon's English paraphrase.
    t = started(repo, dispatcher, project)
    question = "Found two options:\n1. ETag/304\n2. Full reload\n\nWhich to choose?"
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 60, question)
    _write_report(t, mtime=time.time() - 3600)
    fake_cli.set_state(t.job_id, "blocked", needs="choose sync strategy", transcript_path=str(transcript))
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS
    assert t.blocker == Blocker.NEEDS_INPUT
    assert t.blocker_detail == question


# ---------- end of turn in Claude Code 2.1.293+: working + tempo=idle ----------
# Since 2.1.293 the daemon at the end of a background session's turn writes neither done nor blocked: state stays
# "working", and tempo becomes "idle". Tasks that had handed in a report hung "in progress".

def test_working_idle_is_end_of_turn():
    assert JobState("working", "", None, None, None, tempo="idle").turn_ended
    assert JobState("blocked", "", None, None, None).turn_ended
    assert not JobState("working", "", None, None, None, tempo="active").turn_ended
    assert JobState("working", "", None, None, None, tempo="idle").waiting
    # Background work will wake the session itself, as for blocked
    assert not JobState("working", "", None, None, None, tempo="idle", in_flight=1).waiting


def test_idle_turn_with_fresh_report_goes_to_verify(repo, dispatcher, fake_cli, project, tmp_path):
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 3600, "Everything is committed, the report is written.")
    _write_report(t)
    fake_cli.set_state(t.job_id, "working", detail="Everything is committed", tempo="idle", transcript_path=str(transcript))
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status != TaskStatus.IN_PROGRESS
    assert t.blocker != Blocker.NEEDS_INPUT
    assert any("ended its turn with a report" in e["message"] for e in repo.list_events())


def test_idle_turn_without_report_sets_badge_with_agent_text(repo, dispatcher, fake_cli, project, tmp_path):
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 60, "Which port to choose?")
    fake_cli.set_state(t.job_id, "working", tempo="idle", transcript_path=str(transcript))
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS
    assert t.blocker == Blocker.NEEDS_INPUT and t.blocker_detail == "Which port to choose?"


def test_idle_turn_with_report_from_previous_turn_sets_badge(repo, dispatcher, fake_cli, project, tmp_path):
    # The report from the previous pass is older than the line that opened the turn, so the turn ended with a question
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 60, "Which port to choose?")
    _write_report(t, mtime=time.time() - 3600)
    fake_cli.set_state(t.job_id, "working", tempo="idle", transcript_path=str(transcript))
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS
    assert t.blocker == Blocker.NEEDS_INPUT and t.blocker_detail == "Which port to choose?"
    assert not any("ended its turn with a report" in e["message"] for e in repo.list_events())


def test_idle_session_with_growing_transcript_keeps_working(repo, dispatcher, fake_cli, project, tmp_path):
    # We still require transcript silence: right after the report is written the turn may still be going
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 3600, "Done.")
    os.utime(transcript, None)
    _write_report(t)
    fake_cli.set_state(t.job_id, "working", tempo="idle", transcript_path=str(transcript))
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.blocker is None


# ---------- alarm at end of turn: ScheduleWakeup / cron ----------
# The agent sets ScheduleWakeup as a backup alarm in case the subagent notification does not
# arrive, and hands in its report before the alarm fires. The daemon keeps it in
# `inFlight: {tasks: 1, kinds: [session_cron]}`, and in /loop mode also a keepalive every
# ~20 minutes: the transcript grows, and the IN_FLIGHT_STALE_SEC ceiling is never reached.

def test_scheduled_wakeup_is_a_timer(tmp_path):
    st = _read_in_flight(tmp_path, {"tasks": 1, "queued": 0, "kinds": ["session_cron"], "drainableMonitors": 0,
                                    "wake": {"at": 1791972120000, "fires": 1, "keepalive": True}})
    # The alarm will wake the session itself: we do not count such an end of turn as waiting for a human
    assert st.in_flight == 1 and st.timers == 1 and not st.waiting
    assert st.only_timers


def test_timer_next_to_real_work_is_not_only_timers(tmp_path):
    st = _read_in_flight(tmp_path, {"tasks": 2, "queued": 0, "kinds": ["session_cron", "local_agent"]})
    assert st.in_flight == 2 and st.timers == 1 and not st.only_timers
    # An alarm mid-turn is no reason to look at the report
    st = _read_in_flight(tmp_path, {"tasks": 1, "kinds": ["session_cron"]}, tempo="active")
    assert not st.only_timers


def test_report_turn_with_pending_wakeup_goes_to_verify(repo, dispatcher, fake_cli, project, tmp_path):
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 3600, "Report written.")
    _write_report(t)
    fake_cli.set_state(t.job_id, "working", tempo="idle", transcript_path=str(transcript), in_flight=1, timers=1)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status != TaskStatus.IN_PROGRESS
    assert any("ended its turn with a report" in e["message"] for e in repo.list_events())


def test_pending_wakeup_without_report_is_not_waiting(repo, dispatcher, fake_cli, project, tmp_path):
    # The agent set an alarm itself (waiting for CI, a subagent): the harness will wake it, not the owner
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 60, "Waiting for CI, will check in 10 minutes.")
    fake_cli.set_state(t.job_id, "working", tempo="idle", transcript_path=str(transcript), in_flight=1, timers=1)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.blocker is None


def test_report_with_real_background_work_keeps_working(repo, dispatcher, fake_cli, project, tmp_path):
    # A live subagent runs next to the alarm: its report may still change the outcome
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 3600, "Report written.")
    _write_report(t)
    fake_cli.set_state(t.job_id, "working", tempo="idle", transcript_path=str(transcript), in_flight=2, timers=1)
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS


def test_scheduled_wakeup_does_not_open_a_new_turn():
    # An alarm firing is written to the transcript as a user line, but it is not a human line:
    # a report handed in before the alarm remains the report of "this turn".
    from orc.transcript import parse_last_turn
    lines = [json.dumps(e, ensure_ascii=False) for e in [
        {"type": "user", "timestamp": "2026-10-14T09:30:00Z", "turnOrigin": "human", "message": {"content": "Task"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Report written."}]}},
        {"type": "user", "timestamp": "2026-10-14T09:41:00Z", "turnOrigin": "scheduled", "scheduledTaskId": "c4f30552",
         "message": {"content": "Wait for the review result"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "The alarm fired, nothing to do."}]}},
    ]]
    turn = parse_last_turn(lines)
    assert turn.started_at == _parse_iso("2026-10-14T09:30:00Z")
    assert turn.final_text == "The alarm fired, nothing to do."


def _notification_after_report(tool_call: bool) -> list[str]:
    """The report is handed in, then a Monitor that is no longer needed sends a completion
    notification. With a tool_call the agent checked something again on the notification, without it it answered in words."""
    reaction = [
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t2", "name": "Bash", "input": {}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t2", "content": "ok"}]}},
    ] if tool_call else []
    return [json.dumps(e, ensure_ascii=False) for e in [
        {"type": "user", "timestamp": "2026-10-14T07:43:20Z", "turnOrigin": "human", "message": {"content": "Plan L"}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Write", "input": {}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Plan L is done."}]}},
        {"type": "user", "timestamp": "2026-10-14T10:30:03Z", "turnOrigin": "task_notification",
         "message": {"content": "<task-notification>Monitor \"wait login rate limit reset\"</task-notification>"}},
        *reaction,
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "The notification is no longer needed, the work is complete."}]}},
    ]]


@pytest.mark.parametrize("tool_call", [False, True])
def test_background_notification_does_not_open_a_new_turn(tool_call):
    from orc.transcript import parse_last_turn
    turn = parse_last_turn(_notification_after_report(tool_call))
    assert turn.started_at == _parse_iso("2026-10-14T07:43:20Z")
    assert turn.final_text == "The notification is no longer needed, the work is complete."


def test_owner_reply_after_notification_opens_a_new_turn():
    # A human line still starts a turn: a report before it is the previous pass's report
    from orc.transcript import parse_last_turn
    lines = _notification_after_report(False) + [json.dumps(e, ensure_ascii=False) for e in [
        {"type": "user", "timestamp": "2026-10-14T10:39:16Z", "turnOrigin": "human", "message": {"content": "finish X"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Will do."}]}},
    ]]
    assert parse_last_turn(lines).started_at == _parse_iso("2026-10-14T10:39:16Z")


def test_report_then_idle_notification_goes_to_verify(repo, dispatcher, fake_cli, project, tmp_path):
    # The report is written, then a background task notification and an answer in words: handed in, not a question
    t = started(repo, dispatcher, project)
    now = time.time()
    entries = [
        {"type": "user", "timestamp": _iso(now - 3600), "turnOrigin": "human", "message": {"content": "Task"}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Write", "input": {}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Done."}]}},
        {"type": "user", "timestamp": _iso(now - 1700), "turnOrigin": "task_notification",
         "message": {"content": "<task-notification>monitor done</task-notification>"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "The notification is no longer needed."}]}},
    ]
    path = tmp_path / "sess.jsonl"
    path.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n")
    _age(path)
    _write_report(t, mtime=now - 1800)
    fake_cli.set_state(t.job_id, "working", tempo="idle", transcript_path=str(path))
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status != TaskStatus.IN_PROGRESS and t.blocker is None


def test_message_to_idle_session_goes_through_stop(repo, dispatcher, fake_cli, project):
    # An idle session makes no tool calls: the inbox hook cannot reach it
    t = started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    dispatcher.answer(t.id, "continue")
    assert ("stop", t.job_id) in fake_cli.calls


def test_pending_owner_message_keeps_session_waiting(repo, dispatcher, fake_cli, project, tmp_path):
    # The owner has already answered, but the message has not arrived yet: the turn is not the last, the report is not the result
    t = started(repo, dispatcher, project)
    transcript = _turn_transcript(tmp_path / "sess.jsonl", time.time() - 3600, "Which port?")
    _write_report(t)
    repo.update_task(t.id, outbox_state="queued")
    fake_cli.set_state(t.job_id, "blocked", needs="port?", transcript_path=str(transcript))
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS


def test_needs_texts_are_translated():
    assert inputs.describe_needs("approve plan") == "Waiting for plan approval"
    assert inputs.describe_needs("answer: Which color? (red · blue)") == "Asks: Which color? (red · blue)"
    assert inputs.describe_needs(None, "awaiting instruction") == "awaiting instruction"
    assert inputs.describe_needs(None, None) == "session is waiting for input"
    assert inputs.kind_from_needs("approve Bash: ls") == "permission"
    assert inputs.kind_from_needs("answer: ?") == "question"
    assert inputs.kind_from_needs("approve plan") == "plan"
    assert inputs.kind_from_needs("something") is None


def test_message_to_waiting_session_goes_through_stop(repo, dispatcher, fake_cli, project):
    # A waiting session makes no tool calls: the inbox will not catch up with it, only stop + resume
    t = started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", needs="approve Bash: ls", tempo="blocked")
    dispatcher.tick()
    dispatcher.answer(t.id, "I allow it")
    assert ("stop", t.job_id) in fake_cli.calls
    assert repo.get_task(t.id).outbox_state == "stopping"


# ---------- primary channel: the hook registers the request and waits for a decision ----------

def test_session_settings_carry_input_hooks_with_task_id(repo, dispatcher, fake_cli, project):
    t = started(repo, dispatcher, project)
    settings = json.loads([c for c in fake_cli.calls if c[0] == "start_bg"][0][7])
    hooks = settings["hooks"]
    assert "PostToolUse" in hooks and "Stop" in hooks  # inbox is in place
    perm = hooks["PermissionRequest"][0]["hooks"][0]
    secret_file = Path(t.worktree_path) / ".orchestrator" / "hook-secret"
    assert perm["command"].endswith(
        f"input_hook.py --api {dispatcher.settings.api_base} --task {t.id} --secret-file {shlex.quote(str(secret_file))}")
    assert perm["timeout"] == inputs.HOOK_TIMEOUT_SEC
    assert hooks["PreToolUse"][0]["matcher"] == "AskUserQuestion|ExitPlanMode"


def test_hook_request_sets_badge_and_answer_releases_it(client, repo, dispatcher, fake_cli, project):
    t = started(repo, dispatcher, project)
    r = client.post("/api/hooks/input-requests", json={
        "task_id": t.id, "session_id": "sid", "kind": "permission", "tool_name": "Bash",
        "tool_input": {"command": "echo hi", "description": "greet"},
    }, headers=_hook(repo, t.id))
    assert r.status_code == 201, r.text
    request_id = r.json()["id"]
    assert r.json()["state"] == "open" and r.json()["tool_input"] == {"command": "echo hi", "description": "greet"}

    task = client.get(f"/api/tasks/{t.id}").json()
    assert task["blocker"] == "needs_input" and task["blocker_detail"] == "Requests permission: Bash — echo hi"
    assert task["input_request"]["id"] == request_id and task["input_request"]["kind"] == "permission"
    listed = [x for x in client.get("/api/tasks").json() if x["id"] == t.id][0]
    assert listed["input_request"]["id"] == request_id
    assert any("waiting for permission" in e["message"] for e in repo.list_events())

    # A tick with working in state.json does NOT clear the badge: the open request holds it
    fake_cli.set_state(t.job_id, "working", tempo="active")
    dispatcher.tick()
    assert repo.get_task(t.id).blocker == Blocker.NEEDS_INPUT

    r = client.post(f"/api/tasks/{t.id}/input-requests/{request_id}/answer",
                    json={"decision": {"behavior": "allow", "scope": "session"}})
    assert r.status_code == 200, r.text
    assert r.json()["blocker"] is None and r.json()["input_request"] is None
    assert r.json()["comments"][-1]["kind"] == "answer"
    assert r.json()["comments"][-1]["body"] == "Allowed until the end of the session: Bash — echo hi"

    # The hook takes the decision
    st = client.get(f"/api/hooks/input-requests/{request_id}", headers=_hook(repo, t.id)).json()
    assert st["state"] == "answered" and st["decision"] == {"behavior": "allow", "scope": "session"}
    # Cannot answer a second time
    assert client.post(f"/api/tasks/{t.id}/input-requests/{request_id}/answer",
                       json={"decision": {"behavior": "deny"}}).status_code == 400
    # The session was neither stopped nor resumed
    assert not [c for c in fake_cli.calls if c[0] in ("stop", "resume_bg")]


def test_question_answers_are_validated_per_question(client, repo, dispatcher, project):
    t = started(repo, dispatcher, project)
    questions = {"questions": [
        {"question": "Which color?", "header": "Color", "multiSelect": False,
         "options": [{"label": "red", "description": ""}, {"label": "blue", "description": ""}]},
        {"question": "Which size?", "header": "Size", "multiSelect": True,
         "options": [{"label": "S", "description": ""}, {"label": "M", "description": ""}]},
    ]}
    rid = client.post("/api/hooks/input-requests", json={
        "task_id": t.id, "kind": "question", "tool_name": "AskUserQuestion", "tool_input": questions,
    }, headers=_hook(repo, t.id)).json()["id"]
    assert repo.get_task(t.id).blocker_detail == "Asks: Which color? (red · blue); Which size? (S · M)"
    # without an answer to the second question: 400
    r = client.post(f"/api/tasks/{t.id}/input-requests/{rid}/answer", json={"decision": {"answers": {"Which color?": "blue"}}})
    assert r.status_code == 400 and "Which size?" in r.json()["detail"]
    r = client.post(f"/api/tasks/{t.id}/input-requests/{rid}/answer",
                    json={"decision": {"answers": {"Which color?": "blue", "Which size?": "S, M", "extra": "x"}}})
    assert r.status_code == 200
    assert r.json()["comments"][-1]["body"] == "Which color? → blue\nWhich size? → S, M"
    decision = client.get(f"/api/hooks/input-requests/{rid}", headers=_hook(repo, t.id)).json()["decision"]
    assert decision == {"answers": {"Which color?": "blue", "Which size?": "S, M"}}  # the extra key was dropped


def test_plan_decisions(client, repo, dispatcher, project):
    t = started(repo, dispatcher, project)
    rid = client.post("/api/hooks/input-requests", json={
        "task_id": t.id, "kind": "plan", "tool_name": "ExitPlanMode", "tool_input": {"plan": "1. do it"},
    }, headers=_hook(repo, t.id)).json()["id"]
    assert repo.get_task(t.id).blocker_detail == "Waiting for plan approval"
    r = client.post(f"/api/tasks/{t.id}/input-requests/{rid}/answer", json={"decision": {"behavior": "deny", "message": "not like that"}})
    assert r.status_code == 200 and r.json()["comments"][-1]["body"] == "Plan not approved: not like that"


def test_hook_request_is_refused_for_idle_task_and_bad_kind(client, repo, project):
    t = repo.add_task(project.id, "A", status="todo")
    repo.update_task(t.id, hook_secret="secret-a")  # the secret is issued: the hook reaches the status check
    r = client.post("/api/hooks/input-requests", json={"task_id": t.id, "kind": "permission", "tool_name": "Bash"},
                    headers=_hook(repo, t.id))
    assert r.status_code == 409
    assert client.get("/api/hooks/input-requests/999").status_code == 404
    assert client.post("/api/hooks/input-requests", json={"task_id": 999, "kind": "permission"}).status_code == 409


def test_new_request_replaces_stale_open_one(repo, dispatcher, project):
    t = started(repo, dispatcher, project)
    first = dispatcher.request_input(t.id, "permission", "Bash", {"command": "a"})
    second = dispatcher.request_input(t.id, "permission", "Bash", {"command": "b"})
    assert repo.get_input_request(first["id"])["state"] == "cancelled"
    assert repo.open_input_request(t.id)["id"] == second["id"]


def test_requests_are_cancelled_when_session_leaves(repo, dispatcher, fake_cli, project):
    t = started(repo, dispatcher, project)
    rid = dispatcher.request_input(t.id, "permission", "Bash", {"command": "a"})["id"]
    fake_cli.set_state(t.job_id, "done")
    dispatcher._sync_running()  # sync only: a full tick without report.json would return the task to work
    assert repo.get_task(t.id).status == TaskStatus.VERIFYING
    assert repo.get_input_request(rid)["state"] == "cancelled"
    assert any("input request cleared" in e["message"] for e in repo.list_events())


def test_requests_are_cancelled_on_resume_and_force_done(repo, dispatcher, fake_cli, project):
    t = started(repo, dispatcher, project)
    rid = dispatcher.request_input(t.id, "question", "AskUserQuestion", {"questions": []})["id"]
    # The owner writes text bypassing the request → stop + resume: the old request is no longer needed by anyone
    fake_cli.stop_marks_stopped = True
    dispatcher.answer(t.id, "do it this way", mode="interrupt")
    assert repo.get_input_request(rid)["state"] == "cancelled"
    assert repo.get_task(t.id).blocker is None

    rid2 = dispatcher.request_input(t.id, "permission", "Bash", {"command": "x"})["id"]
    dispatcher.force_done(t.id)
    assert repo.get_input_request(rid2)["state"] == "cancelled"


def test_answer_to_foreign_request_is_refused(repo, dispatcher, project):
    a = started(repo, dispatcher, project)
    b = repo.add_task(project.id, "B", status="todo")
    dispatcher.tick()
    rid = dispatcher.request_input(a.id, "permission", "Bash", {"command": "x"})["id"]
    try:
        dispatcher.answer_input(b.id, rid, {"behavior": "allow"})
    except ValueError as e:
        assert "no such request" in str(e)
    else:
        raise AssertionError("a foreign request was accepted")


# ---------- hook script: what it answers to Claude Code ----------

def test_hook_output_permission_allow_once_and_session():
    data = {"tool_name": "Bash", "tool_input": {"command": "ls"}}
    out = input_hook.build_output("permission", data, {"behavior": "allow", "scope": "once"})
    assert out == {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                                          "decision": {"behavior": "allow", "updatedInput": {"command": "ls"}}}}
    out = input_hook.build_output("permission", data, {"behavior": "allow", "scope": "session"})
    assert out["hookSpecificOutput"]["decision"]["updatedPermissions"] == [{
        "type": "addRules", "behavior": "allow", "destination": "session", "rules": [{"toolName": "Bash"}],
    }]
    out = input_hook.build_output("permission", data, {"behavior": "deny", "message": "no need"})
    assert out["hookSpecificOutput"]["decision"] == {"behavior": "deny", "message": "no need"}
    assert input_hook.build_output("permission", data, {}) is None


def test_hook_output_question_and_plan():
    data = {"tool_name": "AskUserQuestion", "tool_input": {"questions": [{"question": "Color?", "options": []}]}}
    out = input_hook.build_output("question", data, {"answers": {"Color?": "blue"}})
    assert out == {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "allow",
        "updatedInput": {"questions": [{"question": "Color?", "options": []}], "answers": {"Color?": "blue"}},
    }}
    plan = {"tool_name": "ExitPlanMode", "tool_input": {"plan": "p"}}
    assert input_hook.build_output("plan", plan, {"behavior": "allow"})["hookSpecificOutput"]["permissionDecision"] == "allow"
    denied = input_hook.build_output("plan", plan, {"behavior": "deny", "message": "fix it"})["hookSpecificOutput"]
    assert denied["permissionDecision"] == "deny" and denied["permissionDecisionReason"] == "fix it"


def test_hook_kind_detection_matches_orc():
    for event, tool in (("PermissionRequest", "Bash"), ("PreToolUse", "AskUserQuestion"),
                        ("PreToolUse", "ExitPlanMode"), ("PreToolUse", "Bash"), ("PostToolUse", "Bash")):
        assert input_hook.kind_for(event, tool) == inputs.kind_for(event, tool)
    assert inputs.kind_for("PreToolUse", "Bash") is None


# ---------- hooks survive a resume ----------

def test_resume_of_finished_session_passes_hooks_again(repo, dispatcher, fake_cli, project):
    # A done/failed session is still "running" for the daemon: a resume creates a copy without the saved
    # options, and the hooks would have to be handed out again. A stopped one is woken by the daemon itself.
    t = started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "failed", detail="TypeError")
    dispatcher.tick()
    call = [c for c in fake_cli.calls if c[0] == "resume_bg"][-1]
    assert call[4] is not None and "PermissionRequest" in call[4]

    t = repo.get_task(t.id)
    fake_cli.stop_marks_stopped = True
    dispatcher.answer(t.id, "stop", mode="interrupt")
    call = [c for c in fake_cli.calls if c[0] == "resume_bg"][-1]
    assert call[3] == "stop" and call[4] is None
