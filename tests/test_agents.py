"""Agents: resolving run parameters, delivering the prompt and memory to a session, the API."""
import json

import pytest

from orc import agents
from orc.claude_cli import ClaudeCli
from orc.models import Agent, TaskStatus


def _agent(**fields) -> Agent:
    defaults = dict(id=1, name="Rev", description="", avatar=None, model=None, effort=None, permission_mode=None,
                    prompt="", project_id=None, memory_enabled=0, created_at="", updated_at="")
    return Agent(**{**defaults, **fields})


def _start_args(fake_cli):
    return next(c for c in fake_cli.calls if c[0] == "start_bg")


@pytest.mark.parametrize("task_value, agent_value, project_value, expected", [
    # a value an old row still holds is ignored: the card is tied to its agent and has no parameters of its own
    ("task", "agent", "project", "agent"),
    ("task", None, "project", "project"),
    (None, "agent", "project", "agent"),
    (None, None, "project", "project"),
    (None, None, None, None),
])
def test_agent_beats_project_and_the_card_has_no_say(repo, project, task_value, agent_value, project_value, expected):
    project = repo.update_project(project.id, default_model=project_value, default_effort=project_value)
    agent = _agent(model=agent_value, effort=agent_value)
    task = repo.add_task(project.id, "t", model=task_value, effort=task_value)
    params = agents.resolve_params(task, agent, project)
    assert params.model == expected and params.effort == expected


def test_permission_mode_falls_through_to_project_then_auto(repo, project):
    project = repo.update_project(project.id, default_permission_mode="dontAsk")
    task = repo.add_task(project.id, "t")
    assert agents.resolve_params(task, None, project).permission_mode == "dontAsk"
    assert agents.resolve_params(task, _agent(permission_mode="acceptEdits"), project).permission_mode == "acceptEdits"
    assert agents.resolve_params(None, _agent(), None).permission_mode == "auto"


def test_session_runs_with_agent_parameters_and_prompt(repo, dispatcher, fake_cli, project):
    agent = repo.add_agent("Rev", model="claude-haiku-4-5", effort="low", permission_mode="acceptEdits",
                           prompt="Review carefully.", description="reviewer")
    repo.add_task(project.id, "t", status=TaskStatus.TODO, description="do it", agent_id=agent.id)
    dispatcher.tick()
    _, _, _, _, model, effort, mode, _ = _start_args(fake_cli)
    assert (model, effort, mode) == ("claude-haiku-4-5", "low", "acceptEdits")
    kind, _, text = fake_cli.system_prompts[0]
    assert kind == "start_bg"
    assert 'agent "Rev"' in text and "reviewer" in text and "Review carefully." in text


def test_task_without_agent_gets_no_persona_only_the_board_note(repo, dispatcher, fake_cli, project):
    task = repo.add_task(project.id, "t", status=TaskStatus.TODO, description="do it")
    dispatcher.tick()
    text = fake_cli.system_prompts[0][2]
    assert text.startswith("Board access:") and f"card #{task.id}" in text
    assert "working as the agent" not in text


def test_unstarted_task_follows_an_edited_agent(repo, dispatcher, fake_cli, project):
    agent = repo.add_agent("Rev", model="claude-haiku-4-5")
    repo.add_task(project.id, "t", status=TaskStatus.TODO, description="do it", agent_id=agent.id)
    repo.update_agent(agent.id, model="claude-opus-5-5")
    dispatcher.tick()
    assert _start_args(fake_cli)[4] == "claude-opus-5-5"


def test_prompt_is_sent_with_every_resume(repo, dispatcher, fake_cli, project):
    """A resume is a copy, and a copy has no saved options: the persona has to travel with it."""
    agent = repo.add_agent("Rev", prompt="Review carefully.")
    repo.add_task(project.id, "t", status=TaskStatus.TODO, description="do it", agent_id=agent.id)
    dispatcher.tick()
    task = repo.list_tasks()[0]
    assert task.job_id

    dispatcher.sessions.resume(task, "more", trigger="message")
    assert fake_cli.system_prompts[-1][0] == "resume_bg"
    assert "Review carefully." in fake_cli.system_prompts[-1][2]


def test_real_cli_passes_the_prompt_flag(monkeypatch):
    seen = []
    cli = ClaudeCli()
    monkeypatch.setattr(cli, "_run", lambda args, cwd=None, timeout=None: seen.append(args) or "backgrounded · abcd1234")
    cli.start_bg("/tmp", "go", "n", append_system_prompt="PERSONA")
    assert seen[0][seen[0].index("--append-system-prompt") + 1] == "PERSONA"
    assert seen[0][-1] == "go"
    cli.resume_bg("/tmp", "sid", "go", append_system_prompt="PERSONA")
    assert seen[1][seen[1].index("--append-system-prompt") + 1] == "PERSONA"
    assert seen[1][-1] == "go"
    cli.resume_bg("/tmp", "sid", "go")
    assert "--append-system-prompt" not in seen[2]


def test_memory_directory_only_when_enabled(repo, dispatcher, fake_cli, project, tmp_path):
    plain = repo.add_agent("Plain")
    remembering = repo.add_agent("Mem", memory_enabled=1)
    for agent in (plain, remembering):
        repo.add_task(project.id, agent.name, status=TaskStatus.TODO, description="do it", agent_id=agent.id)
    repo.update_project(project.id, max_workers=5)
    dispatcher.tick()
    by_name = {c[3].split()[-1]: json.loads(c[7]) for c in fake_cli.calls if c[0] == "start_bg"}
    assert "autoMemoryDirectory" not in by_name["Plain"]
    path = by_name["Mem"]["autoMemoryDirectory"]
    assert path.startswith(str(tmp_path)) and path.endswith(f"agents/{remembering.id}/memory")
    # The directory must exist, and the other settings of the session stay
    assert (tmp_path / "data" / "agents" / str(remembering.id) / "memory").is_dir()
    assert "statusLine" in by_name["Mem"] and "hooks" in by_name["Mem"]


def test_routine_run_inherits_the_agent(repo, project):
    from datetime import datetime, timezone

    from orc import routines

    agent = repo.add_agent("Rev")
    routine = repo.add_routine(project.id, "R", description="d", schedule_kind="interval", interval_minutes=60,
                               agent_id=agent.id)
    task = routines.spawn(repo, routine, datetime(2026, 11, 6, tzinfo=timezone.utc), lambda *a: None)
    assert task.agent_id == agent.id


# ---------- API ----------

def test_agent_crud(client):
    r = client.post("/api/agents", json={"name": " Rev ", "description": "d", "model": "claude-opus-5-5",
                                         "effort": "high", "permission_mode": "dontAsk", "prompt": "p",
                                         "avatar": "🦊", "memory_enabled": True})
    assert r.status_code == 201
    a = r.json()
    assert a["name"] == "Rev" and a["memory_enabled"] is True and a["tasks"] == {"active": 0, "total": 0}
    r = client.patch(f"/api/agents/{a['id']}", json={"model": "", "prompt": "q"})
    assert r.json()["model"] is None and r.json()["prompt"] == "q" and r.json()["effort"] == "high"
    assert [x["name"] for x in client.get("/api/agents").json()] == ["Rev"]
    assert client.delete(f"/api/agents/{a['id']}").json() == {"deleted": a["id"]}
    assert client.get(f"/api/agents/{a['id']}").status_code == 404


@pytest.mark.parametrize("body", [
    {"name": "   "},
    {"name": "x" * 61},
    {"name": "A", "effort": "huge"},
    {"name": "A", "permission_mode": "plan"},
    {"name": "A", "prompt": "x" * 20_001},
    {"name": "A", "project_id": 999},
    {"name": "A", "avatar": "data:image/svg+xml;base64,AAAA"},
    {"name": "A", "avatar": "<script>"},
])
def test_agent_validation(client, body):
    assert client.post("/api/agents", json=body).status_code == 400


def test_agent_names_are_unique(client):
    assert client.post("/api/agents", json={"name": "A"}).status_code == 201
    second = client.post("/api/agents", json={"name": "B"}).json()
    assert client.post("/api/agents", json={"name": "A"}).status_code == 409
    assert client.patch(f"/api/agents/{second['id']}", json={"name": "A"}).status_code == 409


def test_avatar_image_is_accepted_within_limit(client):
    ok = "data:image/png;base64," + "A" * 100
    assert client.post("/api/agents", json={"name": "A", "avatar": ok}).json()["avatar"] == ok
    big = "data:image/png;base64," + "A" * 200_000
    assert client.post("/api/agents", json={"name": "B", "avatar": big}).status_code == 400


def test_task_and_routine_allocation_respects_scope(client, repo, project, git_repo, tmp_path):
    other_path = tmp_path / "other"
    other_path.mkdir()
    import subprocess
    subprocess.run(["git", "init", "-b", "main"], cwd=other_path, check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "i"],
                   cwd=other_path, check=True, capture_output=True)
    other = repo.add_project("other", str(other_path))
    internal = repo.add_agent("Inner", project_id=other.id)
    shared = repo.add_agent("Shared")

    r = client.post("/api/tasks", json={"project_id": project.id, "title": "t", "agent_id": internal.id})
    assert r.status_code == 400 and "internal" in r.json()["detail"]
    assert client.post("/api/tasks", json={"project_id": project.id, "title": "t", "agent_id": 999}).status_code == 400
    task = client.post("/api/tasks", json={"project_id": project.id, "title": "t", "agent_id": shared.id}).json()
    assert task["agent_id"] == shared.id
    assert client.patch(f"/api/tasks/{task['id']}", json={"agent_id": internal.id}).status_code == 400
    assert client.patch(f"/api/tasks/{task['id']}", json={"agent_id": None}).json()["agent_id"] is None

    r = client.post("/api/routines", json={"project_id": project.id, "title": "r", "description": "d",
                                           "interval_minutes": 60, "agent_id": internal.id})
    assert r.status_code == 400
    r = client.post("/api/routines", json={"project_id": project.id, "title": "r", "description": "d",
                                           "interval_minutes": 60, "agent_id": shared.id})
    assert r.json()["agent_id"] == shared.id

    names = {a["name"] for a in client.get("/api/agents", params={"project_id": project.id}).json()}
    assert names == {"Shared"}
    names = {a["name"] for a in client.get("/api/agents", params={"project_id": other.id}).json()}
    assert names == {"Shared", "Inner"}


def test_lead_must_be_usable_in_the_project(client, repo, project):
    shared = repo.add_agent("Shared")
    r = client.patch(f"/api/projects/{project.id}", json={"lead_agent_id": shared.id})
    assert r.json()["lead_agent_id"] == shared.id
    assert client.patch(f"/api/projects/{project.id}", json={"lead_agent_id": 999}).status_code == 400
    assert client.patch(f"/api/projects/{project.id}", json={"lead_agent_id": None}).json()["lead_agent_id"] is None


def test_scope_cannot_exclude_projects_that_use_the_agent(client, repo, project, tmp_path):
    other = repo.add_project("other", str(tmp_path))
    agent = repo.add_agent("A")
    repo.add_task(project.id, "t", agent_id=agent.id)
    assert client.patch(f"/api/agents/{agent.id}", json={"project_id": other.id}).status_code == 409
    assert client.patch(f"/api/agents/{agent.id}", json={"project_id": project.id}).status_code == 200


def test_a_new_agent_can_be_appointed_lead_at_once(client, repo, project):
    created = client.post("/api/agents", json={"name": "Lead", "lead_project_ids": [project.id]}).json()
    assert created["lead_project_ids"] == [project.id]
    assert repo.get_project(project.id).lead_agent_id == created["id"]
    assert client.get("/api/agents").json()[0]["lead_project_ids"] == [project.id]
    assert client.post("/api/agents", json={"name": "B", "lead_project_ids": [999]}).status_code == 400
    assert repo.find_agent_by_name("B") is None


def test_lead_set_from_the_agent_and_from_the_project_are_one_appointment(client, repo, project):
    agent = repo.add_agent("Lead")
    client.patch(f"/api/projects/{project.id}", json={"lead_agent_id": agent.id})
    assert client.get(f"/api/agents/{agent.id}").json()["lead_project_ids"] == [project.id]
    r = client.patch(f"/api/agents/{agent.id}", json={"lead_project_ids": []})
    assert r.json()["lead_project_ids"] == []
    assert repo.get_project(project.id).lead_agent_id is None


def test_an_agent_can_lead_several_projects(client, repo, project, tmp_path):
    other = repo.add_project("other", str(tmp_path))
    agent = repo.add_agent("Lead")
    r = client.patch(f"/api/agents/{agent.id}", json={"lead_project_ids": [other.id, project.id, other.id]})
    assert r.status_code == 200
    assert sorted(r.json()["lead_project_ids"]) == sorted([project.id, other.id])
    assert client.patch(f"/api/agents/{agent.id}", json={"lead_project_ids": [other.id]}).json()["lead_project_ids"] == [other.id]
    assert repo.get_project(project.id).lead_agent_id is None
    assert repo.get_project(other.id).lead_agent_id == agent.id


def test_a_patch_without_the_list_leaves_leadership_alone(client, repo, project):
    agent = repo.add_agent("Lead")
    client.patch(f"/api/projects/{project.id}", json={"lead_agent_id": agent.id})
    assert client.patch(f"/api/agents/{agent.id}", json={"description": "plans"}).json()["lead_project_ids"] == [project.id]
    assert client.patch(f"/api/agents/{agent.id}", json={"lead_project_ids": None}).status_code == 400
    assert repo.get_project(project.id).lead_agent_id == agent.id


def test_releasing_a_project_does_not_touch_another_agents_lead(client, repo, project, tmp_path):
    other = repo.add_project("other", str(tmp_path))
    first, second = repo.add_agent("First"), repo.add_agent("Second")
    repo.update_project(project.id, lead_agent_id=first.id)
    repo.update_project(other.id, lead_agent_id=second.id)
    client.patch(f"/api/agents/{first.id}", json={"lead_project_ids": []})
    assert repo.get_project(other.id).lead_agent_id == second.id


def test_taking_a_project_over_replaces_its_lead_and_is_recorded(client, repo, project):
    first, second = repo.add_agent("First"), repo.add_agent("Second")
    repo.update_project(project.id, lead_agent_id=first.id)
    assert client.patch(f"/api/agents/{second.id}", json={"lead_project_ids": [project.id]}).status_code == 200
    assert repo.get_project(project.id).lead_agent_id == second.id
    assert client.get(f"/api/agents/{first.id}").json()["lead_project_ids"] == []
    messages = [e["message"] for e in repo.list_events()]
    assert any("'Second' appointed lead" in m and "replacing 'First'" in m for m in messages)


def test_an_archived_project_takes_no_new_lead_but_keeps_its_own(client, repo, project):
    keeper, newcomer = repo.add_agent("Keeper"), repo.add_agent("Newcomer")
    repo.update_project(project.id, lead_agent_id=keeper.id, archived_at="2026-01-01T00:00:00+00:00")
    assert client.patch(f"/api/agents/{newcomer.id}", json={"lead_project_ids": [project.id]}).status_code == 400
    assert client.patch(f"/api/agents/{keeper.id}", json={"lead_project_ids": [project.id]}).status_code == 200
    assert repo.get_project(project.id).lead_agent_id == keeper.id


def test_an_internal_agent_leads_only_its_own_project(client, repo, project, tmp_path):
    other = repo.add_project("other", str(tmp_path))
    inner = repo.add_agent("Inner", project_id=project.id)
    assert client.patch(f"/api/agents/{inner.id}", json={"lead_project_ids": [other.id]}).status_code == 400
    assert client.patch(f"/api/agents/{inner.id}", json={"lead_project_ids": [project.id]}).status_code == 200
    # The check reads the scope the agent will have after this save, not the one it has now
    r = client.patch(f"/api/agents/{inner.id}", json={"project_id": None, "lead_project_ids": [other.id]})
    assert r.status_code == 200 and r.json()["lead_project_ids"] == [other.id]
    assert client.post("/api/agents", json={"name": "New", "project_id": project.id,
                                            "lead_project_ids": [other.id]}).status_code == 400


def test_narrowing_the_scope_and_releasing_the_lead_fit_in_one_save(client, repo, project, tmp_path):
    other = repo.add_project("other", str(tmp_path))
    agent = repo.add_agent("A")
    repo.update_project(other.id, lead_agent_id=agent.id)
    # Without a release the lead of another project still holds the scope back
    assert client.patch(f"/api/agents/{agent.id}", json={"project_id": project.id}).status_code == 409
    r = client.patch(f"/api/agents/{agent.id}", json={"project_id": project.id, "lead_project_ids": []})
    assert r.status_code == 200 and r.json()["project_id"] == project.id
    assert repo.get_project(other.id).lead_agent_id is None


def test_a_refused_rename_appoints_nobody(client, repo, project):
    repo.add_agent("Taken")
    agent = repo.add_agent("A")
    r = client.patch(f"/api/agents/{agent.id}", json={"name": "Taken", "lead_project_ids": [project.id]})
    assert r.status_code == 409
    assert repo.get_project(project.id).lead_agent_id is None


def test_delete_is_refused_while_work_depends_on_the_agent(client, repo, project):
    """A queued task must not quietly fall back to the project's model and lose the prompt."""
    agent = repo.add_agent("A")
    task = repo.add_task(project.id, "t", agent_id=agent.id)
    assert client.delete(f"/api/agents/{agent.id}").status_code == 409
    repo.update_task(task.id, status=TaskStatus.FAILED)
    assert client.delete(f"/api/agents/{agent.id}").status_code == 409

    repo.update_task(task.id, status=TaskStatus.DONE)
    routine = repo.add_routine(project.id, "R", agent_id=agent.id, interval_minutes=60)
    assert client.delete(f"/api/agents/{agent.id}").status_code == 409

    repo.delete_routine(routine.id)
    repo.update_project(project.id, lead_agent_id=agent.id)
    assert client.delete(f"/api/agents/{agent.id}").status_code == 200
    assert repo.get_task(task.id).agent_id is None
    assert repo.get_project(project.id).lead_agent_id is None


def test_memory_endpoint_reads_and_clears(client, repo, dispatcher):
    agent = repo.add_agent("A", memory_enabled=1)
    root = agents.memory_dir(dispatcher.settings.data_dir, agent.id)
    root.mkdir(parents=True)
    (root / "MEMORY.md").write_text("- likes tests\n")
    (root / "topic").mkdir()
    (root / "topic" / "long.md").write_text("x" * (agents.MEMORY_PREVIEW_CHARS + 5))
    data = client.get(f"/api/agents/{agent.id}/memory").json()
    assert data["enabled"] is True
    files = {f["name"]: f for f in data["files"]}
    assert files["MEMORY.md"]["content"] == "- likes tests\n" and files["MEMORY.md"]["truncated"] is False
    assert files["topic/long.md"]["truncated"] is True
    assert client.delete(f"/api/agents/{agent.id}/memory").json() == {"files": []}
    assert client.get(f"/api/agents/{agent.id}/memory").json()["files"] == []


def test_schema_upgrade_adds_agent_columns_to_an_old_database(tmp_path):
    from orc.db import connect, init_schema
    conn = connect(tmp_path / "old.db")
    conn.execute("CREATE TABLE routines (id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT)")
    init_schema(conn)
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(routines)")}
    assert "agent_id" in columns


# ---------- the agent's own page: /agents/{id}/work ----------

def _usage(total: int, model: str = "claude-opus-5", cost: float | None = None) -> str:
    return json.dumps({"total": {"input": total, "cache_creation": 0, "cache_read": 0, "output": 0},
                       "total_tokens": total, "models": {model: {"input": total, "cache_creation": 0, "cache_read": 0, "output": 0}},
                       "agents": [], "sessions": [], "cost_usd": cost, "cost_usd_estimated": None})


def test_agent_work_sums_tasks_and_chats_of_this_agent_only(client, repo, project):
    agent, other = repo.add_agent("Rev"), repo.add_agent("Other")
    done = repo.add_task(project.id, "done", status=TaskStatus.DONE, agent_id=agent.id, usage_json=_usage(1000, cost=0.5),
                         done_at="2026-11-05T11:00:00+00:00")
    repo.add_task_session(done.id, "job1", "s1", None)
    repo.update_task(done.id, archived_at="2026-11-06T00:00:00+00:00")
    repo.add_task(project.id, "failed", status=TaskStatus.FAILED, agent_id=agent.id, usage_json=_usage(200, "claude-haiku-4-5", cost=0.1))
    live = repo.add_task(project.id, "live", status=TaskStatus.IN_PROGRESS, agent_id=agent.id)
    repo.add_task(project.id, "alien", status=TaskStatus.DONE, agent_id=other.id, usage_json=_usage(9999, cost=9.0))
    chat = repo.add_chat(agent.id, project.id, "talk")
    repo.update_chat(chat.id, usage_json=_usage(50, cost=0.05))

    body = client.get(f"/api/agents/{agent.id}/work").json()
    summary = body["summary"]
    assert summary["tasks_total"] == 3 and summary["tasks_done"] == 1 and summary["tasks_failed"] == 1
    assert summary["chats_total"] == 1
    assert summary["tokens"] == 1250 and summary["cost_usd"] == pytest.approx(0.65)
    assert summary["models"] == {"claude-opus-5": 1050, "claude-haiku-4-5": 200}
    assert body["total_runs"] == 4
    # The live run comes first, the archived one is still in the history
    assert body["runs"][0]["id"] == live.id and body["runs"][0]["live"] is True
    assert any(r["id"] == done.id and r["archived"] and r["tokens"] == 1000 for r in body["runs"])
    assert len(body["daily"]) == 14


def test_agent_work_pages_and_unknown_agent(client, repo, project):
    agent = repo.add_agent("Rev")
    for i in range(3):
        repo.add_task(project.id, f"t{i}", status=TaskStatus.DONE, agent_id=agent.id)
    page = client.get(f"/api/agents/{agent.id}/work", params={"limit": 2, "offset": 2}).json()
    assert page["total_runs"] == 3 and len(page["runs"]) == 1
    empty = client.get(f"/api/agents/{repo.add_agent('Idle').id}/work").json()
    assert empty["summary"]["tokens"] == 0 and empty["summary"]["cost_usd"] is None and empty["runs"] == []
    assert client.get("/api/agents/999/work").status_code == 404
