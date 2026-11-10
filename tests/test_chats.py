"""Direct chats with an agent: turns over a fake CLI and a transcript on disk, the API."""
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from orc.chats import PROPOSALS_FENCE, TURN_START_GRACE_SEC, parse_turn_lines, split_proposals
from orc.models import TaskStatus

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)
STAMP = "2026-11-06T12:00:05Z"


@pytest.fixture
def clock(dispatcher):
    state = {"now": NOW}
    dispatcher.chats.now = lambda: state["now"]
    return state


@pytest.fixture
def transcript(tmp_path, fake_cli):
    path = tmp_path / "transcript.jsonl"
    path.write_text("")
    fake_cli.transcript_for_new = str(path)
    return path


@pytest.fixture
def runner(dispatcher, clock):
    return dispatcher.chats


def _reply(path: Path, text: str, stamp: str = STAMP, **extra) -> None:
    entry = {"type": "assistant", "timestamp": stamp, "message": {"content": [{"type": "text", "text": text}]}, **extra}
    with path.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def _tool(path: Path, name: str, **tool_input) -> None:
    entry = {"type": "assistant", "timestamp": STAMP,
             "message": {"content": [{"type": "tool_use", "name": name, "input": tool_input}]}}
    with path.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def _roles(repo, chat_id):
    return [(m["role"], m["body"]) for m in repo.list_chat_messages(chat_id) if m["role"] != "user"]


def _end_turn(fake_cli, repo, chat_id, **kwargs):
    fake_cli.set_state(repo.get_chat(chat_id).job_id, "working", tempo="idle", **kwargs)


@pytest.fixture
def agent(repo):
    return repo.add_agent("Ann", model="claude-haiku-4-5", effort="low", permission_mode="dontAsk", prompt="Be brief.")


@pytest.fixture
def chat(repo, agent, project):
    return repo.add_chat(agent.id, project.id)


# ---------- a turn ----------

def test_first_message_starts_session_in_a_private_worktree(repo, runner, fake_cli, chat, agent, project, git_repo, transcript):
    runner.send(chat, "hello there")
    runner.tick()
    chat = repo.get_chat(chat.id)
    assert chat.status == "running" and chat.title == "hello there"
    assert chat.branch == f"orc/chat-{chat.id}"
    assert chat.cwd == str(git_repo / ".claude" / "worktrees" / f"orc-chat-{chat.id}") and Path(chat.cwd).is_dir()
    _, cwd, prompt, name, model, effort, mode, settings = fake_cli.calls[0]
    assert cwd == chat.cwd and prompt == "hello there" and "Ann" in name
    assert (model, effort, mode) == ("claude-haiku-4-5", "low", "dontAsk")
    # the input-request hook is what lets the owner approve a permission from the chat
    assert "statusLine" in json.loads(settings) and "PermissionRequest" in json.loads(settings)["hooks"]
    persona = fake_cli.system_prompts[0][2]
    assert "Be brief." in persona and "direct chat" in persona and chat.branch in persona
    assert repo.list_chat_messages(chat.id, role="user")[0]["state"] == "sent"
    # The owner's working copy stayed on its branch
    current = subprocess.run(["git", "branch", "--show-current"], cwd=git_repo, capture_output=True, text=True)
    assert current.stdout.strip() == "main"


def test_reply_and_activity_reach_the_chat_and_the_session_is_released(repo, runner, fake_cli, chat, transcript):
    runner.send(chat, "hi")
    runner.tick()
    _tool(transcript, "Read", file_path="a.txt")
    _reply(transcript, "Sidechain noise", isSidechain=True)
    runner.tick()
    assert repo.get_chat(chat.id).status == "running"
    assert _roles(repo, chat.id) == [("activity", "Read a.txt")]
    _reply(transcript, "All good.")
    _end_turn(fake_cli, repo, chat.id)
    assert runner.tick() is False
    assert repo.get_chat(chat.id).status == "idle"
    assert _roles(repo, chat.id) == [("activity", "Read a.txt"), ("assistant", "All good.")]
    assert ("stop", repo.get_chat(chat.id).job_id) in fake_cli.calls


def test_a_half_written_line_waits_for_the_next_pass(repo, runner, fake_cli, chat, transcript):
    runner.send(chat, "hi")
    runner.tick()
    entry = json.dumps({"type": "assistant", "timestamp": STAMP, "message": {"content": [{"type": "text", "text": "Done"}]}})
    with transcript.open("a") as f:
        f.write(entry[:20])
    runner.tick()
    assert _roles(repo, chat.id) == []
    with transcript.open("a") as f:
        f.write(entry[20:] + "\n")
    runner.tick()
    assert _roles(repo, chat.id) == [("assistant", "Done")]


def test_restart_in_the_middle_of_a_turn_repeats_nothing(repo, dispatcher, fake_cli, chat, transcript, clock):
    from orc.chats import ChatRunner
    dispatcher.chats.send(chat, "hi")
    dispatcher.chats.tick()
    _reply(transcript, "One")
    dispatcher.chats.tick()
    # A new runner is what the server has after a restart: only the database carries over
    restarted = ChatRunner(repo, fake_cli, dispatcher.settings, now=lambda: clock["now"], sleep=lambda _: None)
    _reply(transcript, "Two")
    _end_turn(fake_cli, repo, chat.id)
    restarted.tick()
    assert _roles(repo, chat.id) == [("assistant", "One"), ("assistant", "Two")]


def test_stale_idle_state_does_not_end_a_turn_that_just_started(repo, runner, fake_cli, chat, transcript, clock):
    """Right after a launch state.json may still describe the previous turn."""
    runner.send(chat, "hi")
    runner.tick()
    _end_turn(fake_cli, repo, chat.id)
    runner.tick()
    assert repo.get_chat(chat.id).status == "running"
    clock["now"] = NOW + timedelta(seconds=TURN_START_GRACE_SEC + 1)
    fake_cli.set_state(repo.get_chat(chat.id).job_id, "failed", detail="boom")
    runner.tick()
    assert repo.get_chat(chat.id).status == "idle"
    assert _roles(repo, chat.id) == [("system", "boom")]


def test_second_turn_wakes_the_stopped_session_without_flags(repo, runner, fake_cli, chat, transcript):
    fake_cli.stop_marks_stopped = True
    runner.send(chat, "one")
    runner.tick()
    _reply(transcript, "r1")
    _end_turn(fake_cli, repo, chat.id)
    runner.tick()
    job = repo.get_chat(chat.id).job_id
    assert fake_cli.states[job].state == "stopped"

    fake_cli.next_ids = [job]
    runner.send(chat, "two")
    runner.tick()
    kind, cwd, session, prompt, settings = fake_cli.calls[-1]
    assert (kind, prompt, settings) == ("resume_bg", "two", None)
    assert fake_cli.system_prompts[-1][2] is None
    assert session == f"sess-{job}"


def test_gone_session_is_resumed_as_a_copy_with_its_options(repo, runner, fake_cli, chat, agent, transcript):
    repo.update_agent(agent.id, memory_enabled=1)
    runner.send(chat, "one")
    runner.tick()
    _reply(transcript, "r1")
    fake_cli.set_state(repo.get_chat(chat.id).job_id, "done")
    runner.tick()
    runner.send(chat, "two")
    runner.tick()
    kind, _, _, _, settings = fake_cli.calls[-1]
    assert kind == "resume_bg" and "autoMemoryDirectory" in json.loads(settings)
    assert "Be brief." in fake_cli.system_prompts[-1][2]


def test_history_of_a_copied_transcript_is_not_repeated(repo, runner, fake_cli, chat, transcript, tmp_path):
    runner.send(chat, "one")
    runner.tick()
    copy = tmp_path / "copy.jsonl"
    _reply(copy, "old answer", stamp="2026-11-06T10:00:00Z")
    _reply(copy, "new answer")
    fake_cli.set_state(repo.get_chat(chat.id).job_id, "working", tempo="idle", transcript_path=str(copy))
    runner.tick()
    assert _roles(repo, chat.id) == [("assistant", "new answer")]


def test_messages_sent_during_a_turn_go_together_as_the_next_one(repo, runner, fake_cli, chat, transcript):
    fake_cli.stop_marks_stopped = True
    runner.send(chat, "one")
    runner.tick()
    runner.send(chat, "two")
    runner.send(chat, "three")
    runner.tick()
    assert sum(1 for c in fake_cli.calls if c[0] in ("start_bg", "resume_bg")) == 1
    _reply(transcript, "r1")
    _end_turn(fake_cli, repo, chat.id)
    runner.tick()
    assert repo.get_chat(chat.id).status == "queued"
    runner.tick()
    assert fake_cli.calls[-1][0] == "resume_bg" and fake_cli.calls[-1][3] == "two\n\nthree"


def test_blocked_dialog_is_shown_and_a_new_message_interrupts_it(repo, runner, fake_cli, chat, transcript):
    fake_cli.stop_marks_stopped = True
    runner.send(chat, "one")
    runner.tick()
    job = repo.get_chat(chat.id).job_id
    _reply(transcript, "working on it")
    fake_cli.set_state(job, "working", tempo="blocked", needs="approve Bash")
    runner.tick()
    current = repo.get_chat(chat.id)
    assert current.status == "waiting" and current.waiting_detail == "approve Bash"

    runner.send(chat, "skip that")
    runner.tick()
    assert ("stop", job) in fake_cli.calls
    assert repo.get_chat(chat.id).status == "queued"
    runner.tick()
    assert fake_cli.calls[-1][3] == "skip that"
    assert repo.get_chat(chat.id).status == "running"


def test_background_work_keeps_the_turn_open(repo, runner, fake_cli, chat, transcript):
    runner.send(chat, "one")
    runner.tick()
    _reply(transcript, "started a build")
    _end_turn(fake_cli, repo, chat.id, in_flight=1)
    runner.tick()
    assert repo.get_chat(chat.id).status == "running"


def test_launch_failure_is_reported_and_not_retried(repo, runner, fake_cli, chat, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("no daemon")
    monkeypatch.setattr(fake_cli, "start_bg", boom)
    runner.send(chat, "hi")
    runner.tick()
    current = repo.get_chat(chat.id)
    assert current.status == "idle"
    assert _roles(repo, chat.id) == [("system", "no daemon")]
    assert repo.list_chat_messages(chat.id, role="user")[0]["state"] == "failed"


def test_untrusted_project_is_a_message_not_a_crash(repo, runner, fake_cli, chat, dispatcher):
    dispatcher.settings.claude_json_path.write_text("{}")
    runner.send(chat, "hi")
    runner.tick()
    assert repo.get_chat(chat.id).status == "idle"
    assert "does not trust" in _roles(repo, chat.id)[0][1]
    assert not any(c[0] == "start_bg" for c in fake_cli.calls)


def test_chat_without_a_project_gets_a_trusted_scratch_folder(repo, runner, fake_cli, agent, dispatcher, tmp_path):
    from orc import trust
    chat = repo.add_chat(agent.id, None)
    runner.send(chat, "hi")
    runner.tick()
    chat = repo.get_chat(chat.id)
    assert chat.status == "running" and chat.branch is None
    assert chat.cwd == str((tmp_path / "data" / "chats" / str(chat.id)).resolve())
    assert trust.is_trusted_exactly(dispatcher.settings.claude_json_path, chat.cwd)
    assert "not attached to any repository" in fake_cli.system_prompts[0][2]


def test_chat_worktree_is_recreated_from_its_branch(repo, runner, fake_cli, chat, transcript, git_repo):
    fake_cli.stop_marks_stopped = True
    runner.send(chat, "one")
    runner.tick()
    _reply(transcript, "r")
    _end_turn(fake_cli, repo, chat.id)
    runner.tick()
    cwd = repo.get_chat(chat.id).cwd
    subprocess.run(["git", "worktree", "remove", "--force", cwd], cwd=git_repo, check=True)
    runner.send(chat, "two")
    runner.tick()
    assert Path(cwd).is_dir() and repo.get_chat(chat.id).status == "running"


def test_stop_ends_the_turn_and_drops_the_queue(repo, runner, fake_cli, chat, transcript):
    runner.send(chat, "one")
    runner.tick()
    runner.send(chat, "two")
    job = repo.get_chat(chat.id).job_id
    runner.stop_turn(chat.id)
    assert ("stop", job) in fake_cli.calls and repo.get_chat(chat.id).status == "idle"
    assert repo.list_chat_messages(chat.id, role="user")[-1]["state"] == "cancelled"
    assert runner.tick() is False


def test_chat_tokens_reach_the_spending_log(repo, runner, fake_cli, chat, transcript, project):
    runner.send(chat, "one")
    runner.tick()
    entry = {"type": "assistant", "timestamp": STAMP, "sessionId": "s", "requestId": "r1",
             "message": {"id": "m1", "model": "claude-haiku-4-5",
                         "content": [{"type": "text", "text": "ok"}],
                         "usage": {"input_tokens": 100, "output_tokens": 20}}}
    with transcript.open("a") as f:
        f.write(json.dumps(entry) + "\n")
    _end_turn(fake_cli, repo, chat.id)
    runner.tick()
    entries = repo.usage_entries_since("2000-01-01T00:00:00+00:00")
    assert [(e["task_id"], e["project_id"], e["tokens"]) for e in entries] == [(None, project.id, 120)]


def test_reaper_does_not_touch_chat_sessions(repo, dispatcher, runner, fake_cli, chat, transcript):
    runner.send(chat, "one")
    runner.tick()
    job = repo.get_chat(chat.id).job_id
    dispatcher._reap_sessions()
    assert ("stop", job) not in fake_cli.calls


def test_delete_removes_folder_branch_and_session(repo, runner, fake_cli, chat, transcript, git_repo):
    runner.send(chat, "one")
    runner.tick()
    current = repo.get_chat(chat.id)
    runner.delete(chat.id)
    assert repo.get_chat(chat.id) is None and not Path(current.cwd).exists()
    branches = subprocess.run(["git", "branch", "--list", current.branch], cwd=git_repo, capture_output=True, text=True)
    assert branches.stdout.strip() == ""
    assert ("stop", current.job_id) in fake_cli.calls and ("remove", current.job_id) in fake_cli.calls
    assert repo.list_chat_messages(chat.id) == []


def test_worktrees_window_knows_chat_copies(repo, runner, fake_cli, chat, transcript, project):
    from orc import worktrees
    runner.send(chat, "one")
    runner.tick()
    item = next(i for i in worktrees.overview(repo, project, sizes=False)["items"] if i["name"] == f"orc-chat-{chat.id}")
    assert item["kind"] == "chat" and item["safe"] is False


# ---------- the lead ----------

@pytest.fixture
def lead_chat(repo, agent, project):
    repo.update_project(project.id, lead_agent_id=agent.id)
    return repo.add_chat(agent.id, project.id)


def test_lead_gets_the_board_and_the_team_every_turn(repo, runner, fake_cli, lead_chat, project):
    repo.add_agent("Bob", description="writes tests")
    repo.add_task(project.id, "Fix login", status=TaskStatus.TODO)
    done = repo.add_task(project.id, "Old", status=TaskStatus.DONE)
    runner.send(lead_chat, "what next?")
    runner.tick()
    prompt = fake_cli.calls[0][2]
    assert "Fix login" in prompt and "Bob: writes tests" in prompt and prompt.endswith("what next?")
    assert f"#{done.id}" not in prompt
    assert "lead of this project" in fake_cli.system_prompts[0][2]
    # The conversation keeps the owner's words, the context is not shown
    assert repo.list_chat_messages(lead_chat.id, role="user")[0]["body"] == "what next?"


def test_an_ordinary_agent_gets_no_lead_context(repo, runner, fake_cli, chat):
    runner.send(chat, "hi")
    runner.tick()
    assert fake_cli.calls[0][2] == "hi"
    assert "lead of this project" not in fake_cli.system_prompts[0][2]


def _proposing_reply(items, words: str = "Here is the plan.") -> str:
    block = json.dumps(items) if not isinstance(items, str) else items
    return f"{words}\n\n```{PROPOSALS_FENCE}\n{block}\n```"


def test_proposals_wait_for_the_owner_and_become_backlog_cards(repo, client, runner, fake_cli, lead_chat, project, transcript):
    bob = repo.add_agent("Bob")
    runner.send(lead_chat, "plan it")
    runner.tick()
    _reply(transcript, _proposing_reply([{"title": "Add tests", "description": "cover login", "agent": "Bob"},
                                         {"title": "Refactor", "agent": "nobody"}, {"description": "no title"}, "junk"]))
    _end_turn(fake_cli, repo, lead_chat.id)
    runner.tick()
    # Nothing reached the board without the owner
    assert repo.list_tasks(project.id) == []
    messages = client.get(f"/api/chats/{lead_chat.id}").json()["messages"]
    # The owner reads the words and the cards, not the block
    assert [m["role"] for m in messages] == ["user", "assistant", "proposal", "proposal"]
    assert messages[1]["body"] == "Here is the plan."
    proposals = messages[2:]
    assert [p["proposal"]["title"] for p in proposals] == ["Add tests", "Refactor"]

    r = client.post(f"/api/chats/{lead_chat.id}/proposals/{proposals[0]['id']}/accept")
    assert r.status_code == 201
    task = repo.get_task(r.json()["task_id"])
    assert task.status == TaskStatus.BACKLOG and task.agent_id == bob.id
    assert task.description == "cover login" and task.target_branch == "main"
    # Twice is refused, and dismiss closes the other one
    assert client.post(f"/api/chats/{lead_chat.id}/proposals/{proposals[0]['id']}/accept").status_code == 409
    assert client.post(f"/api/chats/{lead_chat.id}/proposals/{proposals[1]['id']}/dismiss").json() == {"ok": True}
    assert client.post(f"/api/chats/{lead_chat.id}/proposals/{proposals[1]['id']}/accept").status_code == 409
    messages = client.get(f"/api/chats/{lead_chat.id}").json()["messages"]
    assert [m["state"] for m in messages if m["role"] == "proposal"] == ["accepted", "dismissed"]


def test_an_agent_of_another_project_is_not_applied_from_a_proposal(repo, client, runner, fake_cli, lead_chat, project, transcript, tmp_path):
    other = repo.add_project("other", str(tmp_path))
    repo.add_agent("Alien", project_id=other.id)
    runner.send(lead_chat, "plan")
    runner.tick()
    _reply(transcript, _proposing_reply([{"title": "T", "agent": "Alien"}]))
    _end_turn(fake_cli, repo, lead_chat.id)
    runner.tick()
    proposal = repo.list_chat_messages(lead_chat.id, role="proposal")[0]
    task_id = client.post(f"/api/chats/{lead_chat.id}/proposals/{proposal['id']}/accept").json()["task_id"]
    assert repo.get_task(task_id).agent_id is None


def test_proposals_are_capped(repo, runner, fake_cli, lead_chat, transcript):
    runner.send(lead_chat, "plan")
    runner.tick()
    _reply(transcript, _proposing_reply([{"title": f"t{i}"} for i in range(25)]))
    _end_turn(fake_cli, repo, lead_chat.id)
    runner.tick()
    assert len(repo.list_chat_messages(lead_chat.id, role="proposal")) == 10
    assert any("first 10 of 25" in body for _, body in _roles(repo, lead_chat.id))


def test_a_broken_block_stays_visible_and_is_reported(repo, runner, fake_cli, lead_chat, transcript):
    runner.send(lead_chat, "plan")
    runner.tick()
    _reply(transcript, _proposing_reply("{not json"))
    _end_turn(fake_cli, repo, lead_chat.id)
    runner.tick()
    roles = _roles(repo, lead_chat.id)
    assert roles[0][0] == "assistant" and "{not json" in roles[0][1]
    assert roles[1][0] == "system" and "could not read" in roles[1][1]
    assert repo.list_chat_messages(lead_chat.id, role="proposal") == []


def test_a_reply_that_is_only_a_block_leaves_no_empty_message(repo, runner, fake_cli, lead_chat, transcript):
    runner.send(lead_chat, "plan")
    runner.tick()
    _reply(transcript, _proposing_reply([{"title": "T"}], words=""))
    _end_turn(fake_cli, repo, lead_chat.id)
    runner.tick()
    assert [role for role, _ in _roles(repo, lead_chat.id)] == ["proposal"]
    # The turn did produce something, so no "ended without a reply" complaint
    assert repo.get_chat(lead_chat.id).status == "idle"


def test_a_non_lead_chat_shows_the_block_as_plain_text(repo, runner, fake_cli, chat, transcript):
    runner.send(chat, "hi")
    runner.tick()
    _reply(transcript, _proposing_reply([{"title": "sneaky"}]))
    _end_turn(fake_cli, repo, chat.id)
    runner.tick()
    assert repo.list_chat_messages(chat.id, role="proposal") == []
    assert PROPOSALS_FENCE in _roles(repo, chat.id)[0][1]


def test_split_proposals_handles_several_blocks():
    fence = f"```{PROPOSALS_FENCE}"
    text, items, error = split_proposals(f'a\n{fence}\n[{{"title": "1"}}]\n```\nb\n{fence}\n[{{"title": "2"}}]\n```\n```py\nx\n```')
    assert [i["title"] for i in items] == ["1", "2"] and error is None
    assert "orc-tasks" not in text and "a" in text and "```py" in text
    assert split_proposals(f"{fence}\n{{}}\n```")[2] == "could not read the proposed tasks: expected a JSON array"


# ---------- API ----------

def test_chat_api_flow(client, repo, runner, fake_cli, agent, project, transcript):
    r = client.post("/api/chats", json={"agent_id": agent.id, "project_id": project.id})
    assert r.status_code == 201
    chat = r.json()
    assert chat["status"] == "idle" and "transcript_path" not in chat
    r = client.post(f"/api/chats/{chat['id']}/messages", json={"body": "  hi  "})
    assert r.status_code == 201 and r.json()["body"] == "hi" and r.json()["state"] == "queued"
    assert client.get(f"/api/chats/{chat['id']}").json()["status"] == "queued"
    runner.tick()
    _reply(transcript, "Hello!")
    _end_turn(fake_cli, repo, chat["id"])
    runner.tick()

    listed = client.get("/api/chats").json()[0]
    assert listed["last_message"] == "Hello!" and listed["unread"] == 1
    detail = client.get(f"/api/chats/{chat['id']}").json()
    assert [m["role"] for m in detail["messages"]] == ["user", "assistant"]
    last = detail["messages"][-1]["id"]
    client.post(f"/api/chats/{chat['id']}/read", json={"message_id": last})
    assert client.get("/api/chats").json()[0]["unread"] == 0
    # A stale read from another tab does not bring unread messages back
    client.post(f"/api/chats/{chat['id']}/read", json={"message_id": 0})
    assert client.get("/api/chats").json()[0]["unread"] == 0

    assert client.patch(f"/api/chats/{chat['id']}", json={"title": "Renamed"}).json()["title"] == "Renamed"
    assert client.post(f"/api/chats/{chat['id']}/stop").json()["status"] == "idle"
    assert client.delete(f"/api/chats/{chat['id']}").json() == {"deleted": chat["id"]}
    assert client.get(f"/api/chats/{chat['id']}").status_code == 404


def test_chat_api_validation(client, repo, agent, project, tmp_path):
    other = repo.add_project("other", str(tmp_path))
    inner = repo.add_agent("Inner", project_id=project.id)
    assert client.post("/api/chats", json={"agent_id": 999}).status_code == 400
    assert client.post("/api/chats", json={"agent_id": agent.id, "project_id": 999}).status_code == 400
    assert client.post("/api/chats", json={"agent_id": inner.id, "project_id": other.id}).status_code == 400
    # An internal agent's chat lands in its project even when the client did not name one
    assert client.post("/api/chats", json={"agent_id": inner.id}).json()["project_id"] == project.id
    chat = client.post("/api/chats", json={"agent_id": agent.id}).json()
    assert chat["project_id"] is None
    assert client.post(f"/api/chats/{chat['id']}/messages", json={"body": "   "}).status_code == 400
    assert client.post(f"/api/chats/{chat['id']}/proposals/999/accept").status_code == 404


def test_deleting_an_agent_removes_its_chats(client, repo, runner, fake_cli, agent, chat, transcript):
    runner.send(chat, "hi")
    runner.tick()
    cwd = repo.get_chat(chat.id).cwd
    assert client.delete(f"/api/agents/{agent.id}").status_code == 200
    assert repo.get_chat(chat.id) is None and not Path(cwd).exists()


def test_parse_turn_lines_tolerates_garbage_and_string_content():
    lines = ["not json", json.dumps(["list"]), json.dumps({"type": "user", "message": {"content": "hi"}}),
             json.dumps({"type": "assistant", "message": {"content": "plain"}}),
             json.dumps({"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "x"},
                                                                       {"type": "tool_use", "name": "Bash",
                                                                        "input": {"command": "ls   -la"}}]}})]
    assert parse_turn_lines(lines, None) == [("assistant", "plain"), ("activity", "Bash ls -la")]


def test_an_ordinary_agent_hears_about_the_board(runner, fake_cli, chat):
    runner.send(chat, "hi")
    runner.tick()
    prompt = fake_cli.system_prompts[0][2]
    assert "task guide" in prompt and "lead of this project" not in prompt


def test_a_lead_proposes_and_is_not_told_about_the_board_command(runner, fake_cli, lead_chat):
    """A lead's cards pass through the owner: the shortcut around that is exactly what it should not hear about."""
    runner.send(lead_chat, "hi")
    runner.tick()
    prompt = fake_cli.system_prompts[0][2]
    assert "task guide" not in prompt and '"depends_on"' in prompt


def _propose(repo, runner, fake_cli, chat, transcript, items):
    runner.send(chat, "plan it")
    runner.tick()
    _reply(transcript, _proposing_reply(items))
    _end_turn(fake_cli, repo, chat.id)
    runner.tick()
    return repo.list_chat_messages(chat.id, role="proposal")


def test_accepting_a_linked_proposal_brings_the_chain_with_it(repo, client, runner, fake_cli, lead_chat, project, transcript, git_repo):
    subprocess.run(["git", "branch", "dev"], cwd=git_repo, check=True, capture_output=True)
    old = repo.add_task(project.id, "Old", target_branch="dev")
    first, second, third = _propose(repo, runner, fake_cli, lead_chat, transcript, [
        {"title": "Third", "ref": "c", "depends_on": ["b"]},
        {"title": "Second", "ref": "b", "depends_on": ["a"]},
        {"title": "First", "ref": "a", "depends_on": [old.id]},
    ])
    shown = client.get(f"/api/chats/{lead_chat.id}").json()["messages"]
    assert [m["proposal"].get("waits_for") for m in shown if m["role"] == "proposal"] == [["Second"], ["First"], [f"#{old.id}"]]

    r = client.post(f"/api/chats/{lead_chat.id}/proposals/{first['id']}/accept")
    assert r.status_code == 201
    third_id, second_id, first_id = r.json()["accepted"][0], r.json()["accepted"][1], r.json()["task_id"]
    assert repo.deps_of(first_id) == [second_id] and repo.deps_of(second_id) == [third_id] and repo.deps_of(third_id) == [old.id]
    assert {repo.get_task(i).target_branch for i in (first_id, second_id, third_id)} == {"dev"}
    assert all(m["state"] == "accepted" for m in repo.list_chat_messages(lead_chat.id, role="proposal"))
    assert client.post(f"/api/chats/{lead_chat.id}/proposals/{second['id']}/accept").status_code == 409


def test_a_dismissed_step_is_not_waited_for_and_an_accepted_one_is(repo, client, runner, fake_cli, lead_chat, transcript):
    a, b, c = _propose(repo, runner, fake_cli, lead_chat, transcript, [
        {"title": "A", "ref": "a"}, {"title": "B", "ref": "b", "depends_on": ["a"]}, {"title": "C", "depends_on": ["a", "b"]},
    ])
    client.post(f"/api/chats/{lead_chat.id}/proposals/{a['id']}/dismiss")
    b_id = client.post(f"/api/chats/{lead_chat.id}/proposals/{b['id']}/accept").json()["task_id"]
    assert repo.deps_of(b_id) == []
    c_id = client.post(f"/api/chats/{lead_chat.id}/proposals/{c['id']}/accept").json()["task_id"]
    assert repo.deps_of(c_id) == [b_id]


def test_broken_links_in_a_proposal_block_leave_the_cards_and_a_note(repo, runner, fake_cli, lead_chat, transcript):
    cards = _propose(repo, runner, fake_cli, lead_chat, transcript, [
        {"title": "A", "ref": "a", "depends_on": ["b"]}, {"title": "B", "ref": "b", "depends_on": ["a"]},
        {"title": "C", "depends_on": "not a list"},
    ])
    assert len(cards) == 3 and all("depends_on_messages" not in json.loads(c["body"]) for c in cards)
    notes = [m["body"] for m in repo.list_chat_messages(lead_chat.id, role="system")]
    assert any("ring" in n for n in notes)


def test_an_unknown_link_is_dropped_with_a_note(repo, runner, fake_cli, lead_chat, transcript):
    cards = _propose(repo, runner, fake_cli, lead_chat, transcript, [{"title": "A", "ref": "a", "depends_on": ["zzz", 99999, "a"]}])
    assert "depends_on_messages" not in json.loads(cards[0]["body"])
    notes = [m["body"] for m in repo.list_chat_messages(lead_chat.id, role="system")]
    assert any("zzz" in n and "99999" in n for n in notes)


def test_pinning_and_archiving_do_not_move_the_chat_in_the_list(repo, client, chat):
    repo.add_chat_message(chat.id, "assistant", "Hi")
    before = repo.get_chat(chat.id).updated_at
    r = client.patch(f"/api/chats/{chat.id}", json={"pinned": True, "archived": True})
    assert r.status_code == 200
    body = r.json()
    assert body["pinned"] == 1 and body["archived_at"] and body["updated_at"] == before
    assert body["unread"] == 1
    r = client.patch(f"/api/chats/{chat.id}", json={"archived": False})
    assert r.json()["archived_at"] is None and r.json()["pinned"] == 1


def test_patch_needs_something_to_change_and_refuses_a_blank_title(client, chat):
    assert client.patch(f"/api/chats/{chat.id}", json={}).status_code == 400
    assert client.patch(f"/api/chats/{chat.id}", json={"title": "   "}).status_code == 400
    assert client.patch(f"/api/chats/{chat.id}", json={"title": "Plan"}).json()["title"] == "Plan"


def test_a_chat_can_be_marked_unread_again_and_all_can_be_read_at_once(repo, client, agent, chat):
    other = repo.add_chat(agent.id, None)
    for c in (chat, other):
        repo.add_chat_message(c.id, "assistant", "one")
        repo.add_chat_message(c.id, "assistant", "two")
    assert client.post("/api/chats/read-all").json() == {"chats": 2}
    assert all(c["unread"] == 0 for c in client.get("/api/chats").json())
    assert client.post(f"/api/chats/{chat.id}/unread").json()["unread"] == 1
    assert client.post("/api/chats/read-all").json() == {"chats": 1}
    empty = repo.add_chat(agent.id, None)
    assert client.post(f"/api/chats/{empty.id}/unread").status_code == 409


def test_writing_to_an_archived_chat_brings_it_back(repo, client, chat):
    client.patch(f"/api/chats/{chat.id}", json={"archived": True})
    assert client.post(f"/api/chats/{chat.id}/messages", json={"body": "again"}).status_code == 201
    assert repo.get_chat(chat.id).archived_at is None


def test_a_read_mark_never_runs_ahead_of_the_messages(repo, client, chat):
    repo.add_chat_message(chat.id, "assistant", "one")
    assert client.post(f"/api/chats/{chat.id}/read", json={"message_id": 10_000}).json()["last_read_message_id"] == 1
    repo.add_chat_message(chat.id, "assistant", "two")
    assert client.get(f"/api/chats/{chat.id}").json()["unread"] == 1
    client.post(f"/api/chats/{chat.id}/read", json={})
    assert client.get(f"/api/chats/{chat.id}").json()["unread"] == 0


# ---------- approvals: a permission the session waits on is answered from the chat ----------

def _started(repo, runner, chat, transcript):
    runner.send(chat, "run it")
    runner.tick()
    return repo.get_chat(chat.id)


def test_session_settings_carry_the_input_hook_of_the_chat(repo, runner, fake_cli, chat, transcript, dispatcher):
    _started(repo, runner, chat, transcript)
    assert repo.get_chat(chat.id).hook_secret
    settings = json.loads(fake_cli.calls[0][-1])
    command = settings["hooks"]["PermissionRequest"][0]["hooks"][0]["command"]
    assert f"--chat {chat.id}" in command and "--task" not in command


def test_request_is_a_message_and_answering_releases_the_chat(client, repo, runner, fake_cli, chat, transcript, clock):
    _started(repo, runner, chat, transcript)
    secret = repo.get_chat(chat.id).hook_secret
    posted = client.post("/api/hooks/chat-input-requests", headers={"x-orc-hook": secret}, json={
        "chat_id": chat.id, "kind": "permission", "tool_name": "Bash", "tool_input": {"command": "rm -rf x"}})
    assert posted.status_code == 201
    rid = posted.json()["id"]
    assert repo.get_chat(chat.id).status == "waiting"
    # the dashboard sees it as a message of its own
    detail = client.get(f"/api/chats/{chat.id}").json()
    request = [m for m in detail["messages"] if m["role"] == "input_request"][0]
    assert request["state"] == "open" and request["request"]["tool_name"] == "Bash"

    # the daemon also says "blocked": the open request, not the generic fallback, keeps the chat waiting
    runner.tick()
    assert repo.get_chat(chat.id).waiting_detail.startswith("Requests permission: Bash")

    answered = client.post(f"/api/chats/{chat.id}/input-requests/{rid}/answer", json={"decision": {"behavior": "allow"}})
    assert answered.status_code == 200 and answered.json()["state"] == "answered"
    assert repo.get_chat(chat.id).status == "running"
    polled = client.get(f"/api/hooks/chat-input-requests/{rid}", headers={"x-orc-hook": secret}).json()
    assert polled["state"] == "answered" and polled["decision"]["behavior"] == "allow"

    # a stale tempo=blocked right after the answer must not bring the waiting back
    fake_cli.set_state(repo.get_chat(chat.id).job_id, "working", tempo="blocked", needs="approve Bash")
    runner.tick()
    assert repo.get_chat(chat.id).status == "running"


def test_hook_with_a_wrong_secret_is_refused(client, repo, runner, chat, transcript):
    _started(repo, runner, chat, transcript)
    refused = client.post("/api/hooks/chat-input-requests", headers={"x-orc-hook": "nope"}, json={
        "chat_id": chat.id, "kind": "permission", "tool_name": "Bash", "tool_input": {}})
    assert refused.status_code == 403


def test_request_from_an_idle_chat_yields_to_the_dialog(client, repo, chat):
    repo.update_chat(chat.id, hook_secret="s")
    refused = client.post("/api/hooks/chat-input-requests", headers={"x-orc-hook": "s"}, json={
        "chat_id": chat.id, "kind": "permission", "tool_name": "Bash", "tool_input": {}})
    assert refused.status_code == 409


def test_a_new_message_cancels_the_open_request(client, repo, runner, fake_cli, chat, transcript):
    fake_cli.stop_marks_stopped = True
    _started(repo, runner, chat, transcript)
    secret = repo.get_chat(chat.id).hook_secret
    rid = client.post("/api/hooks/chat-input-requests", headers={"x-orc-hook": secret}, json={
        "chat_id": chat.id, "kind": "permission", "tool_name": "Bash", "tool_input": {"command": "ls"}}).json()["id"]
    runner.send(chat, "never mind")
    runner.tick()
    assert repo.get_chat_message(rid)["state"] == "cancelled"
    assert client.post(f"/api/chats/{chat.id}/input-requests/{rid}/answer",
                       json={"decision": {"behavior": "allow"}}).status_code == 400


def test_question_decision_is_validated(client, repo, runner, chat, transcript):
    _started(repo, runner, chat, transcript)
    secret = repo.get_chat(chat.id).hook_secret
    rid = client.post("/api/hooks/chat-input-requests", headers={"x-orc-hook": secret}, json={
        "chat_id": chat.id, "kind": "question", "tool_name": "AskUserQuestion",
        "tool_input": {"questions": [{"question": "Color?", "options": [{"label": "red"}]}]}}).json()["id"]
    assert client.post(f"/api/chats/{chat.id}/input-requests/{rid}/answer",
                       json={"decision": {"answers": {}}}).status_code == 400
    ok = client.post(f"/api/chats/{chat.id}/input-requests/{rid}/answer", json={"decision": {"answers": {"Color?": "red"}}})
    assert ok.status_code == 200
