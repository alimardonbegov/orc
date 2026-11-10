"""Cleaning tasks off the board: archive (reversible) and permanent deletion."""
from pathlib import Path

from orc import git_ops
from tests.fakes import to_work


def _project(client, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})


def _started(client, repo, title="A"):
    """A task brought to in_progress by a tick: with a session, worktree and branch."""
    t = client.post("/api/tasks", json={"project_id": 1, "title": title, "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    client.post("/api/dispatcher/tick")
    return repo.get_task(t["id"])


# ---------- archive ----------

def test_archive_hides_task_from_board_and_unarchive_returns_it(client, repo, git_repo):
    _project(client, git_repo)
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()

    r = client.post(f"/api/tasks/{t['id']}/archive")
    assert r.status_code == 200 and r.json()["archived_at"] is not None
    assert client.get("/api/tasks").json() == []  # by default the board does not show the archive
    assert [x["id"] for x in client.get("/api/tasks", params={"archived": "only"}).json()] == [t["id"]]
    assert [x["id"] for x in client.get("/api/tasks", params={"archived": "all"}).json()] == [t["id"]]
    # The card is intact and opens by a direct link: archiving is not deletion.
    assert client.get(f"/api/tasks/{t['id']}").status_code == 200

    r = client.post(f"/api/tasks/{t['id']}/unarchive")
    assert r.status_code == 200 and r.json()["archived_at"] is None
    assert [x["id"] for x in client.get("/api/tasks").json()] == [t["id"]]


def test_archive_is_idempotent_and_404_on_missing(client, git_repo):
    _project(client, git_repo)
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    first = client.post(f"/api/tasks/{t['id']}/archive").json()
    again = client.post(f"/api/tasks/{t['id']}/archive").json()
    assert first["archived_at"] == again["archived_at"]  # a repeat does not move the date
    assert client.post(f"/api/tasks/{t['id']}/unarchive").json()["archived_at"] is None
    assert client.post(f"/api/tasks/{t['id']}/unarchive").status_code == 200
    assert client.post("/api/tasks/999/archive").status_code == 404
    assert client.post("/api/tasks/999/unarchive").status_code == 404


def test_archive_rejected_while_task_is_working(client, repo, git_repo):
    _project(client, git_repo)
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    for working_status in ("in_progress", "verifying", "merging"):
        repo.update_task(t["id"], status=working_status)
        r = client.post(f"/api/tasks/{t['id']}/archive")
        assert r.status_code == 400, working_status
        assert "close it manually" in r.json()["detail"]
    assert repo.get_task(t["id"]).archived_at is None


def test_archived_task_is_invisible_to_dispatcher(client, repo, fake_cli, git_repo):
    _project(client, git_repo)
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    client.post(f"/api/tasks/{t['id']}/archive")
    client.post("/api/dispatcher/tick")
    assert fake_cli.calls == []  # the task is in todo but archived: it is not taken into work
    assert repo.get_task(t["id"]).status == "todo"
    # Returned to the board: the dispatcher picks it up as usual.
    client.post(f"/api/tasks/{t['id']}/unarchive")
    client.post("/api/dispatcher/tick")
    assert repo.get_task(t["id"]).status == "in_progress"


def test_archived_blocker_stops_blocking(client, repo, git_repo):
    # The blocker was removed from the board: the dependent task must not get stuck forever.
    _project(client, git_repo)
    a = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    b = client.post("/api/tasks", json={"project_id": 1, "title": "B", "description": "what to do", "depends_on": [a["id"]]}).json()
    client.patch(f"/api/tasks/{b['id']}", json=to_work(client))
    client.post("/api/dispatcher/tick")
    assert repo.get_task(b["id"]).status == "todo"  # waits for A

    client.post(f"/api/tasks/{a['id']}/archive")
    client.post("/api/dispatcher/tick")
    assert repo.get_task(b["id"]).status == "in_progress"


def test_bad_archived_filter_is_rejected(client, git_repo):
    _project(client, git_repo)
    assert client.get("/api/tasks", params={"archived": "maybe"}).status_code == 400


# ---------- deletion ----------

def test_delete_removes_task_with_comments_and_deps(client, repo, git_repo):
    _project(client, git_repo)
    a = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    b = client.post("/api/tasks", json={"project_id": 1, "title": "B", "description": "what to do", "depends_on": [a["id"]]}).json()
    client.post(f"/api/tasks/{a['id']}/comments", json={"body": "note", "kind": "comment"})

    r = client.delete(f"/api/tasks/{a['id']}")
    assert r.status_code == 200 and r.json()["deleted"] == a["id"]
    # A warning for the UI: the link on #B disappeared together with the task.
    assert r.json()["dependents"] == [b["id"]]
    assert client.get(f"/api/tasks/{a['id']}").status_code == 404
    assert repo.list_comments(a["id"]) == []
    assert client.get(f"/api/tasks/{b['id']}").json()["depends_on"] == []
    assert client.delete(f"/api/tasks/{a['id']}").status_code == 404


def test_delete_leaves_events_readable(client, repo, git_repo):
    # events.task_id goes to NULL instead of failing the deletion on the foreign key: the
    # "what happened" entry in the feed matters more than a link to a card that no longer exists.
    _project(client, git_repo)
    t = _started(client, repo)
    assert any(e["task_id"] == t.id for e in repo.list_events())
    client.delete(f"/api/tasks/{t.id}?force=true")
    events = client.get("/api/events").json()
    assert all(e["task_id"] is None for e in events)
    assert any("deleted for good" in e["message"] for e in events)


def test_delete_of_working_task_needs_force(client, repo, fake_cli, git_repo):
    _project(client, git_repo)
    t = _started(client, repo)
    r = client.delete(f"/api/tasks/{t.id}")
    assert r.status_code == 400 and "force=true" in r.json()["detail"]
    assert repo.get_task(t.id) is not None and fake_cli.calls[-1][0] != "stop"

    r = client.delete(f"/api/tasks/{t.id}?force=true")
    assert r.status_code == 200 and r.json()["session"] is True
    assert ("stop", t.job_id) in fake_cli.calls and ("remove", t.job_id) in fake_cli.calls
    assert repo.get_task(t.id) is None


def test_delete_cleans_worktree_and_branch(client, repo, git_repo):
    _project(client, git_repo)
    t = _started(client, repo)
    assert Path(t.worktree_path).exists() and t.branch in git_ops.list_branches(git_repo)

    body = client.delete(f"/api/tasks/{t.id}?force=true").json()
    assert body["worktree"] is True and body["branch"] is True
    assert not Path(t.worktree_path).exists()
    assert t.branch not in git_ops.list_branches(git_repo)


def test_delete_can_keep_worktree_and_branch(client, repo, git_repo):
    # The card is not needed, but the unfinished work in the branch is.
    _project(client, git_repo)
    t = _started(client, repo)
    body = client.delete(f"/api/tasks/{t.id}?force=true&drop_worktree=false").json()
    assert body["worktree"] is False and body["branch"] is False
    assert Path(t.worktree_path).exists() and t.branch in git_ops.list_branches(git_repo)


def test_delete_of_idle_task_needs_no_force(client, repo, git_repo):
    _project(client, git_repo)
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    assert client.delete(f"/api/tasks/{t['id']}").status_code == 200
    assert client.get("/api/tasks").json() == []


def test_delete_of_archived_task_works(client, repo, git_repo):
    _project(client, git_repo)
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.post(f"/api/tasks/{t['id']}/archive")
    assert client.delete(f"/api/tasks/{t['id']}").status_code == 200
    assert client.get("/api/tasks", params={"archived": "all"}).json() == []
