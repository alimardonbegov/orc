"""Moving a card to another project (POST /api/tasks/{id}/move) and the fuse on promoting a card by an agent."""
import subprocess

import pytest

from orc import task_plans
from orc.models import TaskStatus
from tests.fakes import any_agent


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
def pid(client, git_repo):
    return client.post("/api/projects", json={"name": "demo", "path": str(git_repo), "max_workers": 10}).json()["id"]


@pytest.fixture
def other_repo(tmp_path):
    path = tmp_path / "other"
    path.mkdir()
    _git(["init", "-b", "trunk"], path)
    _git(["config", "user.email", "t@t"], path)
    _git(["config", "user.name", "t"], path)
    (path / "b.txt").write_text("1\n")
    _git(["add", "b.txt"], path)
    _git(["commit", "-m", "init"], path)
    return path


@pytest.fixture
def other(client, other_repo):
    return client.post("/api/projects", json={"name": "other", "path": str(other_repo)}).json()["id"]


def _move(client, task_id, **body):
    return client.post(f"/api/tasks/{task_id}/move", json={"project": "other", **body})


def test_a_backlog_card_moves_with_the_base_of_the_new_project(client, repo, pid, other):
    card = repo.add_task(pid, "Move me", "the job", target_branch="main", position=3)
    r = _move(client, card.id)
    assert r.status_code == 200, r.text
    moved = repo.get_task(card.id)
    assert (moved.project_id, moved.target_branch, moved.status, moved.position) == (other, "trunk", "backlog", None)
    assert r.json()["project_id"] == other
    events = repo.list_events()
    assert any("moved to project other" in e["message"] and e["project_id"] == pid for e in events), "the old project is told too"


def test_the_project_can_be_named_by_id_and_the_base_chosen(client, repo, other, other_repo, pid):
    _git(["branch", "release"], other_repo)
    card = repo.add_task(pid, "Move me", target_branch="main")
    assert _move(client, card.id, project=str(other), target_branch="release").status_code == 200
    assert repo.get_task(card.id).target_branch == "release"


def test_a_branch_the_new_repository_does_not_have_is_refused(client, repo, other, pid):
    card = repo.add_task(pid, "Move me", target_branch="main")
    r = _move(client, card.id, target_branch="main")
    assert r.status_code == 400 and "does not exist in project other" in r.json()["detail"]
    assert repo.get_task(card.id).project_id == pid


@pytest.mark.parametrize("status", [TaskStatus.IN_PROGRESS, TaskStatus.DONE, TaskStatus.FAILED, TaskStatus.MERGING])
def test_a_card_that_has_started_stays_where_its_work_is(client, repo, other, pid, status):
    card = repo.add_task(pid, "Started", target_branch="main", status=status)
    r = _move(client, card.id)
    assert r.status_code == 400 and "has not started" in r.json()["detail"]
    assert repo.get_task(card.id).project_id == pid


def test_a_card_with_a_worktree_or_a_routine_run_stays(client, repo, other, pid):
    with_branch = repo.add_task(pid, "Returned to the backlog", target_branch="main", branch="orc/task-1")
    r = _move(client, with_branch.id)
    assert r.status_code == 400 and "worktree or a session" in r.json()["detail"]


def test_moving_into_the_same_project_or_an_unknown_one_is_an_error(client, repo, other, pid):
    card = repo.add_task(pid, "x", target_branch="main")
    assert "already in project" in client.post(f"/api/tasks/{card.id}/move", json={"project": "demo"}).json()["detail"]
    assert client.post(f"/api/tasks/{card.id}/move", json={"project": "nope"}).status_code == 400
    assert client.post("/api/tasks/9999/move", json={"project": "other"}).status_code == 404


def test_a_shared_agent_goes_along_and_an_internal_one_does_not(client, repo, other, pid):
    shared = any_agent(client)
    card = repo.add_task(pid, "Shared", target_branch="main", agent_id=shared, status=TaskStatus.TODO)
    assert _move(client, card.id).status_code == 200
    assert repo.get_task(card.id).agent_id == shared and repo.get_task(card.id).status == TaskStatus.TODO

    internal = client.post("/api/agents", json={"name": "Local", "project_id": pid}).json()["id"]
    card = repo.add_task(pid, "Internal", "job", target_branch="main", agent_id=internal, status=TaskStatus.TODO)
    r = _move(client, card.id)
    assert r.status_code == 200
    moved = repo.get_task(card.id)
    assert moved.agent_id is None and moved.status == TaskStatus.BACKLOG, "a queued card without an agent waits for a person"
    assert any("Local" in w for w in r.json()["warnings"]) and any("backlog" in w for w in r.json()["warnings"])


def test_an_agent_can_be_named_for_the_new_project(client, repo, other, pid):
    local = client.post("/api/agents", json={"name": "Theirs", "project_id": other}).json()["id"]
    card = repo.add_task(pid, "x", "job", target_branch="main")
    assert _move(client, card.id, agent="Theirs").status_code == 200
    assert repo.get_task(card.id).agent_id == local
    elsewhere = client.post("/api/agents", json={"name": "Mine", "project_id": pid}).json()["id"]
    other_card = repo.add_task(pid, "y", "job", target_branch="main")
    assert _move(client, other_card.id, agent=elsewhere).status_code == 400


def test_a_card_inherits_the_branch_of_its_blockers_in_the_new_project(client, repo, other, other_repo, pid):
    _git(["branch", "feature"], other_repo)
    blocker = repo.add_task(other, "Blocker", target_branch="feature")
    card = repo.add_task(pid, "Waits", target_branch="main", depends_on=[blocker.id])
    assert _move(client, card.id).status_code == 200
    assert repo.get_task(card.id).target_branch == "feature"
    clash = repo.add_task(pid, "Clash", target_branch="main", depends_on=[blocker.id])
    r = _move(client, clash.id, target_branch="trunk")
    assert r.status_code == 400 and "would start without their work" in r.json()["detail"]


def test_a_dependent_on_another_branch_of_the_new_project_blocks_the_move(client, repo, other, pid):
    card = repo.add_task(pid, "Blocker", target_branch="main")
    repo.add_task(other, "Waiting", target_branch="elsewhere", depends_on=[card.id])
    r = _move(client, card.id)
    assert r.status_code == 400 and "wait for card" in r.json()["detail"]


def test_a_dependent_left_in_the_old_project_is_mentioned(client, repo, other, pid):
    card = repo.add_task(pid, "Blocker", target_branch="main")
    waiting = repo.add_task(pid, "Waiting", target_branch="main", depends_on=[card.id])
    r = _move(client, card.id)
    assert r.status_code == 200 and any(f"#{waiting.id}" in w for w in r.json()["warnings"])
    assert repo.deps_of(waiting.id) == [card.id]


def test_a_moved_queue_card_does_not_start_in_the_old_repository(client, repo, dispatcher, other, other_repo, pid):
    card = repo.add_task(pid, "Queued", "job", target_branch="main", status=TaskStatus.TODO, agent_id=any_agent(client))
    _move(client, card.id)
    dispatcher.tick()
    started = repo.get_task(card.id)
    assert started.project_id == other and started.worktree_path is not None
    assert started.worktree_path.startswith(str(other_repo)) or other_repo.name in started.worktree_path


# ---------- the generation fuse when an agent promotes a card ----------

def _deep_card_and_caller(repo, pid, git_repo):
    parent = None
    for _ in range(task_plans.MAX_AUTOSTART_GENERATION + 1):
        parent = repo.add_task(pid, "gen", created_by_task_id=parent.id if parent else None)
    deep = repo.add_task(pid, "Deep", "job", target_branch="main", created_by_task_id=parent.id)
    runner = repo.add_task(pid, "Runner", status=TaskStatus.IN_PROGRESS, target_branch="main")
    worktree = git_repo / ".claude" / "worktrees" / f"orc-task-{runner.id}"
    worktree.mkdir(parents=True)
    repo.update_task(runner.id, worktree_path=str(worktree))
    return deep, worktree


def test_an_agent_cannot_promote_a_card_that_is_too_deep_but_the_owner_can(client, repo, pid, git_repo):
    deep, worktree = _deep_card_and_caller(repo, pid, git_repo)
    agent = any_agent(client)
    by_agent = client.patch(f"/api/tasks/{deep.id}", json={"status": "todo", "agent_id": agent, "cwd": str(worktree)})
    assert by_agent.status_code == 400 and "only the owner" in by_agent.json()["detail"]
    assert repo.get_task(deep.id).status == TaskStatus.BACKLOG
    by_owner = client.patch(f"/api/tasks/{deep.id}", json={"status": "todo", "agent_id": agent})
    assert by_owner.status_code == 200 and by_owner.json()["status"] == TaskStatus.TODO


def test_cwd_is_not_written_to_the_card(client, repo, pid, git_repo):
    card = repo.add_task(pid, "x", "job", target_branch="main")
    assert client.patch(f"/api/tasks/{card.id}", json={"title": "y", "cwd": str(git_repo)}).json()["title"] == "y"
