"""Quick create: POST /api/tasks/draft turns the owner's words into a draft card for the form, and creates nothing."""
import json

import pytest

from orc import quick_create
from orc.quick_create import DraftError, ModelRun


@pytest.fixture
def pid(client, git_repo):
    return client.post("/api/projects", json={"name": "demo", "path": str(git_repo), "max_workers": 10}).json()["id"]


def _answer(**fields):
    return json.dumps({"title": "Fix it", "description": "Do the thing", "agent": None, "priority": "normal",
                       "target_branch": None, **fields})


def _fake(client, text=None, error=None, tokens=900, cost=0.002):
    seen = []

    def drafter(prompt, system, model, cwd):
        seen.append({"prompt": prompt, "system": system, "model": model})
        if error:
            raise DraftError(error)
        return ModelRun(text=text if text is not None else _answer(), tokens=tokens, cost_usd=cost)

    client.app.state.drafter = drafter
    return seen


def _draft(client, pid, text="fix the save button, it is urgent", **extra):
    return client.post("/api/tasks/draft", json={"project_id": pid, "text": text, **extra})


def test_a_phrase_becomes_a_draft_and_no_card(client, repo, pid):
    agent = client.post("/api/agents", json={"name": "Senior", "description": "hard work"}).json()
    seen = _fake(client, _answer(agent="senior", priority="high", target_branch="main"))
    r = _draft(client, pid)
    assert r.status_code == 200
    assert r.json()["draft"] == {"title": "Fix it", "description": "Do the thing", "priority": "high",
                                 "agent_id": agent["id"], "target_branch": "main"}
    assert repo.list_tasks(pid) == []
    # The model sees the agents and the branches it may choose from, and the owner's words
    assert "Senior: hard work" in seen[0]["prompt"] and "- main" in seen[0]["prompt"] and "urgent" in seen[0]["prompt"]


def test_the_model_is_a_cheap_one_and_a_setting(client, pid):
    seen = _fake(client)
    _draft(client, pid)
    assert seen[-1]["model"] == "haiku"
    assert client.patch("/api/settings", json={"quick_create_model": "claude-haiku-5-5"}).status_code == 200
    assert client.get("/api/settings").json()["quick_create_model"] == "claude-haiku-5-5"
    _draft(client, pid)
    assert seen[-1]["model"] == "claude-haiku-5-5"
    _draft(client, pid, model="sonnet")
    assert seen[-1]["model"] == "sonnet"


def test_a_model_id_is_validated(client, pid):
    _fake(client)
    assert client.patch("/api/settings", json={"quick_create_model": "bad model; rm"}).status_code == 400
    assert _draft(client, pid, model="--dangerously").status_code == 400


def test_spent_tokens_go_to_the_ledger(client, repo, pid):
    _fake(client, tokens=1234, cost=0.0031)
    r = _draft(client, pid)
    assert r.json()["usage"] == {"model": "haiku", "tokens": 1234, "cost_usd": 0.0031}
    entries = repo.usage_entries_since("2000-01-01")
    assert [(e["task_id"], e["project_id"], e["tokens"], e["cost_usd"]) for e in entries] == [(None, pid, 1234, 0.0031)]


def test_a_failed_model_is_a_502_with_the_reason_and_creates_nothing(client, repo, pid):
    _fake(client, error="the model did not answer in 90 seconds")
    r = _draft(client, pid)
    assert r.status_code == 502 and "90 seconds" in r.json()["detail"]
    assert repo.list_tasks(pid) == [] and repo.usage_entries_since("2000-01-01") == []


def test_an_unusable_answer_is_a_502_but_its_tokens_are_still_counted(client, repo, pid):
    _fake(client, text="I cannot do that", tokens=500)
    assert _draft(client, pid).status_code == 502
    assert [e["tokens"] for e in repo.usage_entries_since("2000-01-01")] == [500]


def test_invented_agent_and_branch_are_dropped_with_a_note(client, pid):
    _fake(client, _answer(agent="Ghost", target_branch="nope", priority="urgent!!"))
    body = _draft(client, pid).json()
    assert body["draft"]["agent_id"] is None and body["draft"]["target_branch"] is None
    assert body["draft"]["priority"] == "normal"
    assert len(body["warnings"]) == 2


def test_an_answer_in_a_code_fence_is_read(client, pid):
    _fake(client, "Here you go:\n```json\n" + _answer() + "\n```")
    assert _draft(client, pid).json()["draft"]["title"] == "Fix it"


def test_empty_text_and_unknown_project_are_refused(client, pid):
    _fake(client)
    assert _draft(client, pid, text="   ").status_code == 400
    assert _draft(client, 9999).status_code == 400


def test_cli_output_is_parsed():
    raw = json.dumps({"result": "{}", "usage": {"input_tokens": 3, "output_tokens": 4, "cache_read_input_tokens": 5},
                      "total_cost_usd": 0.5})
    assert quick_create.parse_cli_output(raw) == ModelRun("{}", 12, 0.5)
    with pytest.raises(DraftError):
        quick_create.parse_cli_output(json.dumps({"is_error": True, "result": "rate limited"}))
    with pytest.raises(DraftError):
        quick_create.parse_cli_output("not json")
