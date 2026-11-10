"""Subtasks: tasks.parent_task_id, from the form, the card, a session and the CLI, and how it stays apart from the
generation fuse that walks created_by_task_id."""
import pytest

from orc import task_cli, task_plans
from orc.db import connect, init_schema
from orc.main import parse_args
from orc.models import TaskStatus
from orc.repo import Repo


@pytest.fixture
def pid(client, git_repo):
    return client.post("/api/projects", json={"name": "demo", "path": str(git_repo), "max_workers": 10}).json()["id"]


def _running_card(repo, pid, git_repo, **fields):
    task = repo.add_task(pid, "Running", status=TaskStatus.IN_PROGRESS, target_branch="main", **fields)
    worktree = git_repo / ".claude" / "worktrees" / f"orc-task-{task.id}"
    worktree.mkdir(parents=True)
    return repo.update_task(task.id, worktree_path=str(worktree)), worktree


# ---------- the form and the card ----------

def test_a_subtask_from_the_form_keeps_its_parent_and_no_generation(client, repo, pid):
    """A person's subtask of an agent-made card groups under it, and the fuse does not count it."""
    deep = None
    for _ in range(task_plans.MAX_AUTOSTART_GENERATION + 1):
        deep = repo.add_task(pid, "gen", target_branch="main", created_by_task_id=deep.id if deep else None)
    r = client.post("/api/tasks", json={"project_id": pid, "title": "child", "parent_task_id": deep.id})
    assert r.status_code == 201, r.text
    child = repo.get_task(r.json()["id"])
    assert child.parent_task_id == deep.id and child.created_by_task_id is None
    assert task_plans.generation(repo, child) == 0
    assert r.json()["parent_task_id"] == deep.id
    assert any(t["parent_task_id"] == deep.id for t in client.get("/api/tasks").json())


def test_a_missing_parent_is_refused(client, pid):
    r = client.post("/api/tasks", json={"project_id": pid, "title": "x", "parent_task_id": 999})
    assert r.status_code == 400 and "does not exist" in r.json()["detail"]


def test_patch_sets_and_clears_the_parent_in_any_status(client, repo, pid):
    parent = repo.add_task(pid, "P", target_branch="main")
    child = repo.add_task(pid, "C", target_branch="main", status=TaskStatus.DONE)
    r = client.patch(f"/api/tasks/{child.id}", json={"parent_task_id": parent.id})
    assert r.status_code == 200 and r.json()["parent_task_id"] == parent.id
    r = client.patch(f"/api/tasks/{child.id}", json={"parent_task_id": None})
    assert r.status_code == 200 and repo.get_task(child.id).parent_task_id is None


def test_patch_refuses_itself_and_a_ring(client, repo, pid):
    a = repo.add_task(pid, "A", target_branch="main")
    b = repo.add_task(pid, "B", target_branch="main", parent_task_id=a.id)
    c = repo.add_task(pid, "C", target_branch="main", parent_task_id=b.id)
    r = client.patch(f"/api/tasks/{a.id}", json={"parent_task_id": a.id})
    assert r.status_code == 400 and "itself" in r.json()["detail"]
    r = client.patch(f"/api/tasks/{a.id}", json={"parent_task_id": c.id})
    assert r.status_code == 400 and "ring" in r.json()["detail"]
    assert repo.get_task(a.id).parent_task_id is None


def test_a_ring_already_in_the_data_does_not_hang_the_check(client, repo, pid):
    a = repo.add_task(pid, "A", target_branch="main")
    b = repo.add_task(pid, "B", target_branch="main", parent_task_id=a.id)
    repo.update_task(a.id, parent_task_id=b.id)
    other = repo.add_task(pid, "Other", target_branch="main")
    assert client.patch(f"/api/tasks/{other.id}", json={"parent_task_id": a.id}).status_code == 200


def test_deleting_a_parent_leaves_its_subtasks_top_level(client, repo, pid):
    parent = repo.add_task(pid, "P", target_branch="main")
    child = repo.add_task(pid, "C", target_branch="main", parent_task_id=parent.id)
    assert client.delete(f"/api/tasks/{parent.id}").status_code == 200
    assert repo.get_task(child.id).parent_task_id is None


# ---------- a session ----------

def test_a_card_from_a_session_is_a_subtask_of_its_caller(client, repo, pid, git_repo):
    caller, worktree = _running_card(repo, pid, git_repo)
    r = client.post("/api/tasks/batch", json={"cwd": str(worktree), "tasks": [{"title": "Next"}]})
    assert r.status_code == 201, r.text
    card = r.json()["created"][0]
    assert card["parent_task_id"] == caller.id
    task = repo.get_task(card["id"])
    assert (task.parent_task_id, task.created_by_task_id) == (caller.id, caller.id)


def test_no_parent_and_an_explicit_parent_leave_the_fuse_alone(client, repo, pid, git_repo):
    caller, worktree = _running_card(repo, pid, git_repo)
    other = repo.add_task(pid, "Epic", target_branch="main")
    top = client.post("/api/tasks/batch", json={"cwd": str(worktree), "no_parent": True, "tasks": [{"title": "Top"}]})
    elsewhere = client.post("/api/tasks/batch", json={"cwd": str(worktree), "parent": other.id, "tasks": [{"title": "Under"}]})
    top, elsewhere = (repo.get_task(r.json()["created"][0]["id"]) for r in (top, elsewhere))
    assert (top.parent_task_id, top.created_by_task_id) == (None, caller.id)
    assert (elsewhere.parent_task_id, elsewhere.created_by_task_id) == (other.id, caller.id)
    both = client.post("/api/tasks/batch", json={"cwd": str(worktree), "parent": other.id, "no_parent": True,
                                                 "tasks": [{"title": "x"}]})
    assert both.status_code == 400
    missing = client.post("/api/tasks/batch", json={"project_id": pid, "parent": 999, "tasks": [{"title": "x"}]})
    assert missing.status_code == 400 and "does not exist" in missing.json()["detail"]


def test_a_card_from_outside_a_session_is_top_level(client, repo, pid):
    r = client.post("/api/tasks/batch", json={"project_id": pid, "tasks": [{"title": "Alone"}]})
    assert repo.get_task(r.json()["created"][0]["id"]).parent_task_id is None


# ---------- migration ----------

def test_the_migration_fills_parents_from_creators(tmp_path):
    from orc import db

    conn = connect(tmp_path / "old.db")
    init_schema(conn)
    repo = Repo(conn)
    project = repo.add_project("p", str(tmp_path))
    maker = repo.add_task(project.id, "maker")
    made = repo.add_task(project.id, "made", created_by_task_id=maker.id)
    dangling = repo.add_task(project.id, "dangling", created_by_task_id=99999)
    conn.execute("UPDATE tasks SET parent_task_id = NULL")
    conn.execute(f"PRAGMA user_version = {db.MIGRATIONS.index(db._parents_from_creators) + 1}")  # the state before this migration
    conn.commit()

    init_schema(conn)
    assert repo.get_task(made.id).parent_task_id == maker.id
    assert repo.get_task(dangling.id).parent_task_id is None
    assert repo.get_task(maker.id).parent_task_id is None
    # Once only: a card taken out of its group later is not put back by a restart
    repo.update_task(made.id, parent_task_id=None)
    init_schema(conn)
    assert repo.get_task(made.id).parent_task_id is None


# ---------- the CLI ----------

@pytest.fixture
def through_api(client):
    def call(method, path, payload):
        r = client.request(method, path, json=payload) if payload is not None else client.request(method, path)
        if r.status_code >= 400:
            raise task_cli.CliError(task_cli._error_text(r.text))
        return r.json()
    return call


@pytest.fixture
def in_project(client, git_repo, monkeypatch):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    monkeypatch.chdir(git_repo)
    return git_repo


def _run(argv, call, capsys):
    code = task_cli.run(parse_args(["task", *argv]), call)
    out = capsys.readouterr()
    return code, out.out, out.err


def test_cli_add_and_edit_the_parent(repo, in_project, through_api, capsys):
    project = repo.list_projects()[0]
    epic = repo.add_task(project.id, "Epic", target_branch="main")
    code, out, _ = _run(["add", "Step", "--parent", str(epic.id)], through_api, capsys)
    assert code == 0 and f"subtask of #{epic.id}" in out
    step = next(t for t in repo.list_tasks() if t.title == "Step")
    assert step.parent_task_id == epic.id
    code, out, _ = _run(["show", str(step.id)], through_api, capsys)
    assert f"subtask of #{epic.id}" in out
    assert _run(["edit", str(step.id), "--clear", "parent"], through_api, capsys)[0] == 0
    assert repo.get_task(step.id).parent_task_id is None
    assert _run(["edit", str(step.id), "--parent", str(epic.id)], through_api, capsys)[0] == 0
    assert repo.get_task(step.id).parent_task_id == epic.id
    code, _, err = _run(["edit", str(step.id), "--parent", str(epic.id), "--clear", "parent"], through_api, capsys)
    assert code == 1 and "pick one" in err


def test_cli_no_parent_from_a_session(repo, in_project, through_api, capsys, monkeypatch):
    project = repo.list_projects()[0]
    caller = repo.add_task(project.id, "Running", target_branch="main", status=TaskStatus.IN_PROGRESS)
    worktree = in_project / ".claude" / "worktrees" / "mine"
    worktree.mkdir(parents=True)
    repo.update_task(caller.id, worktree_path=str(worktree))
    monkeypatch.chdir(worktree)
    _run(["add", "Child"], through_api, capsys)
    _run(["add", "Loose", "--no-parent"], through_api, capsys)
    by_title = {t.title: t for t in repo.list_tasks()}
    assert by_title["Child"].parent_task_id == caller.id
    assert (by_title["Loose"].parent_task_id, by_title["Loose"].created_by_task_id) == (None, caller.id)
    with pytest.raises(SystemExit):  # argparse refuses the pair before anything is sent
        parse_args(["task", "add", "Both", "--parent", "1", "--no-parent"])


def test_cli_tells_when_the_server_does_not_know_subtasks(in_project, capsys):
    def old_server(method, path, payload=None):
        if path.startswith("/api/tasks/context"):
            return {"project": {"id": 1}, "projects": []}
        if method == "POST":
            if "parent" in payload or "no_parent" in payload:
                raise task_cli.CliError("parent: Extra inputs are not permitted")
            return {"created": [], "warnings": []}
        if method == "PATCH":
            return {"id": 1, "status": "backlog"}  # an old server drops unknown fields and answers as usual
        return {"id": 1, "status": "backlog", "project_id": 1}

    for argv in (["add", "T", "--parent", "1"], ["add", "T", "--no-parent"], ["edit", "1", "--parent", "2"],
                 ["edit", "1", "--clear", "parent"]):
        code, _, err = _run(argv, old_server, capsys)
        assert code == 1 and "older than this CLI" in err, argv
    # Without the flags nothing new is sent, and the old server is not bothered
    assert _run(["add", "T"], old_server, capsys)[0] == 0
