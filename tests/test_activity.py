"""The activity feed: transcript parsing, cursors, stopping a session, and the API on top of them."""
import json
from pathlib import Path

from orc import activity, processes
from orc.activity import Source
from orc.models import TaskStatus


def _assistant(uuid, *blocks, **extra):
    return {"type": "assistant", "uuid": uuid, "timestamp": "2026-11-06T10:00:00Z",
            "message": {"content": list(blocks)}, **extra}


def _user(uuid, content, **extra):
    return {"type": "user", "uuid": uuid, "timestamp": "2026-11-06T10:00:01Z", "message": {"content": content}, **extra}


def _tool_use(tool_id="t1", name="Bash", **tool_input):
    return {"type": "tool_use", "id": tool_id, "name": name, "input": tool_input}


def _result(tool_id="t1", content="ok", **extra):
    return {"type": "tool_result", "tool_use_id": tool_id, "content": content, **extra}


def _write(path, *entries, partial=None):
    with open(path, "ab") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False).encode() + b"\n")
        if partial:
            f.write(partial)
    return str(path)


def _kinds(feed):
    return [e["kind"] for e in feed["events"]]


# ---------- parsing ----------


def test_parse_conversation_events(tmp_path):
    path = _write(
        tmp_path / "s.jsonl",
        _user("u1", "do the thing", turnOrigin="human"),
        _assistant("a1", {"type": "text", "text": "On it"}),
        _assistant("a2", _tool_use(command="npm  test", description="Run tests")),
        _user("u2", [_result(content=[{"type": "text", "text": "passed"}], is_error=True)]),
    )
    events = activity.read_feed([Source(1, path)])["events"]
    assert [e["kind"] for e in events] == ["prompt", "text", "tool_use", "tool_result"]
    assert events[0]["text"] == "do the thing" and events[0]["origin"] == "human"
    assert events[2]["summary"] == "npm test" and events[2]["description"] == "Run tests"
    assert events[3] | {"id": 0, "offset": 0} == {
        "kind": "tool_result", "at": "2026-11-06T10:00:01Z", "tool_use_id": "t1", "text": "passed",
        "is_error": True, "truncated": False, "id": 0, "session": 1, "offset": 0}


def test_service_lines_do_not_reach_the_feed(tmp_path):
    """api-request-blob repeats every block of the conversation: without the skip each step appears twice."""
    path = _write(
        tmp_path / "s.jsonl",
        {"type": "api-request-blob", "message": {"content": [_tool_use()]}},
        _assistant("side", {"type": "text", "text": "subagent"}, isSidechain=True),
        _user("meta", "skill text", isMeta=True),
        {"type": "permission-mode", "permissionMode": "auto"},
        _assistant("a1", {"type": "text", "text": "main"}),
    )
    assert [e["text"] for e in activity.read_feed([Source(1, path)])["events"]] == ["main"]


def test_thinking_with_text_stub_and_nothing(tmp_path):
    path = _write(
        tmp_path / "s.jsonl",
        _assistant("a1", {"type": "thinking", "thinking": "weigh options"}, thinkingDurationMs=2),
        _assistant("a2", {"type": "thinking", "thinking": "", "signature": "x"}, thinkingDurationMs=4000),
        _assistant("a3", {"type": "thinking", "thinking": "", "signature": "x"}, thinkingDurationMs=3),
        _assistant("a4", {"type": "thinking", "thinking": "", "signature": "x"}),
    )
    events = activity.read_feed([Source(1, path)])["events"]
    assert [(e["text"], e["duration_ms"]) for e in events] == [("weigh options", 2), ("", 4000)]


def test_soft_delivered_message_is_shown_and_foreign_hook_context_is_not(tmp_path):
    path = _write(
        tmp_path / "s.jsonl",
        {"type": "attachment", "uuid": "x1", "attachment": {"type": "hook_additional_context", "content": ["context of another hook"]}},
        {"type": "attachment", "uuid": "x2", "attachment": {
            "type": "hook_additional_context",
            "content": ["Message from the task owner (delivered by the orchestrator):\nfix the tests"]}},
    )
    events = activity.read_feed([Source(1, path)])["events"]
    assert [(e["origin"], e["text"]) for e in events] == [("delivered", "fix the tests")]


def test_turn_notifications_and_errors(tmp_path):
    path = _write(
        tmp_path / "s.jsonl",
        _user("u1", "<task-notification>done</task-notification>", turnOrigin="task_notification"),
        {"type": "system", "subtype": "turn_duration", "uuid": "s1", "durationMs": 5000},
        {"type": "system", "subtype": "api_error", "uuid": "s2", "error": "overloaded"},
        {"type": "system", "subtype": "stop_hook_summary", "uuid": "s3"},
    )
    events = activity.read_feed([Source(1, path)])["events"]
    assert events[0]["origin"] == "task_notification"
    assert [(e["notice"], e["level"]) for e in events[1:]] == [("turn_end", "info"), ("error", "error")]


def test_long_result_keeps_head_and_tail_and_full_text_is_available(tmp_path):
    body = "H" * 5000 + "verdict: failed"
    path = _write(tmp_path / "s.jsonl", _user("u1", [_result(content=body)]))
    event = activity.read_feed([Source(1, path)])["events"][0]
    assert event["truncated"] and event["text"].startswith("HHH") and event["text"].endswith("verdict: failed")
    assert activity.read_full_result(Source(1, path), event["offset"], "t1") == body
    assert activity.read_full_result(Source(1, path), event["offset"], "other") is None


def test_tool_summary_falls_back_to_first_string():
    assert activity.tool_summary("Read", {"file_path": "/a/b.py"}) == "/a/b.py"
    assert activity.tool_summary("mcp__x__y", {"n": 1, "topic": "cats"}) == "cats"
    assert activity.tool_summary("Bash", None) == ""


# ---------- cursors ----------


def test_poll_returns_only_what_was_appended_and_waits_for_a_whole_line(tmp_path):
    file = tmp_path / "s.jsonl"
    source = Source(7, _write(file, _assistant("a1", {"type": "text", "text": "one"})))
    first = activity.read_feed([source])
    assert _kinds(first) == ["text"] and first["cursor"].startswith("7:")

    assert activity.read_feed([source], activity.parse_cursor(first["cursor"]))["events"] == []

    line = json.dumps(_assistant("a2", {"type": "text", "text": "two"})).encode()
    _write(file, partial=line[:20])
    partial = activity.read_feed([source], activity.parse_cursor(first["cursor"]))
    assert partial["events"] == [] and partial["cursor"] == first["cursor"]

    with open(file, "ab") as f:
        f.write(line[20:] + b"\n")
    assert [e["text"] for e in activity.read_feed([source], activity.parse_cursor(first["cursor"]))["events"]] == ["two"]


def test_cursor_moves_on_to_a_newer_session(tmp_path):
    old = Source(1, _write(tmp_path / "a.jsonl", _assistant("a1", {"type": "text", "text": "old"})))
    seen = activity.read_feed([old])
    new = Source(2, _write(tmp_path / "b.jsonl", _assistant("b1", {"type": "text", "text": "new"})))
    feed = activity.read_feed([old, new], activity.parse_cursor(seen["cursor"]))
    assert [e["text"] for e in feed["events"]] == ["new"] and feed["cursor"].startswith("2:")


def test_resumed_session_rows_with_one_transcript_are_one_source(tmp_path):
    path = _write(tmp_path / "a.jsonl", _assistant("a1", {"type": "text", "text": "once"}))
    feed = activity.read_feed([Source(1, path), Source(2, path)])
    assert [e["text"] for e in feed["events"]] == ["once"]


def test_tail_and_paging_back_cover_everything_once(tmp_path):
    path = _write(tmp_path / "s.jsonl", *[_assistant(f"a{i}", {"type": "text", "text": str(i)}) for i in range(10)])
    source = Source(1, path)
    page = activity.read_feed([source], limit=4)
    assert [e["text"] for e in page["events"]] == ["6", "7", "8", "9"]
    seen = [e["text"] for e in page["events"]]
    while page["earlier"]:
        page = activity.read_feed([source], before=activity.parse_cursor(page["earlier"]), limit=4)
        seen = [e["text"] for e in page["events"]] + seen
    assert seen == [str(i) for i in range(10)]


def test_paging_back_crosses_into_the_previous_session(tmp_path):
    old = Source(1, _write(tmp_path / "a.jsonl", _assistant("a1", {"type": "text", "text": "old"})))
    new = Source(2, _write(tmp_path / "b.jsonl", _assistant("b1", {"type": "text", "text": "new"})))
    page = activity.read_feed([old, new])
    assert [e["text"] for e in page["events"]] == ["new"] and page["earlier"] == "2:0"
    earlier = activity.read_feed([old, new], before=activity.parse_cursor(page["earlier"]))
    assert [e["text"] for e in earlier["events"]] == ["old"] and earlier["earlier"] is None


def test_garbage_cursor_and_missing_file_are_not_errors(tmp_path):
    assert activity.parse_cursor("garbage") is None
    assert activity.parse_cursor("1:-5") is None
    assert activity.read_feed([]) == {"events": [], "cursor": None, "earlier": None}
    assert activity.read_feed([Source(1, str(tmp_path / "none.jsonl"))])["events"] == []


# ---------- stopping ----------


def _running(repo, dispatcher, project):
    task = repo.add_task(project.id, "A", description="work", status="todo")
    dispatcher.tick()
    return repo.get_task(task.id)


def _resumes(fake_cli):
    return [c for c in fake_cli.calls if c[0] == "resume_bg"]


def test_stop_is_not_taken_for_a_crash_by_the_next_tick(repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    fake_cli.stop_marks_stopped = True
    stopped = dispatcher.stop_session(task.id)
    assert stopped.status == TaskStatus.FAILED
    assert "stopped by the owner" in stopped.blocker_detail
    assert stopped.detail_code == "stopped_by_owner"
    assert ("stop", task.job_id) in fake_cli.calls
    dispatcher.tick()
    assert _resumes(fake_cli) == []
    assert repo.get_task(task.id).status == TaskStatus.FAILED


def test_stop_unconfirmed_by_the_daemon_still_leaves_work(repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    fake_cli.stop_marks_stopped = False
    assert dispatcher.stop_session(task.id).status == TaskStatus.FAILED
    dispatcher.tick()
    assert _resumes(fake_cli) == []


def test_stop_drops_pending_messages_and_input_requests(repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    repo.add_message(task.id, "later", mode="soft")
    dispatcher.request_input(task.id, "permission", "Bash", {"command": "ls"})
    stopped = dispatcher.stop_session(task.id)
    assert repo.pending_messages(task.id) == []
    assert repo.open_input_request(task.id) is None
    assert stopped.outbox_state is None


def test_only_a_running_task_can_be_stopped(client, repo, project):
    task = repo.add_task(project.id, "A", description="work", status="backlog")
    assert client.post(f"/api/tasks/{task.id}/stop").status_code == 400
    assert client.post("/api/tasks/99999/stop").status_code == 404


def test_resume_with_a_message_goes_to_the_session_and_the_card(client, repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    fake_cli.stop_marks_stopped = True
    assert client.post(f"/api/tasks/{task.id}/stop").json()["status"] == "failed"
    response = client.post(f"/api/tasks/{task.id}/resume", json={"message": "use the other API"})
    assert response.status_code == 200 and response.json()["status"] == "in_progress"
    # The owner's words go first; orc reminds the session to hand the work in again
    assert _resumes(fake_cli)[-1][3].startswith("use the other API\n\n")
    assert "hand it in again" in _resumes(fake_cli)[-1][3]
    assert _resumes(fake_cli)[-1][4] is not None  # the hooks travel with every resume
    assert [c["body"] for c in repo.list_comments(task.id)][-1] == "use the other API"


def test_resume_without_a_body_keeps_the_routine_text(client, repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    fake_cli.stop_marks_stopped = True
    client.post(f"/api/tasks/{task.id}/stop")
    assert client.post(f"/api/tasks/{task.id}/resume").status_code == 200
    assert "interrupted" in _resumes(fake_cli)[-1][3]


# ---------- now ----------


def _now(repo, fake_cli, task):
    return activity.task_now(repo, fake_cli, repo.get_task(task.id))


def test_phase_follows_the_session(repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    fake_cli.set_state(task.job_id, "working", detail="Running tests", tempo="active")
    now = _now(repo, fake_cli, task)
    assert (now["phase"], now["detail"], now["live"]) == ("working", "Running tests", True)
    fake_cli.set_state(task.job_id, "working", tempo="idle", in_flight=1)
    assert _now(repo, fake_cli, task)["phase"] == "background"
    fake_cli.set_state(task.job_id, "working", tempo="idle")
    assert _now(repo, fake_cli, task)["phase"] == "idle"
    fake_cli.drop_state(task.job_id)
    assert _now(repo, fake_cli, task)["phase"] == "starting"


def test_phase_names_what_it_is_stuck_on(repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    dispatcher.request_input(task.id, "permission", "Bash", {"command": "rm -rf build"})
    now = _now(repo, fake_cli, task)
    assert now["phase"] == "waiting_input" and "rm -rf build" in now["waiting_detail"]
    repo.cancel_input_requests(task.id)
    repo.update_task(task.id, blocker="needs_input", blocker_detail="which API?")
    now = _now(repo, fake_cli, task)
    assert (now["phase"], now["waiting_detail"]) == ("waiting_reply", "which API?")


def test_now_carries_the_blocker_for_the_notice_above_the_composer(repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    repo.update_task(task.id, blocker="conflict", blocker_detail="CONFLICT in app.py")
    now = _now(repo, fake_cli, task)
    assert (now["blocker"], now["blocker_detail"], now["outbox_state"]) == ("conflict", "CONFLICT in app.py", None)
    repo.update_task(task.id, blocker=None, blocker_detail=None)
    assert _now(repo, fake_cli, task)["blocker"] is None


def test_finished_task_reports_its_status_and_reads_no_state(repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    repo.update_task(task.id, status=TaskStatus.DONE)
    fake_cli.read_state_calls.clear()
    now = _now(repo, fake_cli, task)
    assert (now["phase"], now["live"]) == ("done", False)
    assert fake_cli.read_state_calls == []


def test_current_tool_is_the_last_call_without_a_result(tmp_path):
    file = tmp_path / "s.jsonl"
    path = _write(file, _assistant("a1", _tool_use("t1", command="ls")), _user("u1", [_result("t1")]))
    assert activity.current_tool(path) is None
    _write(file, _assistant("a2", _tool_use("t2", command="make build")))
    assert activity.current_tool(path)["summary"] == "make build"
    _write(file, _user("u2", [_result("t2")]))
    assert activity.current_tool(path) is None
    assert activity.current_tool(None) is None
    assert activity.current_tool(str(tmp_path / "none.jsonl")) is None


def test_current_tool_with_parallel_and_interrupted_calls(tmp_path):
    file = tmp_path / "s.jsonl"
    path = _write(file, _assistant("a1", _tool_use("long", command="sleep 100")), _assistant("a2", _tool_use("quick", command="ls")))
    assert activity.current_tool(path)["summary"] == "ls"
    _write(file, _user("u1", [_result("quick")]))
    assert activity.current_tool(path)["summary"] == "sleep 100"  # the long one is still running
    _write(file, _user("u2", "continue", turnOrigin="human"))
    assert activity.current_tool(path) is None  # it was interrupted and will never report back


def test_fan_becomes_processes_and_todos(repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    fan = (
        {"id": "a1", "kind": "agent", "label": "Review", "startedAt": 1000},
        {"id": "s1", "kind": "shell", "label": "npm test", "startedAt": 1000, "doneAt": 2000},
        {"id": "s2", "kind": "shell", "label": "build", "startedAt": 1000, "doneAt": 2000, "failed": True},
        {"id": "todo:1", "kind": "todo", "label": "first", "startedAt": 0, "doneAt": 0},
        {"id": "todo:2", "kind": "todo", "label": "second", "startedAt": 0},
        {"id": "todo:3", "kind": "todo", "label": "third"},
    )
    fake_cli.set_state(task.job_id, "working", tempo="active", fan=fan)
    now = _now(repo, fake_cli, task)
    assert [(p["id"], p["status"]) for p in now["processes"]] == [("a1", "running"), ("s1", "done"), ("s2", "failed")]
    assert [t["status"] for t in now["todos"]] == ["done", "in_progress", "pending"]


# ---------- API ----------


def test_task_activity_api_polls_and_shows_the_input_request(client, repo, dispatcher, fake_cli, project, tmp_path):
    file = tmp_path / "t.jsonl"
    fake_cli.transcript_for_new = _write(file, _assistant("a1", {"type": "text", "text": "hello"}))
    task = _running(repo, dispatcher, project)
    dispatcher.request_input(task.id, "permission", "Bash", {"command": "ls"})
    first = client.get(f"/api/tasks/{task.id}/activity").json()
    assert [e["text"] for e in first["events"]] == ["hello"]
    assert first["now"]["phase"] == "waiting_input" and first["now"]["input_request"]["tool_name"] == "Bash"
    _write(file, _assistant("a2", {"type": "text", "text": "more"}))
    second = client.get(f"/api/tasks/{task.id}/activity", params={"cursor": first["cursor"]}).json()
    assert [e["text"] for e in second["events"]] == ["more"]
    assert client.get("/api/tasks/99999/activity").status_code == 404


def test_full_result_is_found_by_session_key_not_by_a_client_path(client, repo, dispatcher, fake_cli, project, tmp_path):
    body = "x" * 9000
    fake_cli.transcript_for_new = _write(tmp_path / "t.jsonl", _user("u1", [_result(content=body)]))
    task = _running(repo, dispatcher, project)
    event = client.get(f"/api/tasks/{task.id}/activity").json()["events"][0]
    params = {"session": event["session"], "offset": event["offset"], "tool_use_id": "t1"}
    assert client.get(f"/api/tasks/{task.id}/activity/result", params=params).json()["text"] == body
    assert client.get(f"/api/tasks/{task.id}/activity/result", params={**params, "session": 424242}).status_code == 404


def test_agents_activity_lists_live_and_recent_runs(client, repo, dispatcher, fake_cli, project):
    agent = repo.add_agent("Dev")
    live = repo.add_task(project.id, "live", description="work", status="todo", agent_id=agent.id)
    dispatcher.tick()
    done = repo.add_task(project.id, "done", description="work", agent_id=agent.id)
    repo.add_task_session(done.id, "jobdone", None, None)
    repo.update_task(done.id, status=TaskStatus.DONE)
    never = repo.add_task(project.id, "never ran", description="work", agent_id=agent.id)
    repo.update_task(never.id, status=TaskStatus.FAILED)
    fake_cli.set_state(repo.get_task(live.id).job_id, "working", detail="Reading", tempo="active")
    data = client.get("/api/agents/activity").json()
    assert [(r["id"], r["now"]["phase"], r["now"]["detail"]) for r in data["runs"]] == [(live.id, "working", "Reading")]
    assert [r["id"] for r in data["recent"]] == [done.id]
    assert client.get(f"/api/agents/{agent.id}").status_code == 200  # the route below still works


def test_chat_activity_api(client, repo, tmp_path):
    agent = repo.add_agent("Dev")
    chat = repo.add_chat(agent.id, None)
    assert client.get(f"/api/chats/{chat.id}/activity").json()["events"] == []
    path = _write(tmp_path / "c.jsonl", _assistant("a1", {"type": "text", "text": "hi"}))
    repo.update_chat(chat.id, transcript_path=path, status="running")
    data = client.get(f"/api/chats/{chat.id}/activity").json()
    assert [e["text"] for e in data["events"]] == ["hi"] and data["now"]["live"] is True


# ---------- delegation ----------


def _subagent(transcript, agent_id, tool_use_id, finished, *entries):
    folder = Path(transcript).with_suffix("") / "subagents"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"agent-{agent_id}.meta.json").write_text(json.dumps(
        {"agentType": "Explore", "toolUseId": tool_use_id, "finished": finished}))
    _write(folder / f"agent-{agent_id}.jsonl", *entries)


def test_delegating_call_names_who_and_what(tmp_path):
    path = _write(tmp_path / "s.jsonl", _assistant("a1", _tool_use("t1", "Agent", description="Survey the repo", subagent_type="Explore")),
                  _assistant("a2", _tool_use("t2", "Bash", command="ls")))
    events = activity.read_feed([Source(1, path)])["events"]
    assert events[0]["delegate"] == {"agent_type": "Explore", "description": "Survey the repo"}
    assert events[1]["delegate"] is None


def test_delegations_come_from_the_meta_files_because_a_background_call_answers_at_once(tmp_path):
    path = _write(tmp_path / "s.jsonl", _assistant("a1", {"type": "text", "text": "x"}))
    _subagent(path, "abc1", "t1", False)
    _subagent(path, "abc2", "t2", True)
    found = activity.delegations([Source(1, path), Source(2, path)])
    assert [(d["tool_use_id"], d["agent_id"], d["agent_type"], d["finished"]) for d in found] == [
        ("t1", "abc1", "Explore", False), ("t2", "abc2", "Explore", True)]
    assert activity.delegations([Source(1, str(tmp_path / "none.jsonl"))]) == []


def test_a_subagent_feed_reads_its_side_chain_and_the_main_feed_does_not(tmp_path):
    path = _write(tmp_path / "s.jsonl", _assistant("a1", {"type": "text", "text": "main"}))
    _subagent(path, "abc1", "t1", False, _assistant("s1", {"type": "text", "text": "inner"}, isSidechain=True))
    sources = [Source(1, path)]
    assert [e["text"] for e in activity.read_feed(sources)["events"]] == ["main"]
    found = activity.subagent_sources(sources, "abc1")
    assert [e["text"] for e in activity.read_feed(found)["events"]] == ["inner"]


def test_an_agent_id_never_leads_out_of_the_session_folder(tmp_path):
    path = _write(tmp_path / "s.jsonl", _assistant("a1", {"type": "text", "text": "main"}))
    (tmp_path / "secret.jsonl").write_text("{}\n")
    assert activity.subagent_sources([Source(1, path)], "../../secret") == []
    assert activity.subagent_sources([Source(1, path)], "absent") == []


def test_subagent_feed_over_the_api(client, repo, dispatcher, fake_cli, project, tmp_path):
    path = _write(tmp_path / "t.jsonl", _assistant("a1", _tool_use("t1", "Agent", description="Look", subagent_type="Explore")))
    fake_cli.transcript_for_new = path
    _subagent(path, "abc1", "t1", False, _assistant("s1", {"type": "text", "text": "inner"}, isSidechain=True),
              _user("s2", [_result("t9", content="y" * 9000)], isSidechain=True))
    task = _running(repo, dispatcher, project)
    main = client.get(f"/api/tasks/{task.id}/activity").json()
    assert main["delegations"][0]["agent_id"] == "abc1"
    inner = client.get(f"/api/tasks/{task.id}/activity", params={"agent": "abc1"}).json()
    assert inner["events"][0]["text"] == "inner"
    result = inner["events"][1]
    full = client.get(f"/api/tasks/{task.id}/activity/result", params={
        "session": result["session"], "offset": result["offset"], "tool_use_id": "t9", "agent": "abc1"})
    assert full.json()["text"] == "y" * 9000
    assert client.get(f"/api/tasks/{task.id}/activity", params={"agent": "../x"}).json()["events"] == []


# ---------- the conversation around the steps ----------


def test_conversation_has_comments_with_their_delivery_and_stages_without_noise(client, repo, dispatcher, fake_cli, project):
    task = _running(repo, dispatcher, project)
    client.post(f"/api/tasks/{task.id}/comments", json={"body": "a fact", "kind": "comment"})
    client.post(f"/api/tasks/{task.id}/comments", json={"body": "use port 8080", "kind": "answer"})
    data = client.get(f"/api/tasks/{task.id}/activity").json()
    note, answer = data["comments"]
    assert (note["kind"], note["sent_text"], note["delivery"]) == ("comment", None, None)
    assert (answer["kind"], answer["sent_text"]) == ("answer", "use port 8080")
    assert answer["delivery"] in ("queued", "sent")
    assert all(not s["text"].startswith(f"#{task.id}") for s in data["stages"])
    repo.add_event(f"#{task.id}: message delivered to the session", task_id=task.id)
    repo.add_event(f"#{task.id} is waiting for reply: which port?", task_id=task.id)
    repo.add_event(f"#{task.id} sent for rework", task_id=task.id)
    stages = [s["text"] for s in client.get(f"/api/tasks/{task.id}/activity").json()["stages"]]
    assert "sent for rework" in stages and "message delivered to the session" not in stages
    assert not any("which port?" in text for text in stages)


def test_a_chat_has_no_comments_or_stages(client, repo):
    chat = repo.add_chat(repo.add_agent("Dev").id, None)
    data = client.get(f"/api/chats/{chat.id}/activity").json()
    assert data["comments"] is None and data["stages"] == []
    assert data["now"]["agent_id"] == chat.agent_id


# ---------- OS processes ----------


PS_OUTPUT = """\
    1     0 10-00:00:01  0.0  1000 /sbin/launchd
  100     1    01:02:03  1,5  2048 claude --bg --name orc#1
  101   100       00:10 90.0  4096 npm test
  102   101       00:09 80.0  8192 node jest
  200     1       05:00  0.0  1024 unrelated
"""


def test_process_tree_is_the_session_and_its_descendants():
    rows = processes.process_tree(100, run_ps=lambda: PS_OUTPUT)
    assert [(r["pid"], r["depth"]) for r in rows] == [(100, 0), (101, 1), (102, 2)]
    assert rows[0]["elapsed_sec"] == 3723 and rows[0]["cpu_pct"] == 1.5 and rows[1]["rss_kb"] == 4096


def test_reused_or_gone_pid_gives_nothing():
    assert processes.process_tree(200, run_ps=lambda: PS_OUTPUT) == []
    assert processes.process_tree(999, run_ps=lambda: PS_OUTPUT) == []


def test_etime_formats():
    assert processes.etime_seconds("00:10") == 10
    assert processes.etime_seconds("01:02:03") == 3723
    assert processes.etime_seconds("2-00:00:01") == 172801
    assert processes.etime_seconds("garbage") is None


def test_session_pid_comes_from_the_sessions_directory(tmp_path):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    (sessions / "5.json").write_text(json.dumps({"pid": 5, "sessionId": "other"}))
    (sessions / "6.json").write_text(json.dumps({"pid": 6, "sessionId": "mine"}))
    (sessions / "bad.json").write_text("{")
    assert processes.session_pid(tmp_path, "mine") == 6
    assert processes.session_pid(tmp_path, "absent") is None
    assert processes.session_pid(tmp_path, None) is None
