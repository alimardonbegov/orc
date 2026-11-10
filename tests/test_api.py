import json
import threading
import time
from pathlib import Path
from tests.fakes import any_agent, to_work


def test_projects_crud_and_validation(client, git_repo, tmp_path):
    r = client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    assert r.status_code == 201 and r.json()["max_workers"] == 2
    r = client.post("/api/projects", json={"name": "bad", "path": str(tmp_path / "nope")})
    assert r.status_code == 400
    r = client.patch("/api/projects/1", json={"verify_cmd": "pytest", "max_workers": 1})
    assert r.json()["verify_cmd"] == "pytest" and r.json()["max_workers"] == 1
    assert client.get("/api/projects").json()[0]["name"] == "demo"
    branches = client.get("/api/git/branches", params={"project_id": 1}).json()
    assert branches["current"] == "main" and branches["branches"] == ["main"]
    # Base of new tasks: while unset it is the current branch of the repository
    assert branches["default_branch"] is None and branches["base"] == "main"
    assert branches["items"][0]["name"] == "main" and branches["items"][0]["is_current"] is True


def test_project_position_is_stored_new_projects_default_to_null(client, git_repo):
    """position is the manual order in the sidebar (drag, see web/src/components/Sidebar.tsx).
    A fresh project does not have it: the list is sorted by id, as before."""
    a = client.post("/api/projects", json={"name": "demo", "path": str(git_repo)}).json()
    assert a["position"] is None
    r = client.patch(f"/api/projects/{a['id']}", json={"position": 20})
    assert r.json()["position"] == 20
    assert client.get("/api/projects").json()[0]["position"] == 20


def test_project_hidden_models_override_and_reset(client, git_repo):
    """Project hidden_models: null means no own list, the global one from the orc settings applies.
    The list comes and goes as a JSON array and is stored without repeats and empty ids."""
    a = client.post("/api/projects", json={"name": "demo", "path": str(git_repo)}).json()
    assert a["hidden_models"] is None
    r = client.patch(f"/api/projects/{a['id']}", json={"hidden_models": ["claude-opus-5", " ", "claude-opus-5", "x"]})
    assert r.status_code == 200 and r.json()["hidden_models"] == ["claude-opus-5", "x"]
    assert client.get("/api/projects").json()[0]["hidden_models"] == ["claude-opus-5", "x"]
    # An empty list is also its own: the project shows everything, even what is hidden in the orc settings
    assert client.patch(f"/api/projects/{a['id']}", json={"hidden_models": []}).json()["hidden_models"] == []
    # PATCH without the field leaves the list alone, null returns to the global one
    assert client.patch(f"/api/projects/{a['id']}", json={"max_workers": 1}).json()["hidden_models"] == []
    assert client.patch(f"/api/projects/{a['id']}", json={"hidden_models": None}).json()["hidden_models"] is None
    assert client.patch(f"/api/projects/{a['id']}", json={"hidden_models": "claude-opus-5"}).status_code == 422


def test_project_created_with_hidden_models(client, git_repo):
    r = client.post("/api/projects", json={"name": "demo", "path": str(git_repo), "hidden_models": ["claude-opus-5"]})
    assert r.status_code == 201 and r.json()["hidden_models"] == ["claude-opus-5"]


def test_broken_project_hidden_models_read_as_inherited(client, repo, git_repo):
    """A value corrupted by editing the database by hand does not break the project list."""
    a = client.post("/api/projects", json={"name": "demo", "path": str(git_repo)}).json()
    repo.update_project(a["id"], hidden_models="not json")
    assert client.get("/api/projects").json()[0]["hidden_models"] is None


def test_hidden_models_setting(client):
    assert client.get("/api/settings").json()["hidden_models"] == "[]"
    for bad in ("not json", json.dumps({"a": 1}), json.dumps([1, 2])):
        r = client.patch("/api/settings", json={"hidden_models": bad})
        assert r.status_code == 400 and "hidden_models" in r.json()["detail"]
    r = client.patch("/api/settings", json={"hidden_models": json.dumps(["claude-opus-5", "", "claude-opus-5"])})
    assert r.status_code == 200 and json.loads(r.json()["hidden_models"]) == ["claude-opus-5"]
    assert json.loads(client.get("/api/settings").json()["hidden_models"]) == ["claude-opus-5"]


def test_tasks_crud_deps_and_status_moves(client, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    a = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "d"}).json()
    assert a["status"] == "backlog" and a["target_branch"] == "main"
    b = client.post("/api/tasks", json={"project_id": 1, "title": "B", "description": "what to do", "depends_on": [a["id"]], "priority": "high"}).json()
    detail = client.get(f"/api/tasks/{b['id']}").json()
    assert detail["depends_on"] == [a["id"]] and detail["comments"] == []
    r = client.patch(f"/api/tasks/{a['id']}", json=to_work(client))
    assert r.json()["status"] == "todo"
    r = client.patch(f"/api/tasks/{a['id']}", json={"status": "done"})
    assert r.status_code == 400  # moving to done by hand is not allowed
    r = client.patch(f"/api/tasks/{b['id']}", json={"depends_on": [], "title": "B2"})
    assert r.json()["title"] == "B2" and client.get(f"/api/tasks/{b['id']}").json()["depends_on"] == []
    assert len(client.get("/api/tasks", params={"status": "todo"}).json()) == 1


def test_started_at_is_the_first_session_moment(client, repo, git_repo):
    """started_at is when the task was first taken into work (the first session). A task the
    agent has not reached yet does not have it; repeated sessions do not move it."""
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    a = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "d"}).json()
    assert a["started_at"] is None
    assert client.get("/api/tasks").json()[0]["started_at"] is None
    first = repo.add_task_session(a["id"], "job-1", None, None)
    repo.conn.execute("UPDATE task_sessions SET created_at = '2026-01-01T10:00:00+00:00' WHERE id = ?", (first["id"],))
    repo.conn.commit()
    repo.add_task_session(a["id"], "job-2", None, None)
    assert client.get(f"/api/tasks/{a['id']}").json()["started_at"] == "2026-01-01T10:00:00+00:00"
    assert client.get("/api/tasks").json()[0]["started_at"] == "2026-01-01T10:00:00+00:00"


def test_position_is_stored_new_tasks_default_to_null(client, git_repo):
    """position is the manual order inside a column (drag on the board, see web/src/components/Board.tsx).
    A fresh task does not have it: the board sorts such tasks by id, as before."""
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    a = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "d"}).json()
    assert a["position"] is None
    r = client.patch(f"/api/tasks/{a['id']}", json={"position": 20})
    assert r.json()["position"] == 20
    assert client.get(f"/api/tasks/{a['id']}").json()["position"] == 20


def test_comment_answer_routes_to_dispatcher(client, repo, dispatcher, fake_cli, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    client.post("/api/dispatcher/tick")
    fake_cli.set_state("job00001", "blocked", needs="?")
    client.post("/api/dispatcher/tick")
    fake_cli.stop_marks_stopped = True  # the daemon confirms the stop immediately
    r = client.post(f"/api/tasks/{t['id']}/comments", json={"body": "reply", "kind": "answer"})
    assert r.status_code == 201 and repo.get_task(t["id"]).job_id == "job00002"
    assert repo.pending_messages(t["id"]) == []  # delivered in the same request
    # The second message goes to the same session although the "waiting for a reply" badge is gone from it:
    # the session is running, so delivery goes through the inbox, not through a stop
    r = client.post(f"/api/tasks/{t['id']}/comments", json={"body": "more", "kind": "answer"})
    assert r.status_code == 201
    assert [m["state"] for m in repo.pending_messages(t["id"])] == ["sent"]
    r = client.post(f"/api/tasks/{t['id']}/comments", json={"body": "note", "kind": "comment"})
    assert r.status_code == 201
    r = client.post(f"/api/tasks/{t['id']}/comments", json={"body": "?", "kind": "unknown"})
    assert r.status_code == 400


def test_comment_rework_returns_done_task_to_todo(client, repo, dispatcher, fake_cli, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    client.post("/api/dispatcher/tick")
    # Rework from done is allowed, from in_progress it is not
    r = client.post(f"/api/tasks/{t['id']}/comments", json={"body": "rework it", "kind": "rework"})
    assert r.status_code == 400
    repo.update_task(t["id"], status="done")
    r = client.post(f"/api/tasks/{t['id']}/comments", json={"body": "rework it", "kind": "rework"})
    assert r.status_code == 201
    assert repo.get_task(t["id"]).status == "todo"
    assert repo.get_task(t["id"]).resume_with == "rework it"


def test_events_settings_dispatcher(client):
    assert client.get("/api/dispatcher").json()["paused"] is False
    client.post("/api/dispatcher/pause")
    assert client.get("/api/dispatcher").json()["paused"] is True
    client.post("/api/dispatcher/resume")
    r = client.patch("/api/settings", json={"global_max_workers": "2"})
    assert client.get("/api/settings").json()["global_max_workers"] == "2"
    assert "prompt_template" in client.get("/api/settings").json()
    client.post("/api/events/read")
    assert client.get("/api/events", params={"unread": 1}).json() == []


def test_dispatcher_status_reports_tick_metrics(client, dispatcher):
    dispatcher.tick()
    body = client.get("/api/dispatcher").json()
    assert body["last_tick_duration_sec"] is not None
    assert body["last_tick_duration_sec"] >= 0
    # Steps are listed by name: they show where exactly the pass spends its time
    assert "_start_ready" in body["last_tick_steps"]
    assert body["tick_error_count"] == 0
    assert body["verifying_now"] == []


def test_failed_step_is_counted(client, dispatcher, monkeypatch):
    def boom():
        raise RuntimeError("step failed")

    monkeypatch.setattr(dispatcher, "_start_ready", boom)
    dispatcher.tick()
    assert client.get("/api/dispatcher").json()["tick_error_count"] == 1


def test_retry_and_resume_endpoints(client, repo, git_repo, fake_cli):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    client.post("/api/dispatcher/tick")
    fake_cli.stop_marks_stopped = True  # the daemon confirms the stop: wake kills the live process and wakes the same job
    assert client.post(f"/api/tasks/{t['id']}/retry").status_code == 400  # not failed
    repo.update_task(t["id"], status="failed")
    assert client.post(f"/api/tasks/{t['id']}/resume").json()["status"] == "in_progress"
    repo.update_task(t["id"], status="failed")
    assert client.post(f"/api/tasks/{t['id']}/retry").json()["status"] == "todo"


def test_patch_failed_to_todo_goes_through_retry(client, repo, git_repo, fake_cli):
    # failed -> todo by hand must clean worktree/branch/job_id the same way as POST /retry,
    # otherwise the next dispatcher start would hit the already existing branch/worktree.
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    client.post("/api/dispatcher/tick")
    started = repo.get_task(t["id"])
    assert started.worktree_path and Path(started.worktree_path).exists()
    repo.update_task(t["id"], status="failed")

    r = client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "todo"
    assert body["worktree_path"] is None
    assert body["branch"] is None
    assert body["job_id"] is None
    assert not Path(started.worktree_path).exists()


def test_add_task_with_missing_dependency_returns_400(client, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    r = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do", "depends_on": [999999]})
    assert r.status_code == 400


def test_patch_task_with_missing_dependency_returns_400(client, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    r = client.patch(f"/api/tasks/{t['id']}", json={"depends_on": [999999]})
    assert r.status_code == 400


def test_empty_description_task_is_not_allowed_into_work(client, git_repo, repo):
    # The worker prompt receives the description itself (prompt.DEFAULT_TEMPLATE), so an empty
    # description means a session without an assignment: such a card is not sent to work.
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A"}).json()
    r = client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    assert r.status_code == 400 and "description is empty" in r.json()["detail"]
    assert repo.get_task(t["id"]).status == "backlog"
    # Whitespace does not count as a description, and the rejection must not write it into the card
    r = client.patch(f"/api/tasks/{t['id']}", json={"description": "   ", **to_work(client)})
    assert r.status_code == 400 and repo.get_task(t["id"]).description == ""
    # The description can be filled in and the task sent to work in a single request
    r = client.patch(f"/api/tasks/{t['id']}", json={"description": "do the job", **to_work(client)})
    assert r.status_code == 200 and r.json()["status"] == "todo"


def test_retry_of_task_without_description_is_refused(client, git_repo, repo):
    # Old cards could have gone to work without a description: a repeated start does not revive them
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A"}).json()
    repo.update_task(t["id"], status="failed", agent_id=any_agent(client))
    r = client.post(f"/api/tasks/{t['id']}/retry")
    assert r.status_code == 400 and "description is empty" in r.json()["detail"]
    r = client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    assert r.status_code == 400
    assert repo.get_task(t["id"]).status == "failed"


def test_manual_moves_todo_to_backlog_and_done_to_backlog(client, git_repo, repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    r = client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    assert r.json()["status"] == "todo"
    r = client.patch(f"/api/tasks/{t['id']}", json={"status": "backlog"})
    assert r.json()["status"] == "backlog"
    repo.update_task(t["id"], status="done")
    r = client.patch(f"/api/tasks/{t['id']}", json={"status": "backlog"})
    assert r.json()["status"] == "backlog"


def test_manual_moves_from_working_statuses_forbidden(client, git_repo, repo):
    # Working statuses are moved only by the dispatcher: a card from in_progress/verifying/merging
    # cannot be dragged anywhere by hand: that is the protection against breaking a live session.
    # The only exception is an emergency close to done, and it requires force=true
    # (see the tests below): without confirmation the answer is the same 400 as for forbidden transitions.
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    for working_status in ("in_progress", "verifying", "merging"):
        repo.update_task(t["id"], status=working_status)
        for target in ("backlog", "todo", "done", "failed"):
            r = client.patch(f"/api/tasks/{t['id']}", json={"status": target})
            assert r.status_code == 400, (working_status, target)
        assert repo.get_task(t["id"]).status == working_status


def test_force_done_closes_stuck_task_from_any_working_status(client, git_repo, repo):
    # This is what it was all for: the task is stuck in progress, the automation will not pull it out,
    # and the person closes the card by hand right on the board.
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    for working_status in ("in_progress", "verifying", "merging"):
        t = client.post("/api/tasks", json={"project_id": 1, "title": working_status, "description": "what to do"}).json()
        repo.update_task(t["id"], status=working_status)
        r = client.patch(f"/api/tasks/{t['id']}", json={"status": "done", "force": True})
        assert r.status_code == 200, working_status
        body = r.json()
        assert body["status"] == "done" and body["done_at"] is not None
        # A trace is left in the card: "done" without a report and without a merge would otherwise be inexplicable.
        assert any("closed manually" in c["body"] for c in body["comments"]), working_status


def test_force_done_closes_failed_task(client, git_repo, repo):
    # The task did not make it (failed): it can be closed by hand the same way as one stuck
    # in progress, without resending through retry and without resuming the session.
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    repo.update_task(t["id"], status="failed", blocker_detail="crashed")
    r = client.patch(f"/api/tasks/{t['id']}", json={"status": "done"})
    assert r.status_code == 400  # without force, same as for working statuses
    r = client.patch(f"/api/tasks/{t['id']}", json={"status": "done", "force": True})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "done" and body["done_at"] is not None
    assert any("closed manually" in c["body"] for c in body["comments"])


def test_force_done_stops_session_and_keeps_worktree(client, repo, dispatcher, fake_cli, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    client.post("/api/dispatcher/tick")
    started = repo.get_task(t["id"])
    assert started.status == "in_progress" and started.job_id

    r = client.patch(f"/api/tasks/{t['id']}", json={"status": "done", "force": True})
    assert r.status_code == 200 and r.json()["status"] == "done"
    # The session is always stopped: otherwise the agent would keep writing into the working copy
    # of the closed task and push it to verifying itself on the nearest tick.
    assert ("stop", started.job_id) in fake_cli.calls
    closed = repo.get_task(t["id"])
    # But the working copy and the branch are left alone: the work is not merged, pick it up by hand.
    assert closed.worktree_path == started.worktree_path and closed.branch == started.branch
    assert closed.blocker is None and "closed manually" in closed.blocker_detail
    # The dispatcher no longer touches the closed task: a tick does not return it to work.
    client.post("/api/dispatcher/tick")
    assert repo.get_task(t["id"]).status == "done"


def test_force_done_fails_undelivered_messages(client, repo, dispatcher, fake_cli, git_repo):
    # Nobody is left to pick up the queued message: it must not hang as "waiting for delivery".
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    client.post("/api/dispatcher/tick")
    client.post(f"/api/tasks/{t['id']}/comments", json={"body": "wait", "kind": "answer"})
    assert repo.pending_messages(t["id"])

    client.patch(f"/api/tasks/{t['id']}", json={"status": "done", "force": True})
    assert repo.pending_messages(t["id"]) == []
    assert repo.get_task(t["id"]).outbox_state is None


def test_force_flag_does_not_open_other_manual_moves(client, git_repo, repo):
    # force confirms exactly one transition (to done), it is not a skeleton key for all of them.
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    repo.update_task(t["id"], status="in_progress")
    for target in ("backlog", "todo", "failed"):
        r = client.patch(f"/api/tasks/{t['id']}", json={"status": target, "force": True})
        assert r.status_code == 400, target
    # And conversely: for an ordinary task force breaks nothing and is not recorded anywhere.
    repo.update_task(t["id"], status="backlog")
    r = client.patch(f"/api/tasks/{t['id']}", json={**to_work(client), "force": True})
    assert r.status_code == 200 and r.json()["status"] == "todo"


def test_resume_raises_400_when_not_failed(client, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    # the task is in backlog: resume is only for failed with a session
    r = client.post(f"/api/tasks/{t['id']}/resume")
    assert r.status_code == 400


def test_add_task_validation_errors(client, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    r = client.post("/api/tasks", json={"project_id": 999, "title": "A", "description": "what to do"})
    assert r.status_code == 400
    r = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do", "permission_mode": "auto"})
    assert r.status_code == 422  # the card holds no run parameters of its own: they belong to its agent


# ---------- concurrency, settings validation, blocker, requires_review ----------


def test_tick_endpoint_returns_409_when_dispatcher_is_busy(client, dispatcher):
    # The background thread is already running a pass: a second pass from HTTP must not be started
    # (two git merges in one working copy, two worktrees for one task), but blocking
    # the request for the whole 15 minutes of verify is not allowed either.
    assert dispatcher._lock.acquire(blocking=False)
    try:
        r = client.post("/api/dispatcher/tick")
        assert r.status_code == 409
        assert "pass" in r.json()["detail"]
    finally:
        dispatcher._lock.release()
    assert client.post("/api/dispatcher/tick").status_code == 200


def test_busy_dispatcher_answers_409(client, repo, dispatcher, project, monkeypatch):
    import orc.dispatcher as dispatcher_module

    monkeypatch.setattr(dispatcher_module, "COMMAND_LOCK_TIMEOUT_SEC", 0.1)
    task = repo.add_task(project.id, "A", status="backlog")

    holding, release = threading.Event(), threading.Event()

    def hold():
        with dispatcher._exclusive(None):
            holding.set()
            release.wait(5)

    keeper = threading.Thread(target=hold)
    keeper.start()
    holding.wait(5)
    try:
        response = client.post(f"/api/tasks/{task.id}/archive")
        assert response.status_code == 409
        assert "busy" in response.json()["detail"]
        # unarchive_task did not wrap the dispatcher call in try: the exception handler
        # in create_app covers it as well
        response = client.post(f"/api/tasks/{task.id}/unarchive")
        assert response.status_code == 409
    finally:
        release.set()
        keeper.join(5)


def test_ticks_do_not_overlap(dispatcher, monkeypatch):
    # Two simultaneous tick() calls must queue up, not run in parallel.
    overlaps = []
    inside = []

    def slow_step():
        inside.append(1)
        overlaps.append(len(inside))
        time.sleep(0.05)
        inside.pop()

    monkeypatch.setattr(dispatcher, "_sync_running", slow_step)
    threads = [threading.Thread(target=dispatcher.tick) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert overlaps == [1, 1]  # there were never two passes inside a step at the same time


def test_settings_validation_rejects_garbage(client):
    # PATCH /api/settings accepted anything, and it failed later in a tick, silently killing
    # the dispatcher steps and leaving the owner with a frozen board and no explanation.
    bad = [
        {"global_max_workers": "many"},
        {"global_max_workers": "0"},
        {"poll_interval_sec": "fast"},
        {"poll_interval_sec": "1"},
        {"quota_patterns": "not json"},
        {"quota_patterns": json.dumps(["(unclosed paren"])},
        {"quota_patterns": json.dumps({"a": 1})},
        {"prompt_template": "Task: {title"},
        {"conflict_prompt_template": "Merge {target_branch"},
        {"conflict_autoresolve": "yes"},
    ]
    for body in bad:
        r = client.patch("/api/settings", json=body)
        assert r.status_code == 400, body
        assert list(body)[0] in r.json()["detail"], body  # the text names the field
    ok = {"global_max_workers": "4", "poll_interval_sec": "10",
          "quota_patterns": json.dumps([r"\blimit\b"]), "prompt_template": "Task {title}",
          "conflict_autoresolve": "0", "conflict_prompt_template": "Merge {target_branch} into {branch}"}
    assert client.patch("/api/settings", json=ok).status_code == 200
    settings = client.get("/api/settings").json()
    assert settings["global_max_workers"] == "4"
    assert settings["conflict_autoresolve"] == "0"


def test_verify_workers_setting_is_validated(client):
    assert client.patch("/api/settings", json={"verify_workers": "0"}).status_code == 400
    assert client.patch("/api/settings", json={"verify_workers": "two"}).status_code == 400
    assert client.patch("/api/settings", json={"verify_workers": "3"}).status_code == 200
    assert client.get("/api/settings").json()["verify_workers"] == "3"


def test_patch_blocker_can_only_be_cleared(client, repo, git_repo):
    # blocker accepted any string bypassing the Blocker enumeration.
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    repo.update_task(t["id"], status="merging", blocker="conflict", blocker_detail="sort it out")
    assert client.patch(f"/api/tasks/{t['id']}", json={"blocker": "quota"}).status_code == 400
    assert client.patch(f"/api/tasks/{t['id']}", json={"blocker": "nonsense"}).status_code == 400
    r = client.patch(f"/api/tasks/{t['id']}", json={"blocker": None})
    assert r.status_code == 200 and r.json()["blocker"] is None


def test_clearing_conflict_badge_resets_the_retry_counter(client, repo, git_repo):
    # The person untangled the branches by hand, so the task is again entitled to automatic
    # resolution if the next merge runs into someone else's commits again.
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    repo.update_task(t["id"], status="merging", blocker="conflict", conflict_retry_count=3)
    r = client.patch(f"/api/tasks/{t['id']}", json={"blocker": None})
    assert r.status_code == 200 and r.json()["conflict_retry_count"] == 0


def test_patch_target_branch_only_in_idle_statuses(client, repo, git_repo):
    # The worktree is created from one base, while the merge would go to another branch.
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    client.post("/api/git/branches", json={"project_id": 1, "name": "dev"})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    assert client.patch(f"/api/tasks/{t['id']}", json={"target_branch": "dev"}).json()["target_branch"] == "dev"
    for status in ("in_progress", "verifying", "merging", "done"):
        repo.update_task(t["id"], status=status)
        r = client.patch(f"/api/tasks/{t['id']}", json={"target_branch": "main"})
        assert r.status_code == 400, status
    repo.update_task(t["id"], status="failed")
    assert client.patch(f"/api/tasks/{t['id']}", json={"target_branch": "main"}).status_code == 200


def test_requires_review_is_refused_like_rework(client, git_repo):
    # requires_review was accepted and silently ignored, although rework was rejected with 400.
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    r = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do", "requires_review": True})
    assert r.status_code == 400 and "not supported" in r.json()["detail"]
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    r = client.patch(f"/api/tasks/{t['id']}", json={"requires_review": True})
    assert r.status_code == 400
    r = client.post(f"/api/tasks/{t['id']}/comments", json={"body": "redo it", "kind": "rework"})
    assert r.status_code == 400


def test_answer_accepts_interrupt_mode_and_reports_outbox(client, repo, dispatcher, fake_cli, git_repo):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    t = client.post("/api/tasks", json={"project_id": 1, "title": "A", "description": "what to do"}).json()
    client.patch(f"/api/tasks/{t['id']}", json=to_work(client))
    client.post("/api/dispatcher/tick")

    r = client.post(f"/api/tasks/{t['id']}/comments", json={"body": "stop", "kind": "answer", "mode": "interrupt"})
    assert r.status_code == 201
    assert r.json()["outbox_state"] == "stopping"
    assert [m["mode"] for m in r.json()["outbox"]] == ["interrupt"]

    r = client.post(f"/api/tasks/{t['id']}/comments", json={"body": "?", "kind": "answer", "mode": "weird"})
    assert r.status_code == 400
