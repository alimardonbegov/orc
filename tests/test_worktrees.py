"""Worktrees in .claude/worktrees: summary, manual deletion, auto cleanup and the HTTP layer."""
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from orc import git_ops, worktrees
from orc.worktrees import WorktreeError, WorktreeNeedsConfirm

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def no_lsof(monkeypatch):
    """The real lsof sees the processes of the developer's machine: tests substitute the table themselves."""
    monkeypatch.setattr(worktrees, "cwd_processes", lambda: {})


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _task_copy(repo, project, git_repo, status="done", done_at=None, **fields):
    """A task with a worktree exactly where the dispatcher creates it (Dispatcher._start)."""
    task = repo.add_task(project.id, "T", status=status)
    path = git_repo / ".claude" / "worktrees" / f"orc-task-{task.id}"
    git_ops.add_worktree(git_repo, path, f"orc/task-{task.id}", "main")
    task = repo.update_task(task.id, worktree_path=str(path), branch=f"orc/task-{task.id}",
                            target_branch="main", done_at=done_at, **fields)
    return task, path


def _commit(path, name="b.txt"):
    (path / name).write_text("x\n")
    _git(["add", name], path)
    _git(["commit", "-m", "work"], path)


def _item(view, name):
    return next(i for i in view["items"] if i["name"] == name)


def test_overview_describes_task_copy(repo, project, git_repo):
    task, path = _task_copy(repo, project, git_repo)
    (path / "big.bin").write_bytes(b"\0" * 200_000)
    view = worktrees.overview(repo, project)
    item = _item(view, path.name)
    assert item["kind"] == "task" and item["task_id"] == task.id and item["task_title"] == "T"
    assert item["branch"] == f"orc/task-{task.id}" and item["registered"] and item["exists"]
    assert item["merged"] is True and item["target"] == "main"
    assert item["dirty"] == 1  # big.bin is a new non-ignored file
    assert item["size_bytes"] >= 200_000 and view["total_bytes"] >= item["size_bytes"]
    assert item["delete_block"] is None and item["safe"] is False  # dirty, so not "safe"
    assert any("uncommitted" in w for w in item["delete_warnings"])
    assert any("Rework" in w for w in item["delete_warnings"]) is False  # there was no session


def test_overview_marks_foreign_stray_and_merge_copies(repo, project, git_repo):
    git_ops.add_worktree(git_repo, git_repo / ".claude" / "worktrees" / "my-feature", "feature", "main")
    (git_repo / ".claude" / "worktrees" / "leftover").mkdir(parents=True)
    view = worktrees.overview(repo, project)
    foreign = _item(view, "my-feature")
    assert foreign["kind"] == "foreign" and foreign["safe"] is False
    assert any("not an orchestrator task" in w for w in foreign["delete_warnings"])
    stray = _item(view, "leftover")
    assert stray["registered"] is False and any("git does not know this folder" in w for w in stray["delete_warnings"])


def test_running_task_copy_cannot_be_deleted(repo, project, git_repo):
    _task, path = _task_copy(repo, project, git_repo, status="in_progress")
    item = _item(worktrees.overview(repo, project), path.name)
    assert item["busy"] and item["in_use"] and "is working in it" in item["delete_block"]
    with pytest.raises(WorktreeError, match="is working in it"):
        worktrees.delete(repo, project, [path.name], force=True)
    assert path.exists()


def test_queued_rework_blocks_delete(repo, project, git_repo):
    _task, path = _task_copy(repo, project, git_repo, status="todo", resume_with="fix it")
    assert "rework" in _item(worktrees.overview(repo, project), path.name)["delete_block"]


def test_delete_merged_copy_drops_folder_and_branch(repo, project, git_repo):
    task, path = _task_copy(repo, project, git_repo, session_id="s1")
    item = _item(worktrees.overview(repo, project), path.name)
    assert item["safe"] is True
    # "Rework" would be lost: that is a warning, we do not delete without force
    with pytest.raises(WorktreeNeedsConfirm, match="Rework"):
        worktrees.delete(repo, project, [path.name])
    note = worktrees.delete(repo, project, [path.name], force=True)
    assert not path.exists() and f"orc/task-{task.id}" not in git_ops.list_branches(git_repo)
    assert "deleted" in note and "branches of merged tasks removed" in note
    assert git_ops.worktree_for_branch(git_repo, f"orc/task-{task.id}") is None


def test_delete_unmerged_copy_keeps_branch(repo, project, git_repo):
    task, path = _task_copy(repo, project, git_repo)
    _commit(path)
    item = _item(worktrees.overview(repo, project), path.name)
    assert item["merged"] is False and any("not merged" in w for w in item["delete_warnings"])
    with pytest.raises(WorktreeNeedsConfirm):
        worktrees.delete(repo, project, [path.name])
    worktrees.delete(repo, project, [path.name], force=True)
    assert not path.exists() and f"orc/task-{task.id}" in git_ops.list_branches(git_repo)


def test_batch_delete_skips_blocked(repo, project, git_repo):
    _busy, busy_path = _task_copy(repo, project, git_repo, status="verifying")
    _done, done_path = _task_copy(repo, project, git_repo)
    stray = git_repo / ".claude" / "worktrees" / "leftover"
    stray.mkdir()
    note = worktrees.delete(repo, project, [busy_path.name, done_path.name, stray.name], force=True)
    assert busy_path.exists() and not done_path.exists() and not stray.exists()
    assert "skipped" in note and busy_path.name in note


def test_delete_unknown_name_is_refused(repo, project, git_repo):
    with pytest.raises(WorktreeError, match="not found"):
        worktrees.delete(repo, project, ["../../etc"], force=True)


def test_processes_in_folder_are_a_warning(repo, project, git_repo, monkeypatch):
    _task, path = _task_copy(repo, project, git_repo)
    resolved = path.resolve()
    monkeypatch.setattr(worktrees, "cwd_processes",
                        lambda: {resolved / "web": [{"pid": 42, "name": "node"}]})
    item = _item(worktrees.overview(repo, project), path.name)
    assert item["processes"] == [{"pid": 42, "name": "node"}] and item["in_use"] and item["safe"] is False
    assert any("node (42)" in w for w in item["delete_warnings"])


def test_unknown_processes_are_reported_as_unknown(repo, project, git_repo, monkeypatch):
    monkeypatch.setattr(worktrees, "cwd_processes", lambda: None)
    _task, path = _task_copy(repo, project, git_repo)
    view = worktrees.overview(repo, project)
    assert view["processes_known"] is False and _item(view, path.name)["processes"] is None


def test_process_name_of_native_claude():
    assert worktrees._process_name("2.1.285") == "claude"
    assert worktrees._process_name("node") == "node"


# ---------- auto cleanup ----------

def test_autoclean_removes_only_old_clean_merged_copies(repo, project, git_repo):
    old = (NOW - timedelta(days=10)).isoformat()
    fresh = (NOW - timedelta(days=1)).isoformat()
    _t1, gone = _task_copy(repo, project, git_repo, done_at=old)
    _t2, young = _task_copy(repo, project, git_repo, done_at=fresh)
    _t3, dirty = _task_copy(repo, project, git_repo, done_at=old)
    (dirty / "wip.txt").write_text("not committed\n")
    _t4, unmerged = _task_copy(repo, project, git_repo, done_at=old)
    _commit(unmerged)
    _t5, failed = _task_copy(repo, project, git_repo, status="failed", done_at=old)
    removed = worktrees.autoclean(repo, project, NOW, days=7)
    assert [r["name"] for r in removed] == [gone.name]
    assert not gone.exists() and young.exists() and dirty.exists() and unmerged.exists() and failed.exists()


def test_autoclean_zero_days_takes_just_merged(repo, project, git_repo):
    _t, path = _task_copy(repo, project, git_repo, done_at=NOW.isoformat())
    assert [r["name"] for r in worktrees.autoclean(repo, project, NOW, days=0)] == [path.name]


def test_dispatcher_step_respects_setting_and_logs_event(repo, project, git_repo, dispatcher):
    dispatcher.now = lambda: NOW
    task, path = _task_copy(repo, project, git_repo, done_at=(NOW - timedelta(days=30)).isoformat())
    repo.set_setting("worktree_autoclean", "0")
    dispatcher._cleanup_worktrees()
    assert path.exists()
    repo.set_setting("worktree_autoclean", "1")
    dispatcher._cleanup_worktrees()
    assert not path.exists()
    events = [e["message"] for e in repo.list_events()]
    assert any(f"#{task.id}: working copy {path.name} removed" in m for m in events)


def test_dispatcher_step_is_throttled(repo, project, git_repo, dispatcher):
    dispatcher.now = lambda: NOW
    dispatcher._cleanup_worktrees()  # first pass: no candidates
    _t, path = _task_copy(repo, project, git_repo, done_at=(NOW - timedelta(days=30)).isoformat())
    dispatcher._cleanup_worktrees()
    assert path.exists()  # within the interval we do not search again
    dispatcher.now = lambda: NOW + timedelta(minutes=10)
    dispatcher._cleanup_worktrees()
    assert not path.exists()


# ---------- HTTP ----------

def _project(client, git_repo):
    return client.post("/api/projects", json={"name": "demo", "path": str(git_repo)}).json()


def test_api_overview_and_delete(client, repo, git_repo):
    proj = _project(client, git_repo)
    project = repo.get_project(proj["id"])
    task, path = _task_copy(repo, project, git_repo, session_id="s1")
    r = client.get("/api/git/worktrees", params={"project_id": proj["id"]})
    assert r.status_code == 200 and _item(r.json(), path.name)["task_id"] == task.id
    r = client.post("/api/git/worktrees/delete", json={"project_id": proj["id"], "names": [path.name]})
    assert r.status_code == 409 and "Rework" in r.json()["detail"]
    r = client.post("/api/git/worktrees/delete", json={"project_id": proj["id"], "names": [path.name], "force": True})
    assert r.status_code == 200 and r.json()["items"] == [] and "deleted" in r.json()["note"]
    assert not path.exists()


def test_api_delete_refuses_running(client, repo, git_repo):
    proj = _project(client, git_repo)
    _task, path = _task_copy(repo, repo.get_project(proj["id"]), git_repo, status="in_progress")
    r = client.post("/api/git/worktrees/delete", json={"project_id": proj["id"], "names": [path.name], "force": True})
    assert r.status_code == 400 and "is working in it" in r.json()["detail"]
    assert client.get("/api/git/worktrees", params={"project_id": 99}).status_code == 404


def test_api_settings_validate_worktree_keys(client):
    s = client.get("/api/settings").json()
    assert s["worktree_autoclean"] == "1" and s["worktree_retention_days"] == "7"
    assert client.patch("/api/settings", json={"worktree_autoclean": "yes"}).status_code == 400
    assert client.patch("/api/settings", json={"worktree_retention_days": "-1"}).status_code == 400
    r = client.patch("/api/settings", json={"worktree_autoclean": "0", "worktree_retention_days": "0"})
    assert r.status_code == 200 and r.json()["worktree_autoclean"] == "0" and r.json()["worktree_retention_days"] == "0"


def test_task_dir_pattern_ignores_similar_names(repo, project, git_repo):
    git_ops.add_worktree(git_repo, git_repo / ".claude" / "worktrees" / "orc-task-x", "x", "main")
    assert _item(worktrees.overview(repo, project), "orc-task-x")["kind"] == "foreign"
    assert Path(worktrees.root(project)) == git_repo / ".claude" / "worktrees"


def test_api_settings_start_min_free_mem_pct_is_percent(client, repo):
    assert client.patch("/api/settings", json={"start_min_free_mem_pct": "101"}).status_code == 400
    assert client.patch("/api/settings", json={"start_min_free_mem_pct": "-1"}).status_code == 400
    r = client.patch("/api/settings", json={"start_min_free_mem_pct": "100"})
    assert r.status_code == 200 and repo.get_setting("start_min_free_mem_pct", "") == "100"
