"""Stages among subtasks: the derivation (orc/stages.py), the scheduler, the API, a batch and the CLI."""
import pytest

from orc import stages, task_cli
from orc.main import parse_args
from orc.models import TaskStatus


# ---------- the pure derivation ----------

def test_a_stage_waits_for_every_card_of_the_previous_one_only_among_siblings():
    nodes = [(1, 100, 1), (2, 100, 1), (3, 100, 2), (4, 100, 2), (5, 200, 2), (6, None, 2), (7, 100, None)]
    assert stages.stage_blockers(nodes) == {3: [1, 2], 4: [1, 2]}


def test_a_gap_in_the_numbers_follows_the_nearest_populated_stage():
    assert stages.stage_blockers([(1, 9, 1), (2, 9, 5)]) == {2: [1]}


def test_effective_deps_merge_without_duplicates():
    assert stages.effective_deps({3: [1, 8]}, {3: [1, 2], 4: [2]}) == {3: [1, 8, 2], 4: [2]}


def test_a_link_to_a_later_stage_is_a_ring():
    nodes = [(1, 9, 1), (2, 9, 2)]
    assert stages.closes_ring(1, nodes, {1: [2]})
    assert not stages.closes_ring(2, nodes, {2: [1]})


# ---------- the scheduler ----------

@pytest.fixture
def parent(repo, project):
    return repo.add_task(project.id, "Parent", target_branch="main")


def _staged(repo, project, parent, title, stage, **fields):
    return repo.add_task(project.id, title, "job", status="todo", target_branch="main",
                         parent_task_id=parent.id, stage=stage, **fields)


def _in_progress(repo):
    return {t.title for t in repo.list_tasks() if t.status == TaskStatus.IN_PROGRESS}


def test_stage_two_starts_only_when_the_whole_stage_one_is_done(repo, dispatcher, fake_cli, project, parent):
    repo.update_project(project.id, max_workers=10)
    a, b = _staged(repo, project, parent, "A", 1), _staged(repo, project, parent, "B", 1)
    c = _staged(repo, project, parent, "C", 2)
    dispatcher.tick()
    assert _in_progress(repo) == {"A", "B"}
    repo.update_task(a.id, status=TaskStatus.DONE)
    dispatcher.tick()
    assert repo.get_task(c.id).status == TaskStatus.TODO  # B is still running
    repo.update_task(b.id, status=TaskStatus.DONE)
    dispatcher.tick()
    assert repo.get_task(c.id).status == TaskStatus.IN_PROGRESS


def test_a_failed_card_holds_the_next_stage(repo, dispatcher, fake_cli, project, parent):
    repo.update_project(project.id, max_workers=10)
    a = _staged(repo, project, parent, "A", 1)
    b = _staged(repo, project, parent, "B", 2)
    repo.update_task(a.id, status=TaskStatus.FAILED)
    dispatcher.tick()
    assert repo.get_task(b.id).status == TaskStatus.TODO


def test_stages_of_other_parents_and_cards_without_a_stage_do_not_hold(repo, dispatcher, fake_cli, project, parent):
    repo.update_project(project.id, max_workers=10)
    other = repo.add_task(project.id, "Other parent", target_branch="main")
    foreign = repo.add_task(project.id, "Foreign", status="backlog", target_branch="main", parent_task_id=other.id, stage=1)
    loose = repo.add_task(project.id, "Loose", status="backlog", target_branch="main", parent_task_id=parent.id)
    b = _staged(repo, project, parent, "B", 2)
    first = b  # the only staged card of its parent: nothing to wait for
    dispatcher.tick()
    assert repo.get_task(first.id).status == TaskStatus.IN_PROGRESS
    assert foreign and loose


def test_an_archived_stage_card_does_not_hold(repo, dispatcher, fake_cli, project, parent):
    a = _staged(repo, project, parent, "A", 1)
    b = _staged(repo, project, parent, "B", 2)
    repo.update_task(a.id, status=TaskStatus.FAILED)
    repo.update_task(a.id, archived_at="2026-01-01T00:00:00+00:00")
    dispatcher.tick()
    assert repo.get_task(b.id).status == TaskStatus.IN_PROGRESS


# ---------- the API ----------

@pytest.fixture
def pid(project):
    return project.id


def test_the_list_and_the_card_show_the_same_stage_blockers(client, repo, pid, parent):
    a = repo.add_task(pid, "A", target_branch="main", parent_task_id=parent.id, stage=1)
    b = repo.add_task(pid, "B", target_branch="main", parent_task_id=parent.id, stage=2)
    listed = {t["id"]: t for t in client.get("/api/tasks").json()}
    assert listed[b.id]["stage"] == 2 and listed[b.id]["stage_blocked_by"] == [a.id]
    assert listed[a.id]["stage_blocked_by"] == []
    # A filtered list does not change what the card waits for
    only_b = client.get("/api/tasks", params={"status": "backlog"}).json()
    assert {t["id"]: t["stage_blocked_by"] for t in only_b}[b.id] == [a.id]
    assert client.get(f"/api/tasks/{b.id}").json()["stage_blocked_by"] == [a.id]


def test_create_and_patch_a_stage(client, repo, pid, parent):
    r = client.post("/api/tasks", json={"project_id": pid, "title": "x", "parent_task_id": parent.id, "stage": 2})
    assert r.status_code == 201 and r.json()["stage"] == 2
    tid = r.json()["id"]
    assert client.patch(f"/api/tasks/{tid}", json={"stage": 3}).json()["stage"] == 3
    assert client.patch(f"/api/tasks/{tid}", json={"stage": None}).json()["stage"] is None


@pytest.mark.parametrize("stage", [0, -1, 1000])
def test_a_stage_out_of_range_is_refused(client, pid, parent, stage):
    r = client.post("/api/tasks", json={"project_id": pid, "title": "x", "parent_task_id": parent.id, "stage": stage})
    assert r.status_code == 400 and "stage" in r.json()["detail"]


def test_a_stage_needs_a_parent(client, repo, pid):
    r = client.post("/api/tasks", json={"project_id": pid, "title": "x", "stage": 1})
    assert r.status_code == 400 and "no parent" in r.json()["detail"]
    lone = repo.add_task(pid, "lone", target_branch="main")
    r = client.patch(f"/api/tasks/{lone.id}", json={"stage": 1})
    assert r.status_code == 400


def test_leaving_the_parent_drops_the_stage(client, repo, pid, parent):
    c = repo.add_task(pid, "c", target_branch="main", parent_task_id=parent.id, stage=2)
    r = client.patch(f"/api/tasks/{c.id}", json={"parent_task_id": None})
    assert r.status_code == 200 and r.json()["stage"] is None
    c = repo.add_task(pid, "c2", target_branch="main", parent_task_id=parent.id, stage=2)
    other = repo.add_task(pid, "other", target_branch="main")
    assert client.patch(f"/api/tasks/{c.id}", json={"parent_task_id": other.id}).json()["stage"] is None


def test_a_link_to_a_later_stage_is_refused_both_ways(client, repo, pid, parent):
    a = repo.add_task(pid, "A", target_branch="main", parent_task_id=parent.id, stage=1)
    b = repo.add_task(pid, "B", target_branch="main", parent_task_id=parent.id, stage=2)
    r = client.patch(f"/api/tasks/{a.id}", json={"depends_on": [b.id]})
    assert r.status_code == 400 and "stages" in r.json()["detail"]
    loose = repo.add_task(pid, "L", target_branch="main", parent_task_id=parent.id)
    repo.set_deps(loose.id, [b.id])
    r = client.patch(f"/api/tasks/{loose.id}", json={"stage": 1})  # B (stage 2) would wait for it, and it waits for B
    assert r.status_code == 400 and repo.get_task(loose.id).stage is None
    r = client.post("/api/tasks", json={"project_id": pid, "title": "n", "parent_task_id": parent.id, "stage": 1,
                                        "depends_on": [b.id]})
    assert r.status_code == 400 and "itself" in r.json()["detail"]


# ---------- a batch ----------

def test_a_batch_with_stages_makes_the_cards_wait_without_links(client, repo, pid, parent, git_repo):
    plan = {"project_id": pid, "parent": parent.id, "tasks": [
        {"title": "a", "stage": 1}, {"title": "b", "stage": 1}, {"title": "c", "stage": 2}]}
    r = client.post("/api/tasks/batch", json=plan)
    assert r.status_code == 201, r.text
    created = {c["title"]: c for c in r.json()["created"]}
    assert [c["stage"] for c in created.values()] == [1, 1, 2]
    assert created["c"]["depends_on"] == []
    listed = {t["id"]: t for t in client.get("/api/tasks").json()}
    assert listed[created["c"]["id"]]["stage_blocked_by"] == sorted([created["a"]["id"], created["b"]["id"]])


def test_a_batch_stage_without_a_parent_or_in_a_ring_is_refused(client, repo, pid, parent):
    r = client.post("/api/tasks/batch", json={"project_id": pid, "no_parent": True, "tasks": [{"title": "a", "stage": 1}]})
    assert r.status_code == 400 and "no parent" in r.json()["detail"]
    r = client.post("/api/tasks/batch", json={"project_id": pid, "parent": parent.id, "sequential": True, "tasks": [
        {"title": "late", "stage": 2}, {"title": "early", "stage": 1}]})
    assert r.status_code == 400 and "ring" in r.json()["detail"]
    assert len(repo.list_tasks()) == 1  # nothing was created


# ---------- the CLI ----------

@pytest.fixture
def through_api(client):
    def call(method, path, payload):
        r = client.request(method, path, json=payload) if payload is not None else client.request(method, path)
        if r.status_code >= 400:
            raise task_cli.CliError(task_cli._error_text(r.text))
        return r.json()
    return call


def _run(argv, call, capsys):
    code = task_cli.run(parse_args(["task", *argv]), call)
    return code, capsys.readouterr().out


def test_cli_add_edit_and_clear_a_stage(repo, project, parent, git_repo, through_api, capsys, monkeypatch):
    monkeypatch.chdir(git_repo)
    code, out = _run(["add", "Step", "--parent", str(parent.id), "--stage", "2"], through_api, capsys)
    assert code == 0 and "stage 2" in out
    task = [t for t in repo.list_tasks() if t.title == "Step"][0]
    assert task.stage == 2
    _run(["edit", str(task.id), "--stage", "3"], through_api, capsys)
    assert repo.get_task(task.id).stage == 3
    _run(["edit", str(task.id), "--clear", "stage"], through_api, capsys)
    assert repo.get_task(task.id).stage is None


def test_cli_sends_stage_only_when_asked_and_names_an_older_server(monkeypatch, capsys):
    sent = []

    def old_server(method, path, payload):
        sent.append(payload)
        if method == "POST":
            raise task_cli.CliError("Extra inputs are not permitted")
        return {"id": 1, "status": "backlog", "project_id": 1, "depends_on": []}

    args = parse_args(["task", "add", "x", "--project", "p"])
    assert task_cli.run(args, old_server) == 1
    assert "stage" not in sent[0]["tasks"][0]
    assert task_cli.run(parse_args(["task", "add", "x", "--project", "p", "--stage", "1"]), old_server) == 1
    assert "older than this CLI" in capsys.readouterr().err
