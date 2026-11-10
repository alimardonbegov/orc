"""Cards created by agents: POST /api/tasks/batch, /dependencies, /tasks/context, and the chain they make."""
import json
import subprocess
from pathlib import Path

import pytest

from orc import git_ops, task_plans
from orc.models import TaskStatus
from orc.handoff import REPORT_REL_PATH
from tests.fakes import any_agent


@pytest.fixture
def pid(client, git_repo):
    return client.post("/api/projects", json={"name": "demo", "path": str(git_repo), "max_workers": 10}).json()["id"]


def _batch(client, pid, tasks, **extra):
    return client.post("/api/tasks/batch", json={"project_id": pid, "tasks": tasks, **extra})


def _card(title="t", **extra):
    return {"title": title, "description": "what to do", **extra}


def _branch(git_repo, name):
    subprocess.run(["git", "branch", name], cwd=git_repo, check=True, capture_output=True)


# ---------- a batch ----------

def test_one_card_lands_in_the_backlog_by_default(client, repo, pid):
    r = _batch(client, pid, [_card("Only")])
    assert r.status_code == 201
    card = r.json()["created"][0]
    assert card["status"] == TaskStatus.BACKLOG and card["target_branch"] == "main"
    assert repo.get_task(card["id"]).title == "Only"


def test_refs_become_links_and_an_early_card_may_name_a_later_one(client, repo, pid):
    r = _batch(client, pid, [_card("Second", ref="b", depends_on=["a"]), _card("First", ref="a")])
    assert r.status_code == 201
    first, second = r.json()["created"]  # blockers first, whatever the order in the request
    assert (first["title"], second["title"]) == ("First", "Second")
    assert repo.deps_of(second["id"]) == [first["id"]] and first["ref"] == "a"


def test_sequential_chains_the_cards_and_keeps_their_own_links(client, repo, pid):
    old = repo.add_task(pid, "Old", target_branch="main")
    r = _batch(client, pid, [_card("1"), _card("2", depends_on=[old.id]), _card("3")], sequential=True)
    one, two, three = r.json()["created"]
    assert repo.deps_of(one["id"]) == []
    assert sorted(repo.deps_of(two["id"])) == sorted([old.id, one["id"]])
    assert repo.deps_of(three["id"]) == [two["id"]]


def test_card_parameters_and_defaults(client, repo, pid):
    agent = client.post("/api/agents", json={"name": "Senior"}).json()
    r = _batch(client, pid, [
        _card("A", priority="high", verify_cmd="make test"),
        _card("B", status="backlog", agent=None),
    ], defaults={"agent": "Senior", "status": "todo"})
    assert r.status_code == 201
    a, b = (repo.get_task(c["id"]) for c in r.json()["created"])
    assert (a.agent_id, a.status, a.priority, a.verify_cmd) == (agent["id"], "todo", "high", "make test")
    assert (a.model, a.effort, a.permission_mode) == (None, None, None)  # those belong to the agent
    assert (b.agent_id, b.status) == (None, "backlog")  # a card's own value wins, even an explicit null


@pytest.mark.parametrize("bad, fragment", [
    ({"ref": "current"}, "reserved"),
    ({"depends_on": ["nope"]}, "neither a ref"),
    ({"depends_on": [999]}, "does not exist"),
    ({"depends_on": ["current"]}, "not the worktree"),
    ({"status": "done"}, "status"),
    ({"priority": "urgent"}, "priority"),
    ({"agent": "Nobody"}, "not found"),
    ({"status": "todo", "description": "  "}, "description is empty"),
    ({"title": "  "}, "blank"),
    ({"start_before": "2020-01-01T00:00:00+00:00"}, "start"),
    ({"target_branch": "no-such-branch"}, "does not exist"),
])
def test_one_bad_card_leaves_nothing_behind(client, repo, pid, bad, fragment):
    r = _batch(client, pid, [_card("Good"), _card("Bad") | bad])
    assert r.status_code == 400, r.text
    assert fragment in r.json()["detail"]
    assert repo.list_tasks(pid) == []


def test_a_mistyped_field_is_refused_rather_than_ignored(client, pid):
    assert _batch(client, pid, [_card(agnet="Senior")]).status_code == 422
    assert client.post("/api/tasks/batch", json={"project_id": pid, "tasks": [_card()], "sequentail": True}).status_code == 422


@pytest.mark.parametrize("field, value", [("model", "claude-sonnet-5-5"), ("effort", "high"), ("permission_mode", "auto")])
def test_a_card_cannot_carry_run_parameters_of_its_own(client, repo, pid, field, value):
    """They belong to the agent the card is tied to: asking for them must fail, not run with other ones."""
    assert _batch(client, pid, [_card(**{field: value})]).status_code == 422
    assert _batch(client, pid, [_card()], defaults={field: value}).status_code == 422
    assert repo.list_tasks(pid) == []


def test_a_failure_while_writing_rolls_back_the_whole_graph(repo, project):
    rows = [{"project_id": project.id, "title": "a"}, {"project_id": project.id, "title": "b"}]
    with pytest.raises(Exception):
        repo.add_task_graph(rows, [([], []), ([12345], [0])])
    assert repo.list_tasks(project.id) == []
    assert repo.get_setting("anything") is None  # the connection is still usable


def test_ring_and_self_link_are_refused(client, repo, pid):
    ring = _batch(client, pid, [_card(ref="a", depends_on=["b"]), _card(ref="b", depends_on=["a"])])
    assert ring.status_code == 400 and "ring" in ring.json()["detail"]
    own = _batch(client, pid, [_card(ref="a", depends_on=["a"])])
    assert own.status_code == 400 and "itself" in own.json()["detail"]
    assert repo.list_tasks(pid) == []


def test_duplicate_refs_are_refused(client, pid):
    r = _batch(client, pid, [_card(ref="a"), _card(ref="a")])
    assert r.status_code == 400 and "duplicates" in r.json()["detail"]


def test_size_limit(client, repo, pid):
    r = _batch(client, pid, [_card(str(i)) for i in range(task_plans.MAX_BATCH_TASKS + 1)])
    assert r.status_code == 400 and repo.list_tasks(pid) == []


def test_repeating_a_request_returns_the_same_cards(client, repo, pid):
    first = _batch(client, pid, [_card("A"), _card("B")], idempotency_key="k1").json()
    second = _batch(client, pid, [_card("A"), _card("B")], idempotency_key="k1")
    assert second.status_code == 201 and second.json()["duplicate"] is True
    assert [c["id"] for c in second.json()["created"]] == [c["id"] for c in first["created"]]
    assert len(repo.list_tasks(pid)) == 2
    # Another key is another request, and the key is not exposed on the card
    assert _batch(client, pid, [_card("A")], idempotency_key="k2").json()["duplicate"] is False
    assert "batch_key" not in client.get(f"/api/tasks/{first['created'][0]['id']}").json()


def test_an_old_key_no_longer_deduplicates(client, repo, pid):
    first = _batch(client, pid, [_card("A")], idempotency_key="k").json()["created"][0]
    repo.conn.execute("UPDATE tasks SET created_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (first["id"],))
    repo.conn.commit()
    assert _batch(client, pid, [_card("A")], idempotency_key="k").json()["duplicate"] is False


# ---------- the base branch ----------

def test_a_chain_has_one_base_even_if_the_project_points_elsewhere(client, repo, pid, git_repo):
    _branch(git_repo, "dev")
    old = repo.add_task(pid, "Old", target_branch="dev")
    cards = _batch(client, pid, [_card("A", ref="a", depends_on=[old.id]), _card("B", depends_on=["a"])]).json()["created"]
    assert {c["target_branch"] for c in cards} == {"dev"}  # the project's base is main


def test_an_explicit_base_against_a_blocker_is_refused(client, repo, pid, git_repo):
    _branch(git_repo, "dev")
    old = repo.add_task(pid, "Old", target_branch="main")
    r = _batch(client, pid, [_card(target_branch="dev", depends_on=[old.id])])
    assert r.status_code == 400 and "without their work" in r.json()["detail"]
    r = _batch(client, pid, [_card(depends_on=[old.id])], target_branch="dev")
    assert r.status_code == 400
    r = _batch(client, pid, [_card(ref="a", target_branch="dev"), _card(depends_on=["a"], target_branch="main")])
    assert r.status_code == 400 and repo.get_task(old.id) is not None and len(repo.list_tasks(pid)) == 1


def test_blockers_on_different_bases_are_refused(client, repo, pid, git_repo):
    _branch(git_repo, "dev")
    a = repo.add_task(pid, "A", target_branch="main")
    b = repo.add_task(pid, "B", target_branch="dev")
    r = _batch(client, pid, [_card(depends_on=[a.id, b.id])])
    assert r.status_code == 400 and "different branches" in r.json()["detail"]


def test_a_blocker_of_another_project_says_nothing_about_the_base(client, repo, pid, git_repo, tmp_path):
    other = repo.add_project("other", str(tmp_path / "other"))
    foreign = repo.add_task(other.id, "Backend", target_branch="release")
    r = _batch(client, pid, [_card(depends_on=[foreign.id], target_branch="main"), _card(depends_on=[foreign.id])])
    assert r.status_code == 201
    assert {c["target_branch"] for c in r.json()["created"]} == {"main"}


def test_the_base_can_be_created_for_the_batch(client, repo, pid, git_repo):
    r = _batch(client, pid, [_card("A")], target_branch="feature/x", create_target_from="main")
    assert r.status_code == 201 and r.json()["created"][0]["target_branch"] == "feature/x"
    assert "feature/x" in git_ops.list_branches(git_repo)
    # Asking again with an existing branch is not an error: a retry must work
    assert _batch(client, pid, [_card("B")], target_branch="feature/x", create_target_from="main").status_code == 201


def test_a_refused_batch_does_not_create_the_branch(client, pid, git_repo):
    r = _batch(client, pid, [_card(priority="urgent")], target_branch="feature/x", create_target_from="main")
    assert r.status_code == 400 and "feature/x" not in git_ops.list_branches(git_repo)
    assert _batch(client, pid, [_card()], create_target_from="main").status_code == 400
    assert _batch(client, pid, [_card()], target_branch="feature/x", create_target_from="nope").status_code == 400


def test_plain_create_inherits_a_blockers_base(client, repo, pid, git_repo):
    """The form's endpoint: with no branch sent the card follows its blocker. An explicit one stays the owner's call."""
    _branch(git_repo, "dev")
    old = repo.add_task(pid, "Old", target_branch="dev")
    inherited = client.post("/api/tasks", json={"project_id": pid, "title": "x", "depends_on": [old.id]}).json()
    assert inherited["target_branch"] == "dev"
    explicit = client.post("/api/tasks", json={"project_id": pid, "title": "y", "depends_on": [old.id], "target_branch": "main"})
    assert explicit.status_code == 201 and explicit.json()["target_branch"] == "main"


# ---------- who is calling ----------

def _running_card(repo, pid, git_repo, target="main", **fields):
    task = repo.add_task(pid, "Running", status=TaskStatus.IN_PROGRESS, target_branch=target, **fields)
    worktree = git_repo / ".claude" / "worktrees" / f"orc-task-{task.id}"
    worktree.mkdir(parents=True)
    return repo.update_task(task.id, worktree_path=str(worktree)), worktree


def test_the_folder_says_the_project_the_card_and_the_base(client, repo, pid, git_repo):
    _branch(git_repo, "dev")
    caller, worktree = _running_card(repo, pid, git_repo, target="dev")
    r = client.post("/api/tasks/batch", json={"cwd": str(worktree / "sub"), "tasks": [_card("Next", depends_on=["current"])]})
    assert r.status_code == 201, r.text
    card = r.json()["created"][0]
    assert card["target_branch"] == "dev" and card["depends_on"] == [caller.id]
    assert repo.get_task(card["id"]).created_by_task_id == caller.id
    assert client.get(f"/api/tasks/{card['id']}").json()["created_by_task_id"] == caller.id
    assert any(f"#{card['id']} created by card #{caller.id}" in e["message"] for e in repo.list_events())


def test_cards_that_do_not_wait_for_the_caller_get_a_warning(client, repo, pid, git_repo):
    caller, worktree = _running_card(repo, pid, git_repo)
    r = client.post("/api/tasks/batch", json={"cwd": str(worktree), "tasks": [_card("Independent")]})
    assert any(f"do not wait for your card #{caller.id}" in w for w in r.json()["warnings"])
    r = client.post("/api/tasks/batch", json={"cwd": str(worktree), "tasks": [_card("Waiting", depends_on=["current"])]})
    assert r.json()["warnings"] == []


def test_warnings_about_blockers_that_will_not_finish_by_themselves(client, repo, pid):
    idle = repo.add_task(pid, "Idle", target_branch="main")
    failed = repo.add_task(pid, "Failed", target_branch="main", status=TaskStatus.FAILED)
    gone = repo.add_task(pid, "Gone", target_branch="main", archived_at="2026-01-01T00:00:00+00:00")
    warnings = _batch(client, pid, [_card(status="todo", agent=any_agent(client), depends_on=[idle.id, failed.id, gone.id])]).json()["warnings"]
    assert len(warnings) == 3
    assert any("backlog" in w for w in warnings) and any("failed" in w for w in warnings) and any("archived" in w for w in warnings)


def test_a_project_is_found_by_name_path_or_a_worktree_elsewhere(client, repo, pid, git_repo, tmp_path):
    assert client.post("/api/tasks/batch", json={"project": "DEMO", "tasks": [_card()]}).status_code == 201
    assert client.post("/api/tasks/batch", json={"project": str(git_repo), "tasks": [_card()]}).status_code == 201
    outside = tmp_path / "outside-worktree"
    subprocess.run(["git", "worktree", "add", "-b", "side", str(outside)], cwd=git_repo, check=True, capture_output=True)
    assert client.post("/api/tasks/batch", json={"cwd": str(outside), "tasks": [_card()]}).status_code == 201
    r = client.post("/api/tasks/batch", json={"project": "nope", "tasks": [_card()]})
    assert r.status_code == 400 and "demo" in r.json()["detail"]
    r = client.post("/api/tasks/batch", json={"cwd": str(tmp_path), "tasks": [_card()]})
    assert r.status_code == 400 and "which project" in r.json()["detail"]


def test_a_scratch_chat_folder_inside_a_clone_is_not_that_project(client, dispatcher, repo, tmp_path):
    """A chat outside a project works under the data directory, which may live inside a clone that is itself a project."""
    repo.add_project("clone", str(tmp_path))
    folder = dispatcher.settings.data_dir / "chats" / "1"
    folder.mkdir(parents=True)
    r = client.post("/api/tasks/batch", json={"cwd": str(folder), "tasks": [_card()]})
    assert r.status_code == 400 and "which project" in r.json()["detail"]


def test_an_archived_project_is_refused(client, repo, pid):
    client.post(f"/api/projects/{pid}/archive")
    assert _batch(client, pid, [_card()]).status_code == 409


def test_an_agent_of_another_project_is_refused(client, repo, pid, tmp_path):
    other = repo.add_project("other", str(tmp_path / "other"))
    repo.add_agent("Theirs", project_id=other.id)
    r = _batch(client, pid, [_card(agent="Theirs")])
    assert r.status_code == 400 and "another project" in r.json()["detail"]


# ---------- fuses ----------

def test_a_deep_chain_of_agents_can_only_reach_the_backlog(client, repo, pid, git_repo):
    parent = None
    for _ in range(task_plans.MAX_AUTOSTART_GENERATION):
        parent = repo.add_task(pid, "gen", created_by_task_id=parent.id if parent else None)
    caller, worktree = _running_card(repo, pid, git_repo, created_by_task_id=parent.id)
    assert task_plans.generation(repo, caller) == task_plans.MAX_AUTOSTART_GENERATION
    body = {"cwd": str(worktree), "tasks": [_card(status="todo")]}
    r = client.post("/api/tasks/batch", json=body)
    assert r.status_code == 400 and "backlog" in r.json()["detail"]
    body["tasks"] = [_card(status="backlog")]
    assert client.post("/api/tasks/batch", json=body).status_code == 201


def test_generation_survives_a_deleted_ancestor_and_a_ring(repo, project):
    root = repo.add_task(project.id, "root", created_by_task_id=99999)
    assert task_plans.generation(repo, root) == 1
    a = repo.add_task(project.id, "a")
    b = repo.add_task(project.id, "b", created_by_task_id=a.id)
    a = repo.update_task(a.id, created_by_task_id=b.id)
    assert task_plans.generation(repo, a) == 1


def test_one_card_cannot_create_without_end(client, repo, pid, git_repo):
    caller, worktree = _running_card(repo, pid, git_repo)
    for i in range(task_plans.MAX_TASKS_PER_CALLER):
        repo.add_task(pid, str(i), created_by_task_id=caller.id)
    r = client.post("/api/tasks/batch", json={"cwd": str(worktree), "tasks": [_card()]})
    assert r.status_code == 400 and "report to the owner" in r.json()["detail"]


# ---------- links and context ----------

def test_link_adds_and_removes_without_touching_the_rest(client, repo, pid):
    a, b, c = (repo.add_task(pid, n, target_branch="main") for n in "abc")
    task = repo.add_task(pid, "t", target_branch="main", depends_on=[a.id])
    r = client.post(f"/api/tasks/{task.id}/dependencies", json={"add": [b.id, str(c.id)]})
    assert r.status_code == 200 and sorted(r.json()["depends_on"]) == sorted([a.id, b.id, c.id])
    r = client.post(f"/api/tasks/{task.id}/dependencies", json={"remove": [a.id]})
    assert sorted(r.json()["depends_on"]) == sorted([b.id, c.id])


def test_link_refuses_rings_foreign_bases_and_started_cards(client, repo, pid, git_repo):
    _branch(git_repo, "dev")
    a = repo.add_task(pid, "a", target_branch="main")
    b = repo.add_task(pid, "b", target_branch="main", depends_on=[a.id])
    r = client.post(f"/api/tasks/{a.id}/dependencies", json={"add": [b.id]})
    assert r.status_code == 400 and "cycle" in r.json()["detail"]
    dev = repo.add_task(pid, "dev", target_branch="dev")
    r = client.post(f"/api/tasks/{a.id}/dependencies", json={"add": [dev.id]})
    assert r.status_code == 400 and "without their work" in r.json()["detail"]
    running = repo.add_task(pid, "run", target_branch="main", status=TaskStatus.IN_PROGRESS)
    assert client.post(f"/api/tasks/{running.id}/dependencies", json={"add": [a.id]}).status_code == 400
    assert client.post("/api/tasks/99999/dependencies", json={"add": [a.id]}).status_code == 404


def test_context_tells_an_agent_what_it_can_use(client, repo, pid, git_repo):
    caller, worktree = _running_card(repo, pid, git_repo)
    client.post("/api/agents", json={"name": "Senior", "description": "hard things", "effort": "high"})
    ctx = client.get("/api/tasks/context", params={"cwd": str(worktree)}).json()
    assert ctx["project"]["id"] == pid and ctx["caller"]["id"] == caller.id
    assert ctx["base_branch"] == "main" and "main" in ctx["branches"]
    assert ctx["agents"][0]["name"] == "Senior" and ctx["tasks"][0]["id"] == caller.id
    nowhere = client.get("/api/tasks/context", params={"cwd": "/"}).json()
    assert nowhere["project"] is None and nowhere["projects"][0]["name"] == "demo"
    assert client.get("/api/tasks/context", params={"project": "nope"}).status_code == 400


# ---------- the point of it all ----------

def _commit_and_report(task, name):
    wt = Path(task.worktree_path)
    (wt / name).write_text("done\n")
    git_ops.git(["add", name], wt)
    git_ops.git(["commit", "-m", f"feat: {name}"], wt)
    report = wt / REPORT_REL_PATH
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({"status": "success", "summary": "done"}))


def test_a_chain_runs_in_order_and_each_card_starts_from_the_work_before_it(client, repo, dispatcher, fake_cli, pid, git_repo):
    """The whole promise, on a real repository, on a base that is not the checked out branch."""
    _branch(git_repo, "feature")
    first, second = _batch(client, pid, [_card("First"), _card("Second")], sequential=True,
                           target_branch="feature", defaults={"status": "todo", "agent": any_agent(client)}).json()["created"]

    dispatcher.tick()
    one = repo.get_task(first["id"])
    assert one.status == TaskStatus.IN_PROGRESS and repo.get_task(second["id"]).status == TaskStatus.TODO

    _commit_and_report(one, "first.txt")
    fake_cli.set_state(one.job_id, "done")
    for _ in range(4):
        dispatcher.tick()
        dispatcher.verify_pool.wait(10)
        if repo.get_task(first["id"]).status == TaskStatus.DONE:
            break
    assert repo.get_task(first["id"]).status == TaskStatus.DONE

    dispatcher.tick()
    two = repo.get_task(second["id"])
    assert two.status == TaskStatus.IN_PROGRESS and two.target_branch == "feature"
    assert (Path(two.worktree_path) / "first.txt").exists(), "the second card must start from the first card's work"
    # The checked out branch was never touched: the whole chain lives on its own base
    assert not (git_repo / "first.txt").exists()
