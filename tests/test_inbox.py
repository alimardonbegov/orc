"""Task inbox and the hook script: delivering a message to a live session without stopping it."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from orc import inbox


def run_hook(worktree, event="PostToolUse", stdin=None):
    """Run the hook script exactly the way Claude Code runs it: JSON on stdin."""
    payload = stdin if stdin is not None else json.dumps({"hook_event_name": event, "cwd": str(worktree)})
    proc = subprocess.run([sys.executable, str(inbox.HOOK_SCRIPT)], input=payload,
                          capture_output=True, text=True, timeout=30)
    return proc


def test_hook_without_messages_is_silent(tmp_path):
    proc = run_hook(tmp_path)
    assert proc.returncode == 0 and proc.stdout.strip() == ""


def test_hook_delivers_message_and_marks_it(tmp_path):
    inbox.put(tmp_path, 7, "take port 8080")
    assert inbox.pending_ids(tmp_path) == {7}

    proc = run_hook(tmp_path)

    assert proc.returncode == 0
    out = json.loads(proc.stdout)
    assert out["hookSpecificOutput"]["hookEventName"] == "PostToolUse"
    assert "take port 8080" in out["hookSpecificOutput"]["additionalContext"]
    # Delivery is confirmed by moving the file: the dispatcher reads it on the next tick
    assert inbox.pending_ids(tmp_path) == set() and inbox.delivered_ids(tmp_path) == {7}


def test_hook_delivers_every_pending_message_in_order(tmp_path):
    inbox.put(tmp_path, 1, "first")
    inbox.put(tmp_path, 2, "second")
    context = json.loads(run_hook(tmp_path).stdout)["hookSpecificOutput"]["additionalContext"]
    assert context.index("first") < context.index("second")
    assert inbox.delivered_ids(tmp_path) == {1, 2}


def test_stop_hook_blocks_finish_while_inbox_is_not_empty(tmp_path):
    # Race: "a message arrived while the agent was finishing its report": it is not allowed to finish,
    # the text goes into the same session, and only the next Stop passes freely.
    inbox.put(tmp_path, 3, "not done yet")
    out = json.loads(run_hook(tmp_path, event="Stop").stdout)
    assert out["decision"] == "block" and "not done yet" in out["reason"]
    assert run_hook(tmp_path, event="Stop").stdout.strip() == ""


def test_hook_survives_broken_input(tmp_path):
    # The hook runs on every tool call: it must not be able to crash the session
    assert run_hook(tmp_path, stdin="not json").returncode == 0
    assert run_hook(tmp_path, stdin="").returncode == 0


def test_put_is_idempotent(tmp_path):
    inbox.put(tmp_path, 5, "text")
    inbox.put(tmp_path, 5, "text")
    assert inbox.pending_ids(tmp_path) == {5}


def test_clear_removes_pending_but_keeps_delivered(tmp_path):
    inbox.put(tmp_path, 1, "goes with the resume")
    run_hook(tmp_path)
    inbox.put(tmp_path, 2, "not delivered yet")
    inbox.clear(tmp_path)
    assert inbox.pending_ids(tmp_path) == set() and inbox.delivered_ids(tmp_path) == {1}


def test_settings_json_points_at_hook_script():
    settings = json.loads(inbox.hook_settings_json())
    hooks = settings["hooks"]
    assert set(hooks) == {"PostToolUse", "Stop"}
    command = hooks["PostToolUse"][0]["hooks"][0]["command"]
    assert str(inbox.HOOK_SCRIPT) in command and inbox.HOOK_SCRIPT.exists()
    assert hooks["PostToolUse"][0]["matcher"] == "*"


# ---------- message queue in the database ----------


def test_outbox_queue_lifecycle(repo, git_repo):
    project = repo.add_project("demo", str(git_repo))
    t = repo.add_task(project.id, "A")
    m = repo.add_message(t.id, "first", mode="soft")
    assert m["state"] == "queued" and m["mode"] == "soft" and m["attempts"] == 0

    assert [x["id"] for x in repo.pending_messages(t.id)] == [m["id"]]
    assert repo.tasks_with_pending_messages() == [t.id]

    repo.update_message(m["id"], state="sent", attempts=1)
    assert repo.pending_messages(t.id)[0]["state"] == "sent"  # sent still awaits confirmation

    repo.mark_delivered(m["id"])
    assert repo.pending_messages(t.id) == [] and repo.tasks_with_pending_messages() == []
    assert repo.list_messages(t.id)[0]["delivered_at"] is not None


def test_pending_messages_keep_order_and_survive_restart(repo, git_repo, tmp_path):
    project = repo.add_project("demo", str(git_repo))
    t = repo.add_task(project.id, "A")
    first = repo.add_message(t.id, "one")
    second = repo.add_message(t.id, "two")
    assert [x["body"] for x in repo.pending_messages(t.id)] == ["one", "two"]
    # The queue lives in the database, not in process memory: a server restart does not lose it
    from orc.db import connect, init_schema
    from orc.repo import Repo
    conn = connect(tmp_path / "orc.db")
    init_schema(conn)
    assert Repo(conn) is not None
    assert first["id"] != second["id"]


def test_failed_message_leaves_queue(repo, git_repo):
    project = repo.add_project("demo", str(git_repo))
    t = repo.add_task(project.id, "A")
    m = repo.add_message(t.id, "did not arrive")
    repo.update_message(m["id"], state="failed")
    assert repo.pending_messages(t.id) == []


# ---------- delivery step in the dispatcher ----------


def started_task(repo, dispatcher, project, title="A"):
    """A task for which the dispatcher has already created a worktree and started a session."""
    t = repo.add_task(project.id, title, status="todo")
    dispatcher.tick()
    return repo.get_task(t.id)


def test_soft_message_goes_through_inbox_without_touching_the_session(repo, dispatcher, fake_cli, project):
    # Main scenario: the session is running, the message is delivered by the hook, nobody touches the session.
    t = started_task(repo, dispatcher, project)
    dispatcher.answer(t.id, "take port 8080")

    t = repo.get_task(t.id)
    assert inbox.pending_ids(Path(t.worktree_path)) == {repo.list_messages(t.id)[0]["id"]}
    assert t.outbox_state == "sent"
    # No stop and no resume: the session keeps running
    assert not [c for c in fake_cli.calls if c[0] in ("stop", "resume_bg")]
    assert repo.get_task(t.id).job_id == "job00001"


def test_delivery_is_confirmed_when_hook_moves_the_file(repo, dispatcher, fake_cli, project):
    t = started_task(repo, dispatcher, project)
    dispatcher.answer(t.id, "text")
    message_id = repo.list_messages(t.id)[0]["id"]
    worktree = Path(repo.get_task(t.id).worktree_path)

    run_hook(worktree)  # the session reached a tool call, the hook took the message
    dispatcher.tick()

    assert repo.pending_messages(t.id) == []
    assert repo.list_messages(t.id)[0]["state"] == "delivered"
    assert repo.get_task(t.id).outbox_state is None
    assert inbox.delivered_ids(worktree) == {message_id}
    assert any("delivered" in e["message"] for e in repo.list_events())


def test_blocked_session_is_stopped_first_and_resumed_only_after_confirmation(repo, dispatcher, fake_cli, project):
    # A session waiting for an answer makes no tool calls, so the hook cannot reach it,
    # so the only path here is stop + resume. The resume must wait for confirmation.
    t = started_task(repo, dispatcher, project)
    fake_cli.set_state("job00001", "blocked", needs="Which port?")
    dispatcher.tick()

    dispatcher.answer(t.id, "8080")  # the daemon gives no confirmation: stop_marks_stopped is off
    assert ("stop", "job00001") in fake_cli.calls
    assert not [c for c in fake_cli.calls if c[0] == "resume_bg"]  # we do not resume blindly
    assert repo.get_task(t.id).outbox_state == "stopping"

    fake_cli.set_state("job00001", "stopped")  # the daemon finally confirmed
    dispatcher.tick()
    assert fake_cli.calls[-1][0] == "resume_bg" and fake_cli.calls[-1][3] == "8080"
    assert repo.pending_messages(t.id) == []


def test_interrupt_mode_stops_working_session_and_resumes_next_tick(repo, dispatcher, fake_cli, project):
    t = started_task(repo, dispatcher, project)
    dispatcher.answer(t.id, "stop, this is all wrong", mode="interrupt")

    assert ("stop", "job00001") in fake_cli.calls
    assert not [c for c in fake_cli.calls if c[0] == "resume_bg"]
    assert inbox.pending_ids(Path(repo.get_task(t.id).worktree_path)) == set()  # not via the hook

    fake_cli.set_state("job00001", "stopped")
    dispatcher.tick()
    assert fake_cli.calls[-1][0] == "resume_bg" and fake_cli.calls[-1][3] == "stop, this is all wrong"


def test_stopped_session_is_resumed_at_once_and_inbox_is_cleared(repo, dispatcher, fake_cli, project):
    t = started_task(repo, dispatcher, project)
    worktree = Path(t.worktree_path)
    inbox.put(worktree, 999, "an old message the session never picked up")
    fake_cli.set_state("job00001", "stopped")

    dispatcher.answer(t.id, "continue")

    assert fake_cli.calls[-1][0] == "resume_bg" and fake_cli.calls[-1][3] == "continue"
    # The inbox is cleaned: otherwise the hook would hand out the same thing again, as a second copy
    assert inbox.pending_ids(worktree) == set()
    assert repo.pending_messages(t.id) == []


def test_several_messages_are_delivered_in_one_resume(repo, dispatcher, fake_cli, project):
    t = started_task(repo, dispatcher, project)
    fake_cli.set_state("job00001", "stopped")
    repo.add_message(t.id, "first")
    repo.add_message(t.id, "second")
    dispatcher.tick()
    assert fake_cli.calls[-1][0] == "resume_bg"
    prompt = fake_cli.calls[-1][3]
    assert "first" in prompt and "second" in prompt
    assert [m["state"] for m in repo.list_messages(t.id)] == ["delivered", "delivered"]


def test_undelivered_message_is_marked_stalled_and_then_fails(repo, dispatcher, fake_cli, project):
    # The session is running but calls no tools, so the hook does not fire. The card must
    # honestly say that the message is pending rather than stay silent.
    from orc.dispatcher import DELIVERY_STALL_TICKS
    t = started_task(repo, dispatcher, project)
    dispatcher.answer(t.id, "hello?")
    for _ in range(DELIVERY_STALL_TICKS + 1):
        dispatcher.tick()
    assert repo.get_task(t.id).outbox_state == "stalled"
    assert any(e["level"] == "warn" and "did not pick up" in e["message"] for e in repo.list_events())
    assert repo.pending_messages(t.id)  # the message was not discarded, it can still be delivered


def test_message_fails_when_task_leaves_work(repo, dispatcher, fake_cli, project):
    t = started_task(repo, dispatcher, project)
    dispatcher.answer(t.id, "will not make it")
    repo.update_task(t.id, status="verifying")  # the session finished before the hook took the text
    dispatcher.tick()
    assert repo.list_messages(t.id)[0]["state"] == "failed"
    assert repo.get_task(t.id).outbox_state is None
    assert any("not delivered" in e["message"] for e in repo.list_events())
