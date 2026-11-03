"""HTTP layer of branch management: response codes and the link to task cards."""


def _project(client, git_repo):
    return client.post("/api/projects", json={"name": "demo", "path": str(git_repo)}).json()


def test_create_rename_delete_roundtrip(client, git_repo):
    _project(client, git_repo)
    r = client.post("/api/git/branches", json={"project_id": 1, "name": "dev"})
    assert r.status_code == 201 and "dev" in r.json()["branches"]
    r = client.post("/api/git/branches/rename", json={"project_id": 1, "name": "dev", "new_name": "develop"})
    assert r.status_code == 200 and r.json()["branches"] == ["develop", "main"]
    r = client.post("/api/git/branches/delete", json={"project_id": 1, "name": "develop"})
    assert r.status_code == 200 and r.json()["branches"] == ["main"]


def test_unknown_project_is_404(client):
    assert client.get("/api/git/branches", params={"project_id": 7}).status_code == 404
    assert client.post("/api/git/branches", json={"project_id": 7, "name": "x"}).status_code == 404


def test_delete_needs_confirmation_when_tasks_wait_for_branch(client, git_repo):
    _project(client, git_repo)
    client.post("/api/git/branches", json={"project_id": 1, "name": "dev"})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do", "target_branch": "dev"}).json()
    r = client.post("/api/git/branches/delete", json={"project_id": 1, "name": "dev"})
    assert r.status_code == 409 and "use it as their base" in r.json()["detail"]
    r = client.post("/api/git/branches/delete", json={"project_id": 1, "name": "dev", "force": True})
    assert r.status_code == 200
    # The card is not left pointing at nothing: it was moved to the project base
    assert client.get(f"/api/tasks/{t['id']}").json()["target_branch"] == "main"


def test_delete_of_running_task_branch_is_refused(client, repo, git_repo):
    _project(client, git_repo)
    client.post("/api/git/branches", json={"project_id": 1, "name": "dev"})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do", "target_branch": "dev"}).json()
    repo.update_task(t["id"], status="in_progress")
    r = client.post("/api/git/branches/delete", json={"project_id": 1, "name": "dev", "force": True})
    assert r.status_code == 400 and "is being merged" in r.json()["detail"]
    r = client.post("/api/git/branches/rename", json={"project_id": 1, "name": "dev", "new_name": "x"})
    assert r.status_code == 400


def test_project_default_branch_drives_new_tasks(client, git_repo):
    _project(client, git_repo)
    client.post("/api/git/branches", json={"project_id": 1, "name": "dev"})
    r = client.patch("/api/projects/1", json={"default_branch": "dev"})
    assert r.status_code == 200 and r.json()["default_branch"] == "dev"
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    assert t["target_branch"] == "dev"
    # A nonexistent project base is rejected: otherwise every new task would fail in the dispatcher
    assert client.patch("/api/projects/1", json={"default_branch": "no-such-branch"}).status_code == 400


def test_task_target_branch_must_exist(client, git_repo):
    _project(client, git_repo)
    r = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do", "target_branch": "no-such-branch"})
    assert r.status_code == 400 and "no-such-branch" in r.json()["detail"]
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    assert client.patch(f"/api/tasks/{t['id']}", json={"target_branch": "no-such-branch"}).status_code == 400


def test_rename_carries_task_cards_with_it(client, git_repo):
    _project(client, git_repo)
    client.post("/api/git/branches", json={"project_id": 1, "name": "dev"})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do", "target_branch": "dev"}).json()
    r = client.post("/api/git/branches/rename", json={"project_id": 1, "name": "dev", "new_name": "release"})
    assert r.status_code == 200 and f"#{t['id']}" in r.json()["note"]
    assert client.get(f"/api/tasks/{t['id']}").json()["target_branch"] == "release"
