"""The hook speaks only for its own task: the secret is issued together with the session."""
import json
import shlex
import stat
from pathlib import Path

from orc.models import TaskStatus


def _start_task(client, project, repo):
    """A task in in_progress with a recorded secret: the state the hook works in."""
    t = client.post("/api/tasks", json={"project_id": project.id, "title": "t",
                                        "description": "d"}).json()
    repo.update_task(t["id"], status="in_progress", session_id="s-1", hook_secret="secret-a")
    return repo.get_task(t["id"])


def _request(client, task_id, secret=None, tool_name="Bash"):
    headers = {"x-orc-hook": secret} if secret is not None else {}
    return client.post("/api/hooks/input-requests",
                       json={"task_id": task_id, "kind": "permission", "tool_name": tool_name},
                       headers=headers)


def test_hook_without_secret_is_rejected(client, project, repo):
    task = _start_task(client, project, repo)
    assert _request(client, task.id).status_code == 403


def test_hook_with_foreign_secret_is_rejected(client, project, repo):
    """Key regression: task A's secret does not open task B."""
    task = _start_task(client, project, repo)
    assert _request(client, task.id, "secret-b").status_code == 403


def test_hook_with_own_secret_passes(client, project, repo):
    task = _start_task(client, project, repo)
    assert _request(client, task.id, "secret-a").status_code == 201


def test_state_endpoint_requires_own_secret(client, project, repo):
    task = _start_task(client, project, repo)
    created = _request(client, task.id, "secret-a").json()
    url = f"/api/hooks/input-requests/{created['id']}"
    assert client.get(url).status_code == 403
    assert client.get(url, headers={"x-orc-hook": "secret-b"}).status_code == 403
    assert client.get(url, headers={"x-orc-hook": "secret-a"}).status_code == 200


def test_foreign_secret_does_not_cancel_open_request(client, project, repo):
    """The point of it all: a foreign call does not dismiss a live permission request."""
    task = _start_task(client, project, repo)
    created = _request(client, task.id, "secret-a").json()
    _request(client, task.id, "secret-b", tool_name="Read")
    state = client.get(f"/api/hooks/input-requests/{created['id']}",
                       headers={"x-orc-hook": "secret-a"}).json()["state"]
    assert state == "open"


def test_hook_for_task_without_secret_is_rejected(client, project, repo):
    """No secret issued (NULL, e.g. after a task reset): the hook does not pass with any header."""
    t = client.post("/api/tasks", json={"project_id": project.id, "title": "t",
                                        "description": "d"}).json()
    repo.update_task(t["id"], status="in_progress", session_id="s-1")
    assert _request(client, t["id"]).status_code == 403
    assert _request(client, t["id"], "anything").status_code == 403


def test_secret_is_issued_on_start_as_file(dispatcher, repo, project, fake_cli):
    """The secret appears together with the session: in the database, in a 0600 file and BY PATH (not by value)
    in the hook command line."""
    task = repo.add_task(project.id, "t", "d", status="todo")
    dispatcher.tick()
    started = repo.get_task(task.id)
    assert started.hook_secret
    secret_file = Path(started.worktree_path) / ".orchestrator" / "hook-secret"
    assert secret_file.read_text() == started.hook_secret
    assert stat.S_IMODE(secret_file.stat().st_mode) == 0o600
    # FakeClaudeCli writes tuples: ("start_bg", cwd, prompt, name, model, effort, mode, settings)
    settings = [c for c in fake_cli.calls if c[0] == "start_bg"][-1][7]
    command = json.loads(settings)["hooks"]["PermissionRequest"][0]["hooks"][0]["command"]
    assert command.endswith(f"--secret-file {shlex.quote(str(secret_file))}")
    assert started.hook_secret not in settings


def test_resume_with_new_settings_rotates_secret(dispatcher, repo, project, fake_cli):
    task = repo.add_task(project.id, "t", "d", status="todo")
    dispatcher.tick()
    first = repo.get_task(task.id)
    secret_file = Path(first.worktree_path) / ".orchestrator" / "hook-secret"

    # Waking a stopped session happens without settings, so the secret stays the same
    dispatcher.sessions.resume(first, "continue", stopped=True)
    assert repo.get_task(task.id).hook_secret == first.hook_secret
    assert secret_file.read_text() == first.hook_secret

    # A resume with new settings (done/failed → a session copy) issues a new secret
    repo.update_task(task.id, status=TaskStatus.FAILED)
    fake_cli.set_state(repo.get_task(task.id).job_id, "failed")  # failed session, no live process
    dispatcher.resume_failed(task.id)
    rotated = repo.get_task(task.id)
    assert rotated.hook_secret and rotated.hook_secret != first.hook_secret
    assert secret_file.read_text() == rotated.hook_secret


def test_retry_clears_secret(dispatcher, repo, project, fake_cli):
    task = repo.add_task(project.id, "t", "d", status="todo")
    dispatcher.tick()
    repo.update_task(task.id, status=TaskStatus.FAILED)
    dispatcher.retry(task.id)
    assert repo.get_task(task.id).hook_secret is None


def test_secret_never_leaves_api(client, project, repo):
    t = client.post("/api/tasks", json={"project_id": project.id, "title": "t",
                                        "description": "d"}).json()
    repo.update_task(t["id"], hook_secret="secret-a")
    assert "hook_secret" not in client.get(f"/api/tasks/{t['id']}").json()
    assert all("hook_secret" not in row for row in client.get("/api/tasks").json())
    assert "hook_secret" not in client.patch(f"/api/tasks/{t['id']}", json={"title": "u"}).json()
    repo.update_task(t["id"], status="failed")
    assert "hook_secret" not in client.post(f"/api/tasks/{t['id']}/retry").json()


def test_session_mismatch_is_logged_not_rejected(client, project, repo, caplog):
    task = _start_task(client, project, repo)  # session_id="s-1"
    with caplog.at_level("WARNING", logger="orc.dispatcher"):
        r = client.post("/api/hooks/input-requests",
                        json={"task_id": task.id, "session_id": "s-copy", "kind": "permission",
                              "tool_name": "Bash"},
                        headers={"x-orc-hook": "secret-a"})
    assert r.status_code == 201
    assert any("s-copy" in rec.message and "s-1" in rec.message for rec in caplog.records)
