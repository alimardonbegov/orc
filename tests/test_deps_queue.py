"""Task queue with dependencies: end-to-end checks of "a blocked task waits in To do".

tests/test_scheduler.py checks the pure function ready_tasks with tables. Here it is the whole path
end to end: repository -> dispatcher tick -> HTTP API, because the bug "a task with unfinished
blockers goes straight to work" lives not in the selection function but in the seams around it.
"""
from __future__ import annotations

import pytest

from orc.models import TaskStatus
from tests.fakes import to_work


def _unlimited(repo, project):
    """Lift the worker limits: the tests are about dependencies, not throughput."""
    repo.update_project(project.id, max_workers=10)
    repo.set_setting("global_max_workers", "10")


# ---------- dispatcher ----------

@pytest.mark.parametrize("blocker_status", ["backlog", "todo", "in_progress", "verifying", "merging", "failed"])
def test_unfinished_blocker_keeps_task_in_todo(repo, dispatcher, fake_cli, project, blocker_status):
    """Any blocker status other than done keeps the task in the "To do" column."""
    _unlimited(repo, project)
    blocker = repo.add_task(project.id, "Blocker", status=blocker_status)
    task = repo.add_task(project.id, "Dependent", status="todo", depends_on=[blocker.id])

    dispatcher.tick()

    fresh = repo.get_task(task.id)
    assert fresh.status == TaskStatus.TODO
    # No worktree, no branch, no session: the task never started, rather than "started and rolled back"
    assert (fresh.worktree_path, fresh.branch, fresh.job_id) == (None, None, None)
    assert all(call[3] != f"orc#{task.id} Dependent" for call in fake_cli.calls if call[0] == "start_bg")


def test_task_starts_when_blocker_done(repo, dispatcher, project):
    _unlimited(repo, project)
    blocker = repo.add_task(project.id, "Blocker", status="done")
    task = repo.add_task(project.id, "Dependent", status="todo", depends_on=[blocker.id])

    dispatcher.tick()

    assert repo.get_task(task.id).status == TaskStatus.IN_PROGRESS


def test_all_blockers_must_be_done(repo, dispatcher, project):
    """AND semantics: one finished blocker is not enough, we wait for all of them."""
    _unlimited(repo, project)
    done = repo.add_task(project.id, "Finished", status="done")
    pending = repo.add_task(project.id, "Still running", status="in_progress")
    task = repo.add_task(project.id, "Dependent", status="todo", depends_on=[done.id, pending.id])

    dispatcher.tick()
    assert repo.get_task(task.id).status == TaskStatus.TODO

    repo.update_task(pending.id, status=TaskStatus.DONE)
    dispatcher.tick()
    assert repo.get_task(task.id).status == TaskStatus.IN_PROGRESS


def test_blocked_task_does_not_hold_the_queue(repo, dispatcher, project):
    """A blocked task does not occupy a worker slot: the next one in the queue starts."""
    repo.update_project(project.id, max_workers=1)
    blocker = repo.add_task(project.id, "Blocker", status="backlog")
    blocked = repo.add_task(project.id, "Dependent", status="todo", priority="high", depends_on=[blocker.id])
    free = repo.add_task(project.id, "Free", status="todo", priority="normal")

    dispatcher.tick()

    assert repo.get_task(blocked.id).status == TaskStatus.TODO
    assert repo.get_task(free.id).status == TaskStatus.IN_PROGRESS


def test_dependency_on_task_of_another_project(repo, dispatcher, project, tmp_path):
    """A dependency across projects works the same way: another project's unfinished blocker holds the task."""
    _unlimited(repo, project)
    # The other project is needed only as the blocker owner: its task does not start, the path is not touched
    other = repo.add_project("other", str(tmp_path / "other"))
    foreign = repo.add_task(other.id, "Foreign blocker", status="todo")
    task = repo.add_task(project.id, "Dependent", status="todo", depends_on=[foreign.id])

    dispatcher.tick()
    assert repo.get_task(task.id).status == TaskStatus.TODO

    repo.update_task(foreign.id, status=TaskStatus.DONE)
    dispatcher.tick()
    assert repo.get_task(task.id).status == TaskStatus.IN_PROGRESS


def test_blocker_done_in_the_same_tick_unblocks_next_tick(repo, dispatcher, fake_cli, project):
    """The blocker reached done within a tick: the dependent starts, but not before it is merged."""
    _unlimited(repo, project)
    blocker = repo.add_task(project.id, "Blocker", status="todo")
    task = repo.add_task(project.id, "Dependent", status="todo", depends_on=[blocker.id])

    dispatcher.tick()  # the blocker started, the dependent waits
    assert repo.get_task(blocker.id).status == TaskStatus.IN_PROGRESS
    assert repo.get_task(task.id).status == TaskStatus.TODO

    fake_cli.set_state(repo.get_task(blocker.id).job_id, "done")
    dispatcher.tick()  # done -> verifying -> (no report): the blocker is definitely not done
    assert repo.get_task(blocker.id).status != TaskStatus.DONE
    assert repo.get_task(task.id).status == TaskStatus.TODO


# ---------- repository: a task and its dependencies are written atomically ----------

def test_task_and_deps_are_written_atomically(repo, dispatcher, project):
    """A failure while inserting dependencies must not leave the task WITHOUT them.

    Otherwise a card with no links at all appears in todo: to the dispatcher it is ready to start,
    and it takes it into work although the owner specified blockers.
    """
    blocker = repo.add_task(project.id, "Blocker", status="todo")
    with pytest.raises(Exception):
        repo.add_task(project.id, "Dependent", status="todo", depends_on=[999999, blocker.id])

    assert [t.title for t in repo.list_tasks()] == ["Blocker"]
    assert repo.all_deps() == {}
    dispatcher.tick()
    assert [t.title for t in repo.list_tasks() if t.status == TaskStatus.IN_PROGRESS] == ["Blocker"]


# ---------- HTTP API ----------

def test_api_created_task_waits_until_blocker_is_done(client, git_repo):
    """The owner's whole path: create a blocker and a dependent, drag both to "To do", tick."""
    client.post("/api/projects", json={"name": "p", "path": str(git_repo), "max_workers": 10})
    blocker = client.post("/api/tasks", json={"project_id": 1, "title": "Blocker", "description": "what to do"}).json()
    task = client.post("/api/tasks", json={"project_id": 1, "title": "Dependent", "description": "what to do", "depends_on": [blocker["id"]]}).json()
    assert task["depends_on"] == [blocker["id"]]

    for t in (blocker, task):
        assert client.patch(f"/api/tasks/{t['id']}", json=to_work(client)).status_code == 200
    assert client.post("/api/dispatcher/tick").status_code == 200

    assert client.get(f"/api/tasks/{blocker['id']}").json()["status"] == "in_progress"
    assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "todo"


def test_api_deps_added_to_todo_task_take_effect(client, git_repo):
    """A dependency added to a task already sitting in "To do" holds it too."""
    client.post("/api/projects", json={"name": "p", "path": str(git_repo), "max_workers": 10})
    blocker = client.post("/api/tasks", json={"project_id": 1, "title": "Blocker", "description": "what to do"}).json()
    task = client.post("/api/tasks", json={"project_id": 1, "title": "Dependent", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{task['id']}", json=to_work(client))
    client.patch(f"/api/tasks/{task['id']}", json={"depends_on": [blocker["id"]]})

    client.post("/api/dispatcher/tick")
    assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "todo"


def test_api_rejects_self_dependency(client, git_repo):
    """A task depending on itself will never run: we do not let it be created."""
    client.post("/api/projects", json={"name": "p", "path": str(git_repo)})
    task = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    r = client.patch(f"/api/tasks/{task['id']}", json={"depends_on": [task["id"]]})
    assert r.status_code == 400 and "depend on itself" in r.json()["detail"]
    assert client.get(f"/api/tasks/{task['id']}").json()["depends_on"] == []


def test_api_rejects_dependency_cycle(client, git_repo):
    """A cycle A -> B -> C -> A is a queue that stands forever, we catch it on input."""
    client.post("/api/projects", json={"name": "p", "path": str(git_repo)})
    a = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    b = client.post("/api/tasks", json={"project_id": 1, "title": "B", "description": "what to do", "depends_on": [a["id"]]}).json()
    c = client.post("/api/tasks", json={"project_id": 1, "title": "C", "description": "what to do", "depends_on": [b["id"]]}).json()

    r = client.patch(f"/api/tasks/{a['id']}", json={"depends_on": [c["id"]]})
    assert r.status_code == 400 and "cycle" in r.json()["detail"]
    assert client.get(f"/api/tasks/{a['id']}").json()["depends_on"] == []


def test_duplicate_blocker_ids_are_collapsed(repo, dispatcher, project):
    """A repeated blocker in the list is not an insert error but the same blocker."""
    _unlimited(repo, project)
    blocker = repo.add_task(project.id, "Blocker", status="todo")
    task = repo.add_task(project.id, "Dependent", status="todo", depends_on=[blocker.id, blocker.id])
    assert repo.deps_of(task.id) == [blocker.id]

    repo.set_deps(task.id, [blocker.id, blocker.id])
    assert repo.deps_of(task.id) == [blocker.id]

    dispatcher.tick()
    assert repo.get_task(task.id).status == TaskStatus.TODO
