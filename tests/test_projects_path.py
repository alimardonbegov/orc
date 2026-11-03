"""Moving a project to another folder and archiving a project.

The main promise is checked: after a path change no data is lost. Task worktrees
stay usable (git answers in them), their paths in the cards point to the new location, and
while the folder is unavailable the dashboard refuses clearly instead of surfacing a git error.
"""
import shutil

import pytest

from orc import git_ops, projects
from orc.models import TaskStatus


def _move_dir(src, dst):
    """Moving the project folder behind the dashboard's back is exactly what a person does in a file manager."""
    shutil.move(str(src), str(dst))
    return dst


def test_path_status_reports_why_folder_is_unusable(tmp_path, git_repo):
    assert projects.path_status(git_repo) == {"path_ok": True, "path_error": None}
    assert projects.path_status(tmp_path / "no-such-dir")["path_error"] == "folder does not exist"
    plain = tmp_path / "plain-folder"
    plain.mkdir()
    assert projects.path_status(plain)["path_error"] == "no .git in the folder"
    file_path = tmp_path / "file"
    file_path.write_text("not a folder")
    assert projects.path_status(file_path)["path_error"] == "not a folder"


def test_move_relinks_worktrees_and_keeps_them_working(client, repo, dispatcher, fake_cli, git_repo, tmp_path):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json={"status": "todo"})
    dispatcher.tick()  # the task worktree was created in the old folder
    old_worktree = repo.get_task(t["id"]).worktree_path
    assert old_worktree and str(git_repo) in old_worktree
    # We stop the task: moving under a live session is forbidden (see the test below)
    dispatcher.force_done(t["id"])

    new_path = _move_dir(git_repo, tmp_path / "moved")
    r = client.post("/api/projects/1/path", json={"path": str(new_path)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["project"]["path"] == str(new_path) and body["project"]["path_ok"] is True
    assert body["relinked"] == 1 and body["warnings"] == []

    moved = repo.get_task(t["id"])
    assert moved.worktree_path == str(new_path / ".claude" / "worktrees" / f"orc-task-{t['id']}")
    # Main thing: git in the moved worktree answers again, repair fixed the links
    assert git_ops.current_branch(new_path / ".claude" / "worktrees" / f"orc-task-{t['id']}") == moved.branch
    assert git_ops.worktree_for_branch(new_path, moved.branch) is not None


def test_move_is_refused_while_tasks_are_running_in_the_old_folder(client, repo, dispatcher, git_repo, tmp_path):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json={"status": "todo"})
    dispatcher.tick()
    assert repo.get_task(t["id"]).status == TaskStatus.IN_PROGRESS
    copy = tmp_path / "copy"
    shutil.copytree(git_repo, copy)
    r = client.post("/api/projects/1/path", json={"path": str(copy)})
    assert r.status_code == 400 and f"#{t['id']}" in r.json()["detail"]
    assert repo.get_project(1).path == str(git_repo)


def test_move_reports_branches_missing_in_the_new_repo(client, repo, git_repo, tmp_path):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    git_ops.create_branch(git_repo, "release", "main")
    repo.add_task(1, "A", target_branch="release")
    # The new path is a fresh clone without the "release" branch: we allow the move, but warn honestly
    fresh = tmp_path / "fresh"
    git_ops.git(["clone", "--branch", "main", "--single-branch", str(git_repo), str(fresh)], tmp_path)
    r = client.post("/api/projects/1/path", json={"path": str(fresh)})
    assert r.status_code == 200
    assert any("release" in w for w in r.json()["warnings"])


def test_move_rejects_bad_targets(client, repo, git_repo, tmp_path):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    plain = tmp_path / "not-a-repo"
    plain.mkdir()
    assert client.post("/api/projects/1/path", json={"path": str(plain)}).status_code == 400
    assert client.post("/api/projects/1/path", json={"path": str(tmp_path / "missing")}).status_code == 400
    assert client.post("/api/projects/1/path", json={"path": "relative/path"}).status_code == 400
    # Someone else's folder: path is UNIQUE in the table, and the refusal must explain the reason instead of spewing SQL
    other = tmp_path / "second"
    shutil.copytree(git_repo, other)
    client.post("/api/projects", json={"name": "second", "path": str(other)})
    r = client.post("/api/projects/1/path", json={"path": str(other)})
    assert r.status_code == 400 and "second" in r.json()["detail"]
    assert client.post("/api/projects/99/path", json={"path": str(other)}).status_code == 404


def test_task_creation_is_refused_when_the_folder_is_gone(client, git_repo, tmp_path):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    _move_dir(git_repo, tmp_path / "moved-away")
    listed = client.get("/api/projects").json()[0]
    assert listed["path_ok"] is False and listed["path_error"] == "folder does not exist"
    r = client.post("/api/tasks", json={"project_id": 1, "title": "A"})
    assert r.status_code == 409
    assert "new path" in r.json()["detail"] and "archive" in r.json()["detail"]
    # Branches cannot be read either, but with the same clear reason instead of a git error
    assert client.get("/api/git/branches", params={"project_id": 1}).status_code == 409
    # Repair: a new path was given, and task creation works again
    assert client.post("/api/projects/1/path", json={"path": str(tmp_path / "moved-away")}).status_code == 200
    assert client.post("/api/tasks", json={"project_id": 1, "title": "A"}).status_code == 201


def test_archive_hides_project_and_stops_the_dispatcher(client, repo, dispatcher, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json={"status": "todo"})

    r = client.post("/api/projects/1/archive")
    assert r.status_code == 200 and r.json()["archived_at"]
    assert client.get("/api/projects").json() == []
    assert len(client.get("/api/projects", params={"archived": "only"}).json()) == 1
    assert len(client.get("/api/projects", params={"archived": "all"}).json()) == 1
    assert client.get("/api/projects", params={"archived": "garbage"}).status_code == 400

    dispatcher.tick()
    assert repo.get_task(t["id"]).status == TaskStatus.TODO  # the task waits instead of failing
    assert client.post("/api/tasks", json={"project_id": 1, "title": "B"}).status_code == 409

    assert client.post("/api/projects/1/unarchive").json()["archived_at"] is None
    dispatcher.tick()
    assert repo.get_task(t["id"]).status == TaskStatus.IN_PROGRESS


def test_archive_is_refused_while_a_task_is_running(client, repo, dispatcher, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json={"status": "todo"})
    dispatcher.tick()
    r = client.post("/api/projects/1/archive")
    assert r.status_code == 400 and f"#{t['id']}" in r.json()["detail"]


def test_dispatcher_fails_task_with_explanation_when_folder_disappeared(repo, dispatcher, project, git_repo, tmp_path):
    t = repo.add_task(project.id, "A", status="todo")
    _move_dir(git_repo, tmp_path / "moved-away")
    dispatcher.tick()
    task = repo.get_task(t.id)
    assert task.status == TaskStatus.FAILED
    assert "project folder is unavailable" in task.blocker_detail and "archive" in task.blocker_detail


@pytest.mark.parametrize("call", ["archive", "unarchive"])
def test_archive_endpoints_404_on_unknown_project(client, call):
    assert client.post(f"/api/projects/1/{call}").status_code == 404


# ---------- new project path: validation before creation and git initialization ----------

def test_new_path_status_tells_what_is_missing(tmp_path, git_repo, repo):
    """The dashboard asks this before creating: it matters to tell "not allowed" from "can be set up"."""
    assert projects.new_path_status(str(git_repo))["status"] == projects.NEW_PATH_OK

    missing = projects.new_path_status(str(tmp_path / "no-such-dir"))
    assert missing["status"] == projects.NEW_PATH_MISSING and missing["can_init"] is True

    plain = tmp_path / "plain-folder"
    plain.mkdir()
    no_git = projects.new_path_status(str(plain))
    assert no_git["status"] == projects.NEW_PATH_NO_GIT and no_git["can_init"] is True

    file_path = tmp_path / "file"
    file_path.write_text("not a folder")
    not_dir = projects.new_path_status(str(file_path))
    assert not_dir["status"] == projects.NEW_PATH_NOT_DIR and not_dir["can_init"] is False

    assert projects.new_path_status("relative/path")["status"] == projects.NEW_PATH_INVALID

    # An occupied path cannot be fixed: there is a repository there, but it already belongs to someone else.
    repo.add_project("demo", str(git_repo))
    occupied = projects.new_path_status(str(git_repo), repo)
    assert occupied["status"] == projects.NEW_PATH_OCCUPIED and occupied["can_init"] is False
    assert "demo" in occupied["message"]


def test_prepare_new_path_inits_repo_only_with_consent(tmp_path):
    target = tmp_path / "new" / "project"
    with pytest.raises(projects.ProjectPathError):
        projects.prepare_new_path(str(target))
    assert not target.exists()

    path = projects.prepare_new_path(str(target), init_git=True)
    assert path == target.resolve()
    # The repository must be usable right away: the branch exists, HEAD exists.
    assert git_ops.current_branch(path) == "main"
    assert git_ops.list_branches(path) == ["main"]

    # A file instead of a folder is not fixed by consent: there is nothing to initialize there.
    file_path = tmp_path / "file"
    file_path.write_text("not a folder")
    with pytest.raises(projects.ProjectPathError):
        projects.prepare_new_path(str(file_path), init_git=True)


def test_check_path_endpoint_and_creation_with_init_git(client, tmp_path, git_repo):
    r = client.post("/api/projects/check-path", json={"path": str(git_repo)})
    assert r.json()["status"] == "ok" and r.json()["can_init"] is False

    target = tmp_path / "fresh"
    r = client.post("/api/projects/check-path", json={"path": str(target)})
    assert r.json() == {"path": str(target), "status": "missing", "can_init": True,
                        "message": f"folder {target} does not exist"}

    # Without confirmation the project is not created at such a path, as before.
    assert client.post("/api/projects", json={"name": "new", "path": str(target)}).status_code == 400
    assert not target.exists()

    r = client.post("/api/projects", json={"name": "new", "path": str(target), "init_git": True})
    assert r.status_code == 201 and r.json()["path_ok"] is True
    assert (target / ".git").exists()
    # The project is usable right away: branches can be read, so a task can be created in it.
    assert client.get("/api/git/branches", params={"project_id": r.json()["id"]}).json()["current"] == "main"

    # Now the path is taken: adding it again explains this instead of failing on UNIQUE.
    assert client.post("/api/projects/check-path", json={"path": str(target)}).json()["status"] == "occupied"
