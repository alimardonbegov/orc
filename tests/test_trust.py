"""Claude Code trust for task worktrees (orc/trust.py) and the untrusted blocker."""
import json
from pathlib import Path

from orc import trust
from orc.claude_cli import ClaudeCliError
from orc.models import Blocker, TaskStatus

UNTRUSTED_OUT = "Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry."


def _config(path: Path, projects: dict) -> None:
    path.write_text(json.dumps({"numStartups": 7, "projects": projects}))


def test_is_trusted_walks_up_to_parent_but_not_home(tmp_path, monkeypatch):
    cfg = tmp_path / "claude.json"
    parent, child = tmp_path / "Projects", tmp_path / "Projects" / "repo"
    child.mkdir(parents=True)
    _config(cfg, {trust.canonical(parent): {"hasTrustDialogAccepted": True}})
    assert trust.is_trusted(cfg, child)
    assert not trust.is_trusted_exactly(cfg, child)
    # Trust in the home directory does not extend to projects
    monkeypatch.setattr(Path, "home", staticmethod(lambda: parent))
    assert not trust.is_trusted(cfg, child)


def test_explicit_false_does_not_block_trusted_parent(tmp_path):
    cfg = tmp_path / "claude.json"
    child = tmp_path / "p" / "repo"
    child.mkdir(parents=True)
    _config(cfg, {trust.canonical(tmp_path / "p"): {"hasTrustDialogAccepted": True},
                  trust.canonical(child): {"hasTrustDialogAccepted": False}})
    assert trust.is_trusted(cfg, child)


def test_grant_and_revoke_keep_other_fields(tmp_path):
    cfg = tmp_path / "claude.json"
    wt = tmp_path / "wt"
    wt.mkdir()
    _config(cfg, {trust.canonical(wt): {"allowedTools": ["x"]}})
    cfg.chmod(0o600)
    trust.grant(cfg, wt)
    data = json.loads(cfg.read_text())
    assert data["numStartups"] == 7
    assert data["projects"][trust.canonical(wt)] == {"allowedTools": ["x"], "hasTrustDialogAccepted": True}
    assert cfg.stat().st_mode & 0o777 == 0o600
    trust.revoke(cfg, wt)
    assert trust.canonical(wt) not in json.loads(cfg.read_text())["projects"]


def test_start_trusts_worktree_of_trusted_project(repo, dispatcher, fake_cli, project):
    task = repo.add_task(project.id, "t", status=TaskStatus.TODO, description="d")
    dispatcher.tick()
    task = repo.get_task(task.id)
    assert task.status == TaskStatus.IN_PROGRESS
    assert trust.is_trusted_exactly(dispatcher.settings.claude_json_path, task.worktree_path)


def test_untrusted_project_fails_with_blocker_then_trust_button_starts(repo, dispatcher, fake_cli, project, client):
    cfg = dispatcher.settings.claude_json_path
    _config(cfg, {})
    task = repo.add_task(project.id, "t", status=TaskStatus.TODO, description="d")
    dispatcher.tick()
    task = repo.get_task(task.id)
    assert task.status == TaskStatus.FAILED and task.blocker == Blocker.UNTRUSTED
    assert project.path in task.blocker_detail
    assert task.worktree_path is None  # the worktree was removed, the retry will start from a clean slate
    assert not [c for c in fake_cli.calls if c[0] == "start_bg"]

    r = client.post(f"/api/tasks/{task.id}/trust")
    assert r.status_code == 200, r.text
    assert trust.is_trusted_exactly(cfg, project.path)
    dispatcher.tick()
    assert repo.get_task(task.id).status == TaskStatus.IN_PROGRESS


def test_trust_endpoint_only_for_untrusted_failures(repo, project, client):
    task = repo.add_task(project.id, "t", status=TaskStatus.FAILED, description="d")
    assert client.post(f"/api/tasks/{task.id}/trust").status_code == 400


def test_cli_refusal_regrants_and_retries_once(repo, dispatcher, fake_cli, project):
    cfg = dispatcher.settings.claude_json_path
    real_start = fake_cli.start_bg
    attempts = []

    def flaky_start(cwd, *args, **kwargs):
        attempts.append(cwd)
        if len(attempts) == 1:
            # A parallel Claude Code session overwrote our entry and the CLI refused
            trust.revoke(cfg, cwd)
            raise ClaudeCliError(UNTRUSTED_OUT)
        assert trust.is_trusted_exactly(cfg, cwd)
        return real_start(cwd, *args, **kwargs)

    fake_cli.start_bg = flaky_start
    task = repo.add_task(project.id, "t", status=TaskStatus.TODO, description="d")
    dispatcher.tick()
    assert len(attempts) == 2
    assert repo.get_task(task.id).status == TaskStatus.IN_PROGRESS


def test_persistent_cli_refusal_becomes_untrusted_blocker(repo, dispatcher, fake_cli, project):
    def refuse(*args, **kwargs):
        raise ClaudeCliError(UNTRUSTED_OUT)

    fake_cli.start_bg = refuse
    task = repo.add_task(project.id, "t", status=TaskStatus.TODO, description="d")
    dispatcher.tick()
    task = repo.get_task(task.id)
    assert task.status == TaskStatus.FAILED and task.blocker == Blocker.UNTRUSTED


def test_retry_revokes_worktree_trust(repo, dispatcher, fake_cli, project):
    task = repo.add_task(project.id, "t", status=TaskStatus.TODO, description="d")
    dispatcher.tick()
    wt = repo.get_task(task.id).worktree_path
    repo.update_task(task.id, status=TaskStatus.FAILED)
    dispatcher.retry(task.id)
    assert trust.canonical(wt) not in json.loads(dispatcher.settings.claude_json_path.read_text())["projects"]
