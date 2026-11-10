"""Card settings at the orc and project level, and the rule that only an agent's card goes to work."""
import json

import pytest

from orc import card_settings
from orc.models import TaskStatus
from tests.fakes import any_agent


@pytest.fixture
def pid(client, git_repo):
    return client.post("/api/projects", json={"name": "demo", "path": str(git_repo)}).json()["id"]


def _task(client, pid, **fields):
    return client.post("/api/tasks", json={"project_id": pid, "title": "A", "description": "do it", **fields})


def _batch(client, pid, card):
    return client.post("/api/tasks/batch", json={"project_id": pid, "tasks": [{"title": "A", "description": "do it", **card}]})


def test_normalize_keeps_known_keys_and_refuses_the_rest():
    assert card_settings.normalize({"hidden": ["priority", "priority", " branch "]}) == {"hidden": ["priority", "branch"]}
    assert card_settings.normalize({"default_agent_id": None}) == {"default_agent_id": None}
    for bad in ([], {"nope": 1}, {"hidden": "x"}, {"hidden": [""]}, {"default_agent_id": "1"},
                {"default_agent_id": True}, {"default_priority": "urgent"}):
        with pytest.raises(ValueError):
            card_settings.normalize(bad)


def test_a_broken_stored_value_reads_as_nothing_of_its_own():
    assert card_settings.parse(None) is None
    assert card_settings.parse("{not json") is None
    assert card_settings.parse('{"nope": 1}') is None


def test_orc_settings_round_trip_and_validate(client):
    assert client.get("/api/settings").json()["card_settings"] == "{}"
    agent = any_agent(client)
    value = json.dumps({"hidden": ["priority"], "default_agent_id": agent})
    assert client.patch("/api/settings", json={"card_settings": value}).status_code == 200
    assert json.loads(client.get("/api/settings").json()["card_settings"]) == {"hidden": ["priority"], "default_agent_id": agent}
    assert client.patch("/api/settings", json={"card_settings": "[]"}).status_code == 400
    assert client.patch("/api/settings", json={"card_settings": "{broken"}).status_code == 400
    assert client.patch("/api/settings", json={"card_settings": '{"default_agent_id": 999}'}).status_code == 400


def test_orc_default_agent_must_be_a_shared_one(client, pid):
    internal = client.post("/api/agents", json={"name": "Inner", "project_id": pid}).json()["id"]
    value = json.dumps({"default_agent_id": internal})
    assert client.patch("/api/settings", json={"card_settings": value}).status_code == 400
    assert client.patch(f"/api/projects/{pid}", json={"card_settings": {"default_agent_id": internal}}).status_code == 200


def test_project_settings_round_trip_and_reset(client, pid):
    assert client.get("/api/projects").json()[0]["card_settings"] is None
    r = client.patch(f"/api/projects/{pid}", json={"card_settings": {"hidden": ["branch"]}})
    assert r.status_code == 200 and r.json()["card_settings"] == {"hidden": ["branch"]}
    assert client.patch(f"/api/projects/{pid}", json={"card_settings": {"nope": 1}}).status_code == 400
    assert client.patch(f"/api/projects/{pid}", json={"card_settings": {"default_agent_id": 999}}).status_code == 400
    assert client.patch(f"/api/projects/{pid}", json={"card_settings": None}).json()["card_settings"] is None


def test_default_agent_prefers_the_project_and_ignores_a_stale_choice(client, repo, pid):
    project = repo.get_project(pid)
    shared, own = any_agent(client), client.post("/api/agents", json={"name": "Own"}).json()["id"]
    assert card_settings.default_agent(repo, project) is None
    repo.set_setting("card_settings", json.dumps({"default_agent_id": shared}))
    assert card_settings.default_agent(repo, project) == shared
    project = repo.update_project(pid, card_settings=json.dumps({"default_agent_id": own}))
    assert card_settings.default_agent(repo, project) == own
    # A project may say "no default" on purpose, which is not the same as following orc
    project = repo.update_project(pid, card_settings=json.dumps({"default_agent_id": None}))
    assert card_settings.default_agent(repo, project) is None
    project = repo.update_project(pid, card_settings=json.dumps({"default_agent_id": 999}))
    assert card_settings.default_agent(repo, project) is None


def test_an_unassigned_card_does_not_go_to_work(client, repo, pid):
    t = _task(client, pid).json()
    assert t["status"] == "backlog"
    r = client.patch(f"/api/tasks/{t['id']}", json={"status": "todo"})
    assert r.status_code == 400 and "no assignee" in r.json()["detail"]
    assert repo.get_task(t["id"]).status == TaskStatus.BACKLOG
    # Assigning and sending in one request is fine
    r = client.patch(f"/api/tasks/{t['id']}", json={"status": "todo", "agent_id": any_agent(client)})
    assert r.status_code == 200 and r.json()["status"] == "todo"


def test_retry_of_an_unassigned_card_is_refused(client, repo, pid):
    t = _task(client, pid).json()
    repo.update_task(t["id"], status=TaskStatus.FAILED)
    r = client.post(f"/api/tasks/{t['id']}/retry")
    assert r.status_code == 400 and "no assignee" in r.json()["detail"]


def test_taking_the_agent_off_a_queued_card_returns_it_to_the_backlog(client, repo, pid):
    t = _task(client, pid, agent_id=any_agent(client), status="todo").json()
    assert t["status"] == "todo"
    r = client.patch(f"/api/tasks/{t['id']}", json={"agent_id": None})
    assert r.status_code == 200 and r.json()["status"] == "backlog" and r.json()["agent_id"] is None


def test_a_card_can_be_created_straight_into_the_queue(client, pid):
    assert _task(client, pid, status="todo").status_code == 400
    assert _task(client, pid, status="todo", agent_id=any_agent(client), description="").status_code == 400
    assert _task(client, pid, status="done", agent_id=any_agent(client)).status_code == 400
    assert _task(client, pid, status="todo", agent_id=any_agent(client)).json()["status"] == "todo"


def test_a_card_already_in_the_queue_still_starts(client, repo, dispatcher, pid):
    # The gate is at the doors, not in the dispatcher: a card queued before the rule, or a run of a
    # routine with its own parameters, is not stranded in "To do" with nothing to explain it.
    t = repo.add_task(pid, "Old", "do it", status=TaskStatus.TODO)
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS


def test_batch_fills_the_agent_of_a_queued_card_from_the_project_default(client, repo, pid):
    agent = any_agent(client)
    client.patch(f"/api/projects/{pid}", json={"card_settings": {"default_agent_id": agent}})
    body = _batch(client, pid, {"status": "todo"}).json()
    assert body["created"][0]["agent_id"] == agent and repo.get_task(body["created"][0]["id"]).status == TaskStatus.TODO


def test_batch_leaves_a_backlog_card_as_it_was_asked(client, pid):
    client.patch(f"/api/projects/{pid}", json={"card_settings": {"default_agent_id": any_agent(client)}})
    assert _batch(client, pid, {}).json()["created"][0]["agent_id"] is None


def test_batch_keeps_a_queued_card_with_nobody_to_run_it_in_the_backlog(client, repo, pid):
    body = _batch(client, pid, {"status": "todo"}).json()
    assert repo.get_task(body["created"][0]["id"]).status == TaskStatus.BACKLOG
    assert any("no agent" in warning for warning in body["warnings"])


def test_a_routine_run_without_an_agent_can_be_retried_and_keeps_its_place_in_the_queue(client, repo, pid):
    # It carries the routine's own parameters and already went to work without an agent
    routine = repo.add_routine(pid, "Nightly", description="do it", schedule_kind="interval", interval_minutes=60)
    run = repo.add_task(pid, "Nightly · #1", "do it", status=TaskStatus.FAILED, routine_id=routine.id, routine_run=1)
    assert client.post(f"/api/tasks/{run.id}/retry").status_code == 200
    assert repo.get_task(run.id).status == TaskStatus.TODO
    assert client.patch(f"/api/tasks/{run.id}", json={"agent_id": None}).json()["status"] == "todo"


def test_quick_actions_are_checked_and_trimmed():
    good = [{"id": " review ", "title": " Review ", "prompt": " Check it. "}]
    assert card_settings.normalize({"quick_actions": good}) == {"quick_actions": [{"id": "review", "title": "Review", "prompt": "Check it."}]}
    assert card_settings.normalize({"quick_actions": []}) == {"quick_actions": []}
    one = {"id": "a", "title": "A", "prompt": "p"}
    for bad in ("x", [1], [{"id": "a", "title": "A"}], [{**one, "extra": 1}], [{**one, "title": " "}], [{**one, "id": 1}],
                [one, one], [{**one, "title": "t" * 61}], [{**one, "prompt": "p" * 4001}],
                [{**one, "id": str(n)} for n in range(31)]):
        with pytest.raises(ValueError):
            card_settings.normalize({"quick_actions": bad})


def test_quick_actions_round_trip_for_orc_and_project(client, pid):
    shared = [{"id": "tests", "title": "Tests", "prompt": "Write tests."}]
    assert client.patch("/api/settings", json={"card_settings": json.dumps({"quick_actions": shared})}).status_code == 200
    assert json.loads(client.get("/api/settings").json()["card_settings"]) == {"quick_actions": shared}
    own = [{"id": "lint", "title": "Lint", "prompt": "Run the linter."}]
    r = client.patch(f"/api/projects/{pid}", json={"card_settings": {"quick_actions": own}})
    assert r.status_code == 200 and r.json()["card_settings"] == {"quick_actions": own}
    bad = client.patch(f"/api/projects/{pid}", json={"card_settings": {"quick_actions": [{"id": "x"}]}})
    assert bad.status_code == 400
    assert client.patch("/api/settings", json={"card_settings": '{"quick_actions": "x"}'}).status_code == 400
