"""Viewing results: a finished task waits for the owner's glance, like an unread email."""
from datetime import timedelta

from orc import viewing
from orc.db import connect, init_schema
from orc.repo import Repo
from orc.util import utc_now


def _project(client, git_repo, **fields):
    return client.post("/api/projects", json={"name": "demo", "path": str(git_repo), **fields}).json()


def _done(client, repo, title="A", done_at=None):
    """A finished task: we set the status directly in the database; the path through the dispatcher is checked by its tests."""
    t = client.post("/api/tasks", json={"project_id": 1, "title": title, "description": "what to do"}).json()
    return repo.update_task(t["id"], status="done", done_at=done_at or repo.get_task(t["id"]).created_at)


def _ago(**delta) -> str:
    return (utc_now() - timedelta(**delta)).replace(microsecond=0).isoformat()


# ---------- what counts as unviewed ----------

def test_only_done_task_can_be_unviewed(client, repo, git_repo):
    _project(client, git_repo)
    backlog = client.post("/api/tasks", json={"project_id": 1, "title": "B", "description": "d"}).json()
    done = _done(client, repo)

    assert viewing.is_unviewed(done)
    assert not viewing.is_unviewed(repo.get_task(backlog["id"]))
    # A failure calls the person by itself ("Waiting for me"): a second mark on top of it would be noise
    assert not viewing.is_unviewed(repo.update_task(backlog["id"], status="failed"))
    # A card removed from the board no longer waits for a glance
    assert not viewing.is_unviewed(repo.update_task(done.id, archived_at=_ago(minutes=1)))


def test_redone_task_becomes_unviewed_again(client, repo, git_repo):
    """The task was viewed, sent back for rework, and closed again: the result is new,
    and the mark from the previous handoff does not apply to it."""
    _project(client, git_repo)
    task = _done(client, repo, done_at=_ago(hours=2))
    client.post(f"/api/tasks/{task.id}/viewed", json={"viewed": True})
    assert not viewing.is_unviewed(repo.get_task(task.id))

    redone = repo.update_task(task.id, status="done", done_at=(utc_now() + timedelta(minutes=5)).replace(microsecond=0).isoformat())
    assert viewing.is_unviewed(redone)


# ---------- marking a single task ----------

def test_viewed_marks_and_unmarks_task(client, repo, git_repo):
    _project(client, git_repo)
    task = _done(client, repo)
    assert client.get("/api/tasks").json()[0]["viewed_at"] is None

    r = client.post(f"/api/tasks/{task.id}/viewed", json={"viewed": True})
    assert r.status_code == 200 and r.json()["viewed_at"] is not None
    assert client.get("/api/tasks").json()[0]["viewed_at"] is not None

    # "Return to unviewed" is like "mark as unread" in email
    r = client.post(f"/api/tasks/{task.id}/viewed", json={"viewed": False})
    assert r.status_code == 200 and r.json()["viewed_at"] is None


def test_viewed_does_not_touch_updated_at(client, repo, git_repo):
    """A glance is not an edit: updated_at serves as the completion moment for tasks without done_at
    and as the "card changed" signal, and the view mark must not shift them."""
    _project(client, git_repo)
    task = _done(client, repo)
    repo._update("tasks", task.id, {"updated_at": "2026-01-01T00:00:00+00:00"})

    client.post(f"/api/tasks/{task.id}/viewed", json={"viewed": True})
    assert repo.get_task(task.id).updated_at == "2026-01-01T00:00:00+00:00"


def test_viewed_is_rejected_for_unfinished_and_missing_task(client, git_repo):
    _project(client, git_repo)
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "d"}).json()

    r = client.post(f"/api/tasks/{t['id']}/viewed", json={"viewed": True})
    assert r.status_code == 400 and "finished" in r.json()["detail"]
    assert client.post("/api/tasks/999/viewed", json={"viewed": True}).status_code == 404


# ---------- "mark all" ----------

def test_mark_all_viewed_marks_only_this_projects_done_tasks(client, repo, git_repo, tmp_path):
    _project(client, git_repo)
    other = repo.add_project("other", str(tmp_path / "other"))
    a, b = _done(client, repo, "A"), _done(client, repo, "B")
    waiting = client.post("/api/tasks", json={"project_id": 1, "title": "C", "description": "d"}).json()
    foreign = repo.add_task(other.id, "foreign", "d", status="done", done_at=_ago(minutes=1))

    r = client.post("/api/projects/1/mark-viewed")
    assert r.status_code == 200 and r.json() == {"viewed": 2}
    assert repo.get_task(a.id).viewed_at and repo.get_task(b.id).viewed_at
    assert repo.get_task(waiting["id"]).viewed_at is None
    assert repo.get_task(foreign.id).viewed_at is None
    # A repeat finds nothing: everything is already viewed
    assert client.post("/api/projects/1/mark-viewed").json() == {"viewed": 0}
    assert client.post("/api/projects/999/mark-viewed").status_code == 404


# ---------- project setting ----------

def test_viewed_is_on_by_default_and_switchable(client, git_repo):
    project = _project(client, git_repo)
    assert project["track_viewed"] == 1
    assert client.patch("/api/projects/1", json={"track_viewed": False}).json()["track_viewed"] == 0
    assert client.get("/api/projects").json()[0]["track_viewed"] == 0


def test_project_can_be_created_without_viewing(client, git_repo):
    assert _project(client, git_repo, track_viewed=False)["track_viewed"] == 0


def test_turning_viewing_on_keeps_only_recent_results_unviewed(client, repo, git_repo):
    """While viewing was off, nobody set marks. Enabling it must not dump
    the whole "Done" archive on the owner: only recent items remain unviewed."""
    _project(client, git_repo, track_viewed=False)
    old = _done(client, repo, "old", done_at=_ago(days=3))
    fresh = _done(client, repo, "fresh", done_at=_ago(hours=1))

    client.patch("/api/projects/1", json={"track_viewed": True})
    assert not viewing.is_unviewed(repo.get_task(old.id))
    assert viewing.is_unviewed(repo.get_task(fresh.id))


def test_saving_settings_with_viewing_already_on_marks_nothing(client, repo, git_repo):
    """The settings form sends all fields at once: track_viewed=true on a project where it is already
    enabled is not an enablement, and old unviewed tasks must not be touched."""
    _project(client, git_repo)
    old = _done(client, repo, "old", done_at=_ago(days=3))

    client.patch("/api/projects/1", json={"track_viewed": True, "max_workers": 3})
    assert viewing.is_unviewed(repo.get_task(old.id))


# ---------- migration ----------

def test_migration_keeps_only_last_day_unviewed(tmp_path):
    """A database that lived before viewing appeared: the whole "Done" archive does not become unviewed."""
    from orc import db

    conn = connect(tmp_path / "orc.db")
    init_schema(conn)
    repo = Repo(conn)
    project = repo.add_project("demo", "/tmp/demo")
    old = repo.add_task(project.id, "old", "d", status="done", done_at=_ago(days=5))
    fresh = repo.add_task(project.id, "fresh", "d", status="done", done_at=_ago(hours=2))
    failed = repo.add_task(project.id, "failed", "d", status="failed")

    # Roll the version back to the state "the viewing migration has not run yet" and bring the database up again
    conn.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION - 1}")
    conn.commit()
    init_schema(conn)

    assert repo.get_task(old.id).viewed_at is not None
    assert repo.get_task(fresh.id).viewed_at is None
    assert repo.get_task(failed.id).viewed_at is None
    init_schema(conn)  # a repeated run does not make a fresh task viewed
    assert repo.get_task(fresh.id).viewed_at is None
