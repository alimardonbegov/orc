"""Typing into a live session: the driver on a real pseudo-terminal, the receipt, the channel choice."""
import json
import os
import stat
import sys
import textwrap
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from orc import inbox, session_input, transcript
from orc.claude_cli import ClaudeCli, ClaudeCliError
from orc.models import Blocker, TaskStatus

pytest.importorskip("pty")


# ---------- what is typed ----------

@pytest.mark.parametrize("raw", ["/compact now", "!rm -rf x", "#note", "&later"])
def test_mode_prefixes_stay_plain_text(raw):
    assert session_input.prepare_text(raw) == f" {raw}"


def test_prepare_text_cannot_inject_keys():
    # A raw ESC in the body would act as a key press and interrupt the agent, a CR would submit half a message
    clean = session_input.prepare_text("one\x1b[201~\r\ntwo\rthree\tfour\x07")
    assert "\x1b" not in clean and "\x07" not in clean and "\r" not in clean
    assert clean == "one[201~\ntwo\nthree  four"


def test_backslash_at_a_line_end_survives_the_input_box():
    # Backslash + Enter is a line break, and the box eats a backslash in front of one
    assert session_input.prepare_text("use C:\\temp\\") == "use C:\\temp\\ "
    assert session_input.prepare_text("a\\\nb c\\d") == "a\\ \nb c\\d"


def test_line_breaks_are_typed_as_alt_enter_and_characters_are_not_split():
    text = "строка один 🙂 " * 10 + "\nвторая"
    chunks = session_input.keystrokes(text)
    assert b"".join(chunks).decode().replace(session_input.LINE_BREAK, "\n") == text
    for chunk in chunks:
        chunk.decode()  # a chunk that ends in the middle of a character would raise


# ---------- the driver on a real pseudo-terminal ----------

@pytest.fixture
def fake_client(tmp_path):
    """Plays `claude attach`: draws the input marker and records the raw keys it gets. Knows nothing of orc."""
    keys = tmp_path / "keys.bin"
    script = tmp_path / "claude-fake"
    script.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import os, select, sys, tty
        assert sys.argv[1:3] == ["attach", "job1"], sys.argv
        assert os.isatty(0)
        tty.setraw(0)
        os.write(1, b"\\x1b[2Jhello \\xe2\\x9d\\xaf ")
        while True:
            ready, _, _ = select.select([0], [], [], 20)
            if not ready:
                break
            data = os.read(0, 4096)
            if not data:
                break
            with open({str(keys)!r}, "ab") as f:
                f.write(data)
        """))
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script, keys


def test_driver_types_the_message_and_submits_only_once_confirmed(fake_client):
    script, keys = fake_client
    received = session_input.type_message(str(script), "job1", "/first\nвторая строка", False,
                                          lambda: keys.exists() and keys.read_bytes().endswith(b"\r"))
    assert received is True
    assert keys.read_bytes() == " /first\x1b\rвторая строка\r".encode()


def test_driver_presses_esc_before_the_text_when_interrupting(fake_client):
    script, keys = fake_client
    session_input.type_message(str(script), "job1", "hi", True,
                               lambda: keys.exists() and keys.read_bytes().endswith(b"\r"))
    assert keys.read_bytes() == b"\x1bhi\r"


def test_driver_without_a_receipt_says_so_and_empties_the_box(fake_client, monkeypatch):
    # Unsubmitted text outlives the client: left there, it would stick to the next message.
    script, keys = fake_client
    monkeypatch.setattr(session_input, "CONFIRM_TIMEOUT_SEC", 0.2)
    assert session_input.type_message(str(script), "job1", "hi", False, lambda: False) is False
    assert keys.read_bytes().startswith(b"hi\r\x15")


def test_driver_leaves_a_delivered_message_alone(fake_client):
    script, keys = fake_client
    session_input.type_message(str(script), "job1", "hi", False,
                               lambda: keys.exists() and keys.read_bytes().endswith(b"\r"))
    assert b"\x15" not in keys.read_bytes()


def test_clearing_keys_grow_with_the_text():
    assert len(session_input._clearing_keys("a\nb\nc")) > len(session_input._clearing_keys("abc"))
    assert len(session_input._clearing_keys("a" * 4000)) >= 4000 / session_input.TERMINAL_WRAP_CHARS


def test_interrupt_is_a_lone_esc(fake_client, monkeypatch):
    script, keys = fake_client
    monkeypatch.setattr(session_input, "INTERRUPT_LINGER_SEC", 0.3)
    session_input.press_interrupt(str(script), "job1")
    assert keys.read_bytes() == b"\x1b"


def test_client_that_exits_is_an_error_with_its_words(tmp_path):
    script = tmp_path / "claude-gone"
    script.write_text("#!/bin/sh\necho 'no such session'\nexit 1\n")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    with pytest.raises(ClaudeCliError, match="no such session"):
        ClaudeCli(bin=str(script)).send_interrupt("job1")


def test_missing_binary_is_an_error_not_a_crash():
    with pytest.raises(ClaudeCliError):
        ClaudeCli(bin="/nonexistent/claude").send_interrupt("job1")


def test_client_without_an_input_box_times_out(tmp_path, monkeypatch):
    script = tmp_path / "claude-mute"
    script.write_text("#!/bin/sh\nsleep 30\n")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(session_input, "READY_TIMEOUT_SEC", 0.3)
    started = time.monotonic()
    with pytest.raises(session_input.SessionInputError, match="input box"):
        session_input.press_interrupt(str(script), "job1")
    assert time.monotonic() - started < 10  # and the client is not left behind waiting for it


def test_client_env_is_not_nested(monkeypatch):
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "x")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "keep")
    env = session_input._client_env()
    assert "CLAUDECODE" not in env and "CLAUDE_CODE_SESSION_ID" not in env
    assert env["ANTHROPIC_API_KEY"] == "keep"


# ---------- the receipt ----------

def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _rows(path: Path, *entries) -> str:
    with path.open("a", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return str(path)


def test_receipt_sees_a_started_turn_and_a_queued_message(tmp_path):
    now = time.time()
    path = _rows(tmp_path / "t.jsonl",
                 {"type": "user", "timestamp": _iso(now), "message": {"content": "take  port\n8080"}},
                 {"type": "queue-operation", "operation": "enqueue", "timestamp": _iso(now), "content": "and fix the title"})
    assert transcript.session_received(path, "take port 8080", now - 1)
    assert transcript.session_received(path, "and fix the title", now - 1)
    assert not transcript.session_received(path, "something else", now - 1)


def test_receipt_finds_a_long_message_inside_a_wrapper(tmp_path):
    now = time.time()
    body = "line\n" * 500
    path = _rows(tmp_path / "t.jsonl", {"type": "user", "timestamp": _iso(now), "message": {
        "content": f'\n\n<pasted_content id="aa">\n{body}\n</pasted_content id="aa">\n'}})
    assert transcript.session_received(path, body, now - 1)


def test_receipt_does_not_take_a_short_reply_for_a_part_of_another_row(tmp_path):
    # "да" is inside "задача": without the whole-text match this reply would count as delivered and never be typed
    now = time.time()
    path = _rows(tmp_path / "t.jsonl",
                 {"type": "user", "origin": {"kind": "task-notification"}, "timestamp": _iso(now),
                  "message": {"content": "<task-notification>задача готова</task-notification>"}},
                 {"type": "queue-operation", "operation": "enqueue", "timestamp": _iso(now),
                  "content": "<task-notification>задача готова</task-notification>"})
    assert not transcript.session_received(path, "да", now - 1)


def test_receipt_ignores_older_rows_tool_output_and_subagents(tmp_path):
    now = time.time()
    path = _rows(tmp_path / "t.jsonl",
                 {"type": "user", "timestamp": _iso(now - 3600), "message": {"content": "old text"}},
                 {"type": "user", "timestamp": _iso(now), "message": {"content": [
                     {"type": "tool_result", "tool_use_id": "t", "content": "tool text"}]}},
                 {"type": "user", "isSidechain": True, "timestamp": _iso(now), "message": {"content": "side text"}},
                 {"type": "queue-operation", "operation": "dequeue", "timestamp": _iso(now), "content": "gone text"})
    for text in ("old text", "tool text", "side text", "gone text"):
        assert not transcript.session_received(path, text, now - 1), text


def test_receipt_tolerates_the_box_adjusting_punctuation(tmp_path):
    # Otherwise a message that did arrive would be typed again
    now = time.time()
    path = _rows(tmp_path / "t.jsonl", {"type": "user", "timestamp": _iso(now), "message": {"content": "use C: temp \nnow"}})
    assert transcript.session_received(path, "use C:\\temp\\ \nnow", now - 1)


def test_receipt_of_a_message_with_no_letters(tmp_path):
    now = time.time()
    path = _rows(tmp_path / "t.jsonl", {"type": "user", "timestamp": _iso(now), "message": {"content": "???"}})
    assert transcript.session_received(path, "???", now - 1)
    assert not transcript.session_received(path, "!!!", now - 1)


def test_receipt_survives_a_missing_file_and_empty_text(tmp_path):
    assert not transcript.session_received(str(tmp_path / "none.jsonl"), "x", 0)
    assert not transcript.session_received(None, "x", 0)
    assert not transcript.session_received(str(tmp_path / "none.jsonl"), "  ", 0)


# ---------- choosing the channel ----------

def _started(repo, dispatcher, fake_cli, project, tmp_path, **state):
    """A live session with a transcript. `on_typed` plays the session that receives what was typed."""
    task = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    task = repo.get_task(task.id)
    path = tmp_path / "session.jsonl"
    path.write_text("")
    fake_cli.set_state(task.job_id, state.pop("state", "working"), tempo=state.pop("tempo", "active"),
                       transcript_path=str(path), **state)
    fake_cli.on_typed = lambda job, text, interrupt: _rows(path, {
        "type": "user", "timestamp": _iso(time.time()), "message": {"content": text}})
    return task


def _touched_the_process(fake_cli):
    return [c for c in fake_cli.calls if c[0] in ("stop", "resume_bg")]


def test_a_message_is_typed_into_a_busy_session_and_nothing_else_happens(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    dispatcher.answer(task.id, "use port 8080")
    assert fake_cli.typed == [(task.job_id, "use port 8080", False)]
    assert not _touched_the_process(fake_cli)  # no stop, no copy: the job and its background work stay
    fresh = repo.get_task(task.id)
    assert fresh.job_id == task.job_id and fresh.outbox_state is None
    assert [m["state"] for m in repo.list_messages(task.id)] == ["delivered"]


def test_idle_session_with_subagents_gets_the_message_at_once(repo, dispatcher, fake_cli, project, tmp_path):
    # The case behind this channel: the main thread is idle and subagents work. There are no tool calls for
    # a hook to ride on, and a stop would kill the subagents. The message used to wait for all of them.
    task = _started(repo, dispatcher, fake_cli, project, tmp_path, tempo="idle", in_flight=4)
    dispatcher.answer(task.id, "fix the tap")
    assert fake_cli.typed[-1] == (task.job_id, "fix the tap", False)
    assert not _touched_the_process(fake_cli)
    assert not inbox.pending_ids(Path(task.worktree_path))


def test_interrupt_mode_presses_esc(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    dispatcher.answer(task.id, "stop that", mode="interrupt")
    assert fake_cli.typed[-1] == (task.job_id, "stop that", True)
    assert not _touched_the_process(fake_cli)


@pytest.mark.parametrize("state", [{"tempo": "blocked"}, {"needs": "answer: red or blue"}])
def test_open_dialog_is_closed_with_esc_first(repo, dispatcher, fake_cli, project, tmp_path, state):
    # Enter on a dialog would pick its highlighted option instead of sending the message.
    task = _started(repo, dispatcher, fake_cli, project, tmp_path, **state)
    dispatcher.answer(task.id, "neither")
    assert fake_cli.typed[-1][2] is True


def test_reply_to_a_hook_question_cancels_it_and_clears_the_badge(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    dispatcher.request_input(task.id, "question", "AskUserQuestion", {"questions": []})
    assert repo.get_task(task.id).blocker == Blocker.NEEDS_INPUT
    dispatcher.answer(task.id, "something else entirely")
    assert fake_cli.typed[-1][2] is True
    fresh = repo.get_task(task.id)
    assert fresh.blocker is None and repo.open_input_request(task.id) is None


def test_reply_to_a_waiting_session_clears_the_badge(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path, tempo="idle")
    repo.update_task(task.id, blocker=Blocker.NEEDS_INPUT, blocker_detail="which one?")
    dispatcher.answer(task.id, "the first")
    fresh = repo.get_task(task.id)
    assert fresh.blocker is None and fresh.blocker_detail is None
    assert fake_cli.typed[-1][2] is False  # the prompt is free, nothing to dismiss


def test_a_message_left_in_the_inbox_is_taken_back_before_typing(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    typed, fake_cli.on_typed = fake_cli.on_typed, None
    dispatcher.answer(task.id, "first")  # the terminal is unavailable, so it goes to the inbox
    assert inbox.pending_ids(Path(task.worktree_path))
    fake_cli.on_typed = typed
    dispatcher.deliver_messages(task.id)
    assert not inbox.pending_ids(Path(task.worktree_path))  # otherwise the hook would deliver a second copy
    assert [m["state"] for m in repo.list_messages(task.id)] == ["delivered"]


def test_several_queued_messages_go_as_one_text(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    repo.add_message(task.id, "one")
    repo.add_message(task.id, "two")
    dispatcher.deliver_messages(task.id)
    assert fake_cli.typed == [(task.job_id, "one\n\ntwo", False)]
    assert {m["state"] for m in repo.list_messages(task.id)} == {"delivered"}


def test_a_short_reply_is_typed_although_a_notification_contains_it(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    path = Path(fake_cli.read_state(task.job_id).transcript_path)
    message = repo.add_message(task.id, "да")
    repo.update_message(message["id"], state="sent")
    _rows(path, {"type": "user", "timestamp": _iso(time.time() + 1), "message": {"content": "задача готова"}})
    dispatcher.deliver_messages(task.id)
    assert fake_cli.typed == [(task.job_id, "да", False)]


def test_a_message_queued_after_an_attempt_goes_on_its_own(repo, dispatcher, fake_cli, project, tmp_path):
    # The first attempt reached the session and its receipt came late. A new message joined the queue meanwhile,
    # so the batch no longer matches the row: the first must not be typed a second time.
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    path = Path(fake_cli.read_state(task.job_id).transcript_path)
    typed, fake_cli.on_typed = fake_cli.on_typed, lambda job, text, interrupt: None
    dispatcher.answer(task.id, "first")
    repo.add_message(task.id, "second")
    _rows(path, {"type": "user", "timestamp": _iso(time.time() + 1), "message": {"content": "first"}})
    fake_cli.on_typed = typed
    dispatcher.deliver_messages(task.id)
    assert [c[1] for c in fake_cli.typed] == ["first", "second"]
    assert {m["state"] for m in repo.list_messages(task.id)} == {"delivered"}
    assert repo.get_task(task.id).outbox_state is None


def test_without_a_receipt_it_is_not_declared_delivered(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    fake_cli.on_typed = lambda job, text, interrupt: None  # keys went somewhere, the session has nothing
    dispatcher.answer(task.id, "are you there")
    message = repo.list_messages(task.id)[0]
    assert message["state"] == "sent"
    assert repo.get_task(task.id).outbox_state == "sent"


def test_late_receipt_is_picked_up_and_the_message_is_not_typed_again(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    path = Path(fake_cli.read_state(task.job_id).transcript_path)
    fake_cli.on_typed = lambda job, text, interrupt: None
    dispatcher.answer(task.id, "slow one")
    assert len(fake_cli.typed) == 1
    _rows(path, {"type": "user", "timestamp": _iso(time.time()), "message": {"content": "slow one"}})
    dispatcher.deliver_messages(task.id)
    assert len(fake_cli.typed) == 1
    assert repo.list_messages(task.id)[0]["state"] == "delivered"
    assert repo.get_task(task.id).outbox_state is None


def test_after_the_attempts_run_out_it_falls_back_to_the_inbox(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    fake_cli.on_typed = lambda job, text, interrupt: None
    dispatcher.answer(task.id, "lost in the terminal")
    for _ in range(4):
        dispatcher.deliver_messages(task.id)
    assert len(fake_cli.typed) == 3
    assert inbox.pending_ids(Path(task.worktree_path))


def test_unavailable_terminal_goes_straight_to_the_old_channels(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    fake_cli.on_typed = None
    dispatcher.answer(task.id, "by hook then")
    assert inbox.pending_ids(Path(task.worktree_path))
    assert repo.get_task(task.id).outbox_state == "sent"


def test_session_without_a_transcript_is_left_to_the_old_channels(repo, dispatcher, fake_cli, project):
    task = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    task = repo.get_task(task.id)
    fake_cli.on_typed = lambda job, text, interrupt: None
    dispatcher.answer(task.id, "no way to confirm")
    assert fake_cli.typed == []
    assert inbox.pending_ids(Path(task.worktree_path))


def test_a_stopped_session_is_resumed_not_attached(repo, dispatcher, fake_cli, project, tmp_path):
    # `claude attach` on a stopped session would open it again behind orc's back.
    task = _started(repo, dispatcher, fake_cli, project, tmp_path, state="stopped")
    dispatcher.answer(task.id, "go on")
    assert fake_cli.typed == []
    assert [c for c in fake_cli.calls if c[0] == "resume_bg"][-1][3] == "go on"


def test_a_stop_under_way_is_not_typed_into(repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    repo.add_message(task.id, "after the stop")
    repo.update_task(task.id, outbox_state="stopping")
    dispatcher.deliver_messages(task.id)
    assert fake_cli.typed == []


# ---------- interrupting ----------

def test_interrupt_keeps_the_session_and_the_task(client, repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    response = client.post(f"/api/tasks/{task.id}/interrupt")
    assert response.status_code == 200
    assert fake_cli.interrupted == [task.job_id]
    assert not _touched_the_process(fake_cli)
    fresh = repo.get_task(task.id)
    assert fresh.status == TaskStatus.IN_PROGRESS and fresh.job_id == task.job_id
    assert any("interrupted" in e["message"] for e in repo.list_events())


def test_interrupt_reaches_a_session_that_has_just_woken(client, repo, dispatcher, fake_cli, project, tmp_path):
    # Right after a wake the daemon briefly writes `running`, and the session is live all the same.
    task = _started(repo, dispatcher, fake_cli, project, tmp_path, state="running")
    assert client.post(f"/api/tasks/{task.id}/interrupt").status_code == 200
    assert fake_cli.interrupted == [task.job_id]


def test_interrupt_closes_the_request_it_cancelled(client, repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    dispatcher.request_input(task.id, "question", "AskUserQuestion", {"questions": []})
    assert client.post(f"/api/tasks/{task.id}/interrupt").status_code == 200
    assert repo.open_input_request(task.id) is None


def test_interrupt_sends_what_is_queued_without_doubling_it(client, repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    typed, fake_cli.on_typed = fake_cli.on_typed, None
    dispatcher.answer(task.id, "still in the queue")
    fake_cli.on_typed = typed
    assert client.post(f"/api/tasks/{task.id}/interrupt").status_code == 200
    assert fake_cli.typed == [(task.job_id, "still in the queue", True)]
    assert [m["state"] for m in repo.list_messages(task.id)] == ["delivered"]
    assert len([c for c in repo.list_comments(task.id) if c["kind"] == "answer"]) == 1


def test_interrupt_refuses_what_it_cannot_do(client, repo, dispatcher, fake_cli, project, tmp_path):
    assert client.post("/api/tasks/9999/interrupt").status_code == 404
    backlog = repo.add_task(project.id, "B")
    assert client.post(f"/api/tasks/{backlog.id}/interrupt").status_code == 400
    task = _started(repo, dispatcher, fake_cli, project, tmp_path, state="stopped")
    assert "not running" in client.post(f"/api/tasks/{task.id}/interrupt").json()["detail"]


def test_interrupt_reports_an_unreachable_session(client, repo, dispatcher, fake_cli, project, tmp_path):
    task = _started(repo, dispatcher, fake_cli, project, tmp_path)
    fake_cli.on_typed = None
    response = client.post(f"/api/tasks/{task.id}/interrupt")
    assert response.status_code == 400 and "could not reach" in response.json()["detail"]
    assert os.path.exists(task.worktree_path)
