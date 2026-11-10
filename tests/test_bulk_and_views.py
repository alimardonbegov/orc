"""Bulk changes of cards (POST /tasks/bulk) and saved board views."""
import pytest

from tests.fakes import any_agent


def _card(client, project, title="A", **extra):
    r = client.post("/api/tasks", json={"project_id": project.id, "title": title, "description": "do it", **extra})
    assert r.status_code == 201, r.text
    return r.json()


def _by_id(body):
    return {r["id"]: r for r in body["results"]}


# ---------- bulk ----------

def test_ten_cards_to_todo_one_without_agent_is_refused_and_reported(client, project):
    agent = any_agent(client)
    cards = [_card(client, project, f"c{i}", agent_id=None if i == 4 else agent) for i in range(10)]
    ids = [c["id"] for c in cards]
    r = client.post("/api/tasks/bulk", json={"task_ids": ids, "status": "todo"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["ok"], body["failed"]) == (9, 1)
    by = _by_id(body)
    assert by[cards[4]["id"]]["ok"] is False and by[cards[4]["id"]]["error"]
    assert all(by[c["id"]]["ok"] and by[c["id"]]["status"] == "todo" for i, c in enumerate(cards) if i != 4)
    # the server's state agrees with the report
    assert client.get(f"/api/tasks/{cards[4]['id']}").json()["status"] == "backlog"
    assert client.get(f"/api/tasks/{cards[0]['id']}").json()["status"] == "todo"


def test_priority_and_unknown_id_and_duplicates(client, project):
    a, b = _card(client, project, "a"), _card(client, project, "b")
    r = client.post("/api/tasks/bulk", json={"task_ids": [a["id"], b["id"], a["id"], 9999], "priority": "high"})
    body = r.json()
    assert len(body["results"]) == 3  # the duplicate is dropped
    assert _by_id(body)[9999] == {"id": 9999, "ok": False, "error": "card not found"}
    assert client.get(f"/api/tasks/{a['id']}").json()["priority"] == "high"


def test_agent_absent_is_not_null(client, project):
    agent = any_agent(client)
    card = _card(client, project, agent_id=agent)
    client.post("/api/tasks/bulk", json={"task_ids": [card["id"]], "priority": "low"})
    assert client.get(f"/api/tasks/{card['id']}").json()["agent_id"] == agent  # untouched
    client.post("/api/tasks/bulk", json={"task_ids": [card["id"]], "agent_id": None})
    assert client.get(f"/api/tasks/{card['id']}").json()["agent_id"] is None


def test_taking_the_agent_off_a_queued_card_reports_the_new_status(client, project):
    agent = any_agent(client)
    card = _card(client, project, agent_id=agent, status="todo")
    body = client.post("/api/tasks/bulk", json={"task_ids": [card["id"]], "agent_id": None}).json()
    assert body["results"][0]["ok"] and body["results"][0]["status"] == "backlog"


def test_labels_add_and_remove_keep_the_rest(client, project):
    a = _card(client, project, "a", labels=["bug", "ui"])
    b = _card(client, project, "b")
    client.post("/api/tasks/bulk", json={"task_ids": [a["id"], b["id"]], "add_labels": ["Urgent"]})
    names = lambda c: sorted(label["name"] for label in client.get(f"/api/tasks/{c['id']}").json()["labels"])
    assert names(a) == ["Urgent", "bug", "ui"] and names(b) == ["Urgent"]
    client.post("/api/tasks/bulk", json={"task_ids": [a["id"], b["id"]], "remove_labels": ["URGENT", "ui"]})
    assert names(a) == ["bug"] and names(b) == []


def test_archive_and_unarchive(client, project):
    a, b = _card(client, project, "a"), _card(client, project, "b")
    body = client.post("/api/tasks/bulk", json={"task_ids": [a["id"], b["id"]], "archived": True}).json()
    assert body["ok"] == 2 and client.get("/api/tasks").json() == []
    # an archived card takes no other change
    again = client.post("/api/tasks/bulk", json={"task_ids": [a["id"]], "priority": "high"}).json()
    assert again["failed"] == 1 and "archived" in again["results"][0]["error"]
    assert client.post("/api/tasks/bulk", json={"task_ids": [a["id"]], "archived": False}).json()["ok"] == 1
    assert [t["id"] for t in client.get("/api/tasks").json()] == [a["id"]]


def test_a_running_card_cannot_be_archived_in_bulk(client, project, repo):
    a, b = _card(client, project, "a"), _card(client, project, "b")
    repo.update_task(b["id"], status="in_progress")
    body = client.post("/api/tasks/bulk", json={"task_ids": [a["id"], b["id"]], "archived": True}).json()
    assert (body["ok"], body["failed"]) == (1, 1)
    assert _by_id(body)[b["id"]]["ok"] is False


@pytest.mark.parametrize("payload", [
    {"task_ids": []},
    {"task_ids": [1]},
    {"task_ids": [1], "priority": "urgent"},
    {"task_ids": [1], "status": "done"},
    {"task_ids": [1], "status": "todo", "priority": "high"},
    {"task_ids": [1], "archived": True, "priority": "high"},
    {"task_ids": list(range(1, 202)), "priority": "high"},
    {"task_ids": [1], "model": "x"},
])
def test_bad_requests_are_refused_as_a_whole(client, project, payload):
    assert client.post("/api/tasks/bulk", json=payload).status_code in (400, 422)


# ---------- views ----------

def test_view_roundtrip_and_survives_a_new_listing(client, project):
    label = client.post("/api/labels", json={"name": "bug"}).json()
    made = client.post(f"/api/projects/{project.id}/views", json={
        "name": "  Bugs   waiting ", "filters": {"label_id": label["id"], "attention_only": True, "search": " api "}})
    assert made.status_code == 201, made.text
    view = made.json()
    assert view["name"] == "Bugs waiting"
    assert view["filters"] == {"search": "api", "attention_only": True, "label_id": label["id"],
                               "show_done": True, "show_archived": False, "done_sort": "recent"}
    assert client.get(f"/api/projects/{project.id}/views").json() == [view]


def test_view_names_are_unique_per_project_ignoring_case(client, project, repo, git_repo):
    other = repo.add_project("other", str(git_repo / ".."))
    assert client.post(f"/api/projects/{project.id}/views", json={"name": "Mine"}).status_code == 201
    assert client.post(f"/api/projects/{project.id}/views", json={"name": "mine"}).status_code == 409
    assert client.post(f"/api/projects/{other.id}/views", json={"name": "mine"}).status_code == 201


def test_view_validation(client, project):
    url = f"/api/projects/{project.id}/views"
    assert client.post(url, json={"name": "   "}).status_code == 400
    assert client.post(url, json={"name": "x" * 61}).status_code == 400
    assert client.post(url, json={"name": "x", "filters": {"nope": 1}}).status_code == 400
    assert client.post(url, json={"name": "x", "filters": {"done_sort": "random"}}).status_code == 400
    assert client.post(url, json={"name": "x", "filters": {"show_done": "yes"}}).status_code == 400
    assert client.post(url, json={"name": "x", "filters": {"label_id": True}}).status_code == 400
    assert client.post("/api/projects/9999/views", json={"name": "x"}).status_code == 404


def test_view_update_delete_and_deleted_label(client, project):
    label = client.post("/api/labels", json={"name": "bug"}).json()
    view = client.post(f"/api/projects/{project.id}/views", json={"name": "v", "filters": {"label_id": label["id"]}}).json()
    renamed = client.patch(f"/api/views/{view['id']}", json={"name": "w", "filters": {"show_done": False}}).json()
    assert renamed["name"] == "w" and renamed["filters"]["show_done"] is False and renamed["filters"]["label_id"] is None
    client.patch(f"/api/views/{view['id']}", json={"filters": {"label_id": label["id"]}})
    client.delete(f"/api/labels/{label['id']}")
    assert client.get(f"/api/projects/{project.id}/views").json()[0]["filters"]["label_id"] is None
    assert client.delete(f"/api/views/{view['id']}").status_code == 200
    assert client.delete(f"/api/views/{view['id']}").status_code == 404
    assert client.patch(f"/api/views/{view['id']}", json={"name": "z"}).status_code == 404


def test_views_go_with_their_project(client, project, repo):
    client.post(f"/api/projects/{project.id}/views", json={"name": "v"})
    repo.conn.execute("DELETE FROM projects WHERE id = ?", (project.id,))
    assert repo.conn.execute("SELECT COUNT(*) FROM board_views").fetchone()[0] == 0
