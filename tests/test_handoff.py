"""Handing in the work: `orc task done` and `orc task fail`, the dispatcher's reading of them, the owner's
way out, and the transition from report.json."""
import json
import os
import time
from pathlib import Path

import pytest

from orc import db, git_ops, handoff, inputs, task_cli, task_guide
from orc.db import connect, init_schema
from orc.handoff import REPORT_REL_PATH
from orc.main import parse_args
from orc.models import Blocker, TaskStatus
from orc.prompt import DEFAULT_TEMPLATE


def _iso(at: float) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(at, tz=timezone.utc).isoformat()


def _started(repo, dispatcher, project, **fields):
    t = repo.add_task(project.id, "A", "the job", status="todo", **fields)
    dispatcher.tick()
    return repo.get_task(t.id)


def _end_turn(fake_cli, task, tmp_path, started_at: float | None = None, final_text: str = "Result of the work"):
    """The session ended its turn long enough ago for orc to believe it."""
    started_at = time.time() - 3600 if started_at is None else started_at
    path = tmp_path / f"session-{task.id}.jsonl"
    entries = [{"type": "user", "timestamp": _iso(started_at), "message": {"content": "Task: do X"}},
               {"type": "assistant", "message": {"content": [{"type": "text", "text": final_text}]}}]
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n")
    old = time.time() - 600
    os.utime(path, (old, old))
    fake_cli.set_state(task.job_id, "working", tempo="idle", transcript_path=str(path))
    return path


def _hook(repo, task_id):
    return {"x-orc-hook": repo.get_task(task_id).hook_secret or ""}


def _write_report(task, status="success", summary="from the file", notes="", at: float | None = None):
    p = Path(task.worktree_path) / REPORT_REL_PATH
    p.parent.mkdir(exist_ok=True)
    p.write_text(json.dumps({"status": status, "summary": summary, "notes": notes}))
    if at is not None:
        os.utime(p, (at, at))


# ---------- a turn: done, fail, neither ----------

def test_turn_with_done_goes_to_verification_and_releases_the_session(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _started(repo, dispatcher, project)
    r = client.post(f"/api/hooks/tasks/{t.id}/handoff", json={"status": "done", "summary": "built it"}, headers=_hook(repo, t.id))
    assert r.status_code == 200 and r.json()["handoff_status"] == "done"
    # Only recorded: the agent is still in its turn, and shutting it down here would cut off its final words
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS
    assert ("stop", t.job_id) not in fake_cli.calls
    _end_turn(fake_cli, t, tmp_path)
    dispatcher._sync_running()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.VERIFYING and t.blocker is None
    assert ("stop", t.job_id) in fake_cli.calls
    assert json.loads(t.report_json) == {"status": "success", "summary": "built it", "notes": ""}


def test_done_without_a_summary_takes_the_final_message(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _started(repo, dispatcher, project)
    client.post(f"/api/hooks/tasks/{t.id}/handoff", json={"status": "done"}, headers=_hook(repo, t.id))
    _end_turn(fake_cli, t, tmp_path, final_text="Everything is in the branch")
    dispatcher._sync_running()
    assert json.loads(repo.get_task(t.id).report_json)["summary"] == "Everything is in the branch"


def test_turn_with_fail_goes_to_failed_with_the_reason_and_no_second_try(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _started(repo, dispatcher, project)
    r = client.post(f"/api/hooks/tasks/{t.id}/handoff", json={"status": "failed", "summary": "no access to the API"},
                    headers=_hook(repo, t.id))
    assert r.status_code == 200
    _end_turn(fake_cli, t, tmp_path)
    dispatcher._sync_running()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and t.blocker_detail == "no access to the API"
    assert not [c for c in fake_cli.calls if c[0] == "resume_bg"]
    assert json.loads(t.report_json)["status"] == "failed"


def test_fail_needs_a_reason(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    r = client.post(f"/api/hooks/tasks/{t.id}/handoff", json={"status": "failed", "summary": "  "}, headers=_hook(repo, t.id))
    assert r.status_code == 400 and repo.get_task(t.id).handoff_status is None


def test_turn_with_neither_waits_for_the_owner(repo, dispatcher, fake_cli, project, tmp_path):
    t = _started(repo, dispatcher, project)
    _end_turn(fake_cli, t, tmp_path, final_text="Which of the two do you want?")
    dispatcher._sync_running()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.blocker == Blocker.NEEDS_INPUT
    assert "Which of the two" in t.blocker_detail


def test_a_signal_from_a_previous_turn_is_stale(repo, dispatcher, fake_cli, project, tmp_path):
    t = _started(repo, dispatcher, project)
    handoff.record(repo, t.id, handoff.STATUS_DONE, "old", at=time.time() - 7200)
    _end_turn(fake_cli, t, tmp_path, started_at=time.time() - 3600)
    dispatcher._sync_running()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.blocker == Blocker.NEEDS_INPUT


def test_a_message_on_its_way_holds_the_handoff_back(repo, dispatcher, fake_cli, project, tmp_path):
    t = _started(repo, dispatcher, project)
    handoff.record(repo, t.id, handoff.STATUS_DONE, "done")
    repo.update_task(t.id, outbox_state="queued")
    _end_turn(fake_cli, t, tmp_path)
    dispatcher._sync_running()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS


def test_an_open_input_request_holds_the_handoff_back(repo, dispatcher, fake_cli, project, tmp_path):
    t = _started(repo, dispatcher, project)
    handoff.record(repo, t.id, handoff.STATUS_DONE, "done")
    dispatcher.request_input(t.id, "permission", "Bash", {"command": "rm x"})
    _end_turn(fake_cli, t, tmp_path)
    dispatcher._sync_running()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS


# ---------- what the server refuses ----------

def test_the_handoff_endpoint_takes_only_the_secret_of_that_task(repo, dispatcher, project, client):
    a, b = _started(repo, dispatcher, project), _started(repo, dispatcher, project)
    url = f"/api/hooks/tasks/{a.id}/handoff"
    assert client.post(url, json={"status": "done"}).status_code == 403
    assert client.post(url, json={"status": "done"}, headers=_hook(repo, b.id)).status_code == 403
    assert repo.get_task(a.id).handoff_status is None
    assert client.post("/api/hooks/tasks/999999/handoff", json={"status": "done"}).status_code == 404


def test_done_refuses_on_uncommitted_tracked_changes_and_names_them(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    (Path(t.worktree_path) / "a.txt").write_text("changed\n")
    r = client.post(f"/api/hooks/tasks/{t.id}/handoff", json={"status": "done"}, headers=_hook(repo, t.id))
    assert r.status_code == 409 and "a.txt" in r.json()["detail"]
    assert repo.get_task(t.id).handoff_status is None
    # Failing with a mess in the copy is fine: the owner has to look at it anyway
    r = client.post(f"/api/hooks/tasks/{t.id}/handoff", json={"status": "failed", "summary": "stuck"}, headers=_hook(repo, t.id))
    assert r.status_code == 200


def test_done_names_untracked_files_without_refusing(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    (Path(t.worktree_path) / "new.txt").write_text("forgotten?\n")
    r = client.post(f"/api/hooks/tasks/{t.id}/handoff", json={"status": "done"}, headers=_hook(repo, t.id))
    assert r.status_code == 200 and r.json()["untracked"] == ["new.txt"]


def test_done_allows_a_branch_with_no_commits(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    r = client.post(f"/api/hooks/tasks/{t.id}/handoff", json={"status": "done"}, headers=_hook(repo, t.id))
    assert r.status_code == 200 and r.json()["untracked"] == []


def test_done_refuses_a_task_that_is_not_in_progress(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    repo.update_task(t.id, status="verifying")
    r = client.post(f"/api/hooks/tasks/{t.id}/handoff", json={"status": "done"}, headers=_hook(repo, t.id))
    assert r.status_code == 409


def test_uncommitted_files_reads_renames_and_spaces(git_repo):
    (git_repo / "b c.txt").write_text("x\n")
    git_ops.git(["mv", "a.txt", "moved.txt"], git_repo)
    tracked, untracked = git_ops.uncommitted_files(git_repo)
    assert tracked == ["moved.txt"] and untracked == ["b c.txt"]


# ---------- the command ----------

@pytest.fixture
def through_api(client, dispatcher, monkeypatch):
    """The real API instead of a socket, with the header the real transport would send. The command runs
    against this server's data directory, as `task_guide.cli_command` makes it do."""
    monkeypatch.setenv("ORC_DATA_DIR", str(dispatcher.settings.data_dir))
    def call(method, path, payload, hook_secret=None):
        headers = {"x-orc-hook": hook_secret} if hook_secret is not None else {}
        r = client.request(method, path, json=payload, headers=headers) if payload is not None else client.request(method, path)
        if r.status_code >= 400:
            raise task_cli.CliError(task_cli._error_text(r.text))
        return r.json()
    return call


def _cli(argv, call, capsys):
    code = task_cli.run(parse_args(["task", *argv]), call)
    out = capsys.readouterr()
    return code, out.out, out.err


def test_cli_done_from_the_session_folder(repo, dispatcher, project, through_api, capsys, monkeypatch):
    t = _started(repo, dispatcher, project)
    (Path(t.worktree_path) / "sub").mkdir()
    monkeypatch.chdir(Path(t.worktree_path) / "sub")  # the secret is found by walking up
    code, out, _ = _cli(["done", "--summary", "built"], through_api, capsys)
    assert code == 0 and f"#{t.id} handed in" in out
    assert repo.get_task(t.id).handoff_status == "done"
    assert json.loads(repo.get_task(t.id).report_json)["summary"] == "built"


def test_cli_done_reads_a_summary_file_and_warns_about_untracked(repo, dispatcher, project, through_api, capsys, monkeypatch, tmp_path):
    t = _started(repo, dispatcher, project)
    monkeypatch.chdir(t.worktree_path)
    (Path(t.worktree_path) / "new.txt").write_text("x\n")
    summary = tmp_path / "s.txt"
    summary.write_text("from a file")
    code, out, _ = _cli(["done", "--summary-file", str(summary)], through_api, capsys)
    assert code == 0 and "untracked" in out and "new.txt" in out
    assert json.loads(repo.get_task(t.id).report_json)["summary"] == "from a file"
    code, _, err = _cli(["done", "--summary", "a", "--summary-file", "b"], through_api, capsys)
    assert code == 1 and "pick one" in err


def test_cli_fail_requires_a_reason(repo, dispatcher, project, through_api, capsys, monkeypatch):
    t = _started(repo, dispatcher, project)
    monkeypatch.chdir(t.worktree_path)
    with pytest.raises(SystemExit):
        parse_args(["task", "fail"])
    capsys.readouterr()
    code, _, _ = _cli(["fail", "--reason", "no way"], through_api, capsys)
    assert code == 0 and repo.get_task(t.id).handoff_status == "failed"


def test_cli_hands_in_after_the_working_copy_was_deleted_and_made_again(repo, dispatcher, project, git_repo, through_api,
                                                                      capsys, monkeypatch):
    """A cleanup script removed the worktree under a live session, and the agent made it again with git."""
    t = _started(repo, dispatcher, project)
    git_ops.git(["worktree", "remove", "--force", t.worktree_path], git_repo)
    git_ops.git(["worktree", "add", t.worktree_path, t.branch], git_repo)
    monkeypatch.chdir(t.worktree_path)
    code, out, err = _cli(["done"], through_api, capsys)
    assert code == 0, err
    assert repo.get_task(t.id).handoff_status == "done"


def test_cli_falls_back_to_a_secret_issued_in_the_working_copy(repo, dispatcher, project, through_api, capsys,
                                                                monkeypatch):
    """A session issued before the secret moved still has it in its working copy, and nowhere else."""
    t = _started(repo, dispatcher, project)
    inputs.hook_secret_path(dispatcher.settings.data_dir, t.id).unlink()
    legacy = Path(t.worktree_path) / inputs.LEGACY_HOOK_SECRET_REL_PATH
    inputs.write_hook_secret(legacy, t.hook_secret)
    monkeypatch.chdir(t.worktree_path)
    assert _cli(["done"], through_api, capsys)[0] == 0
    assert repo.get_task(t.id).handoff_status == "done"


def test_a_new_session_drops_the_legacy_copy_and_deleting_the_card_drops_the_secret(repo, dispatcher, project):
    t = repo.add_task(project.id, "A", "the job", status="todo")
    dispatcher.tick()
    t = repo.get_task(t.id)
    legacy = Path(t.worktree_path) / inputs.LEGACY_HOOK_SECRET_REL_PATH
    inputs.write_hook_secret(legacy, "old")
    dispatcher.sessions.issue_hook_secret(t)
    assert not legacy.exists()
    path = inputs.hook_secret_path(dispatcher.settings.data_dir, t.id)
    assert path.exists()
    dispatcher.delete_task(t.id, force=True)
    assert not path.exists()


def test_cli_refuses_outside_a_card(repo, project, git_repo, through_api, capsys, monkeypatch):
    # A chat runs in the project folder, not in the worktree of a card
    monkeypatch.chdir(git_repo)
    code, _, err = _cli(["done"], through_api, capsys)
    assert code == 1 and "not the worktree of any card" in err


def test_cli_refuses_uncommitted_changes(repo, dispatcher, project, through_api, capsys, monkeypatch):
    t = _started(repo, dispatcher, project)
    monkeypatch.chdir(t.worktree_path)
    (Path(t.worktree_path) / "a.txt").write_text("changed\n")
    code, _, err = _cli(["done"], through_api, capsys)
    assert code == 1 and "a.txt" in err


def test_cli_with_a_secret_needs_no_dashboard_token(tmp_path, monkeypatch):
    monkeypatch.setenv("ORC_URL", "http://127.0.0.1:9")
    call = task_cli.http_transport(tmp_path)  # no pult-token in this folder
    with pytest.raises(task_cli.CliError, match="not answering"):
        call("POST", "/api/hooks/tasks/1/handoff", {}, hook_secret="s")
    with pytest.raises(task_cli.CliError, match="no token"):
        call("POST", "/api/tasks/batch", {})


def test_session_settings_allow_exactly_the_handoff_attach_and_wakeup_commands(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    settings = json.loads(dispatcher.sessions.session_settings(repo.get_task(t.id)))
    command = task_guide.cli_command(dispatcher.settings.data_dir)
    assert settings["permissions"]["allow"] == [
        f"Bash({command} task done:*)", f"Bash({command} task fail:*)", f"Bash({command} task attach:*)",
        f"Bash({command} task wakeup:*)"]
    assert f"`{command} task done`" in task_guide.session_note(dispatcher.settings.data_dir, t.id)


# ---------- verification reads the database ----------

def test_verification_reads_the_handoff_from_the_database(repo, dispatcher, fake_cli, project, settle):
    repo.update_project(project.id, verify_cmd="true")
    t = _started(repo, dispatcher, project)
    handoff.record(repo, t.id, handoff.STATUS_DONE, "done")
    repo.update_task(t.id, status="verifying")
    settle()
    t = repo.get_task(t.id)
    assert t.status in (TaskStatus.MERGING, TaskStatus.DONE)
    assert json.loads(t.report_json)["summary"] == "done"


def test_a_session_that_never_handed_in_is_sent_back_once(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "done")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.auto_resume_count == 1
    command = task_guide.cli_command(dispatcher.settings.data_dir)
    assert f"run `{command} task done` again" in fake_cli.calls[-1][3]


def test_retry_and_rework_clear_the_handoff(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    handoff.record(repo, t.id, handoff.STATUS_FAILED, "gave up")
    repo.update_task(t.id, status="failed")
    t = dispatcher.retry(t.id)
    assert t.handoff_at is None and t.handoff_status is None

    t = _started(repo, dispatcher, project)
    handoff.record(repo, t.id, handoff.STATUS_DONE, "done")
    _write_report(t)
    repo.update_task(t.id, status="done")
    t = dispatcher.rework(t.id, "once more")
    assert t.handoff_at is None and t.handoff_status is None
    assert not (Path(t.worktree_path) / REPORT_REL_PATH).exists()


def test_conflict_session_does_not_reuse_the_old_handoff(repo, dispatcher, fake_cli, project, git_repo):
    """An unresolved conflict must not walk back into the merge on the signal of the previous pass."""
    t = _started(repo, dispatcher, project)
    wt = Path(t.worktree_path)
    (wt / "a.txt").write_text("from the task\n")
    git_ops.git(["add", "a.txt"], wt)
    git_ops.git(["commit", "-m", "task"], wt)
    (git_repo / "a.txt").write_text("from main\n")
    git_ops.git(["add", "a.txt"], git_repo)
    git_ops.git(["commit", "-m", "main"], git_repo)
    handoff.record(repo, t.id, handoff.STATUS_DONE, "done")
    fake_cli.set_state(t.job_id, "done")
    dispatcher.tick()
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.conflict_retry_count == 1
    assert t.handoff_at is None and t.handoff_status is None
    prompt = fake_cli.calls[-1][3]
    assert "task done" in prompt and "report" not in prompt.split("# Conflicting files")[0]


# ---------- the owner's way out ----------

def test_accept_a_waiting_card_goes_to_verification_with_the_last_message(repo, dispatcher, fake_cli, project, client, tmp_path):
    t = _started(repo, dispatcher, project)
    _end_turn(fake_cli, t, tmp_path, final_text="All built, forgot the command")
    dispatcher._sync_running()
    assert repo.get_task(t.id).blocker == Blocker.NEEDS_INPUT
    r = client.post(f"/api/tasks/{t.id}/accept")
    assert r.status_code == 200 and r.json()["status"] == "verifying"
    t = repo.get_task(t.id)
    assert t.blocker is None and t.handoff_status == "done"
    assert json.loads(t.report_json)["summary"] == "All built, forgot the command"
    assert ("stop", t.job_id) in fake_cli.calls
    assert any("owner accepted" in e["message"] for e in repo.task_events(t.id, 10))


def test_accept_a_failed_card_still_runs_verification(repo, dispatcher, fake_cli, project, client, settle):
    repo.update_project(project.id, verify_cmd="exit 1")
    fake_cli.stop_marks_stopped = True
    t = _started(repo, dispatcher, project)
    repo.update_task(t.id, status="failed", blocker_detail="gave up", auto_resume_count=1)
    assert client.post(f"/api/tasks/{t.id}/accept").status_code == 200
    settle()
    # Verification failed and the session gets its one chance: acceptance did not skip the gate
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.auto_resume_count == 1
    assert "exit 1" in fake_cli.calls[-1][3]


@pytest.mark.parametrize("fields", [
    {"status": "in_progress"},  # working, not waiting
    {"status": "in_progress", "blocker": "needs_input", "outbox_state": "queued"},  # an answer is on its way
    {"status": "verifying"},
    {"status": "done"},
    {"status": "todo"},
])
def test_accept_refuses_other_states(repo, dispatcher, project, client, fields):
    t = _started(repo, dispatcher, project)
    repo.update_task(t.id, **fields)
    r = client.post(f"/api/tasks/{t.id}/accept")
    assert r.status_code == 409
    assert repo.get_task(t.id).status == fields["status"]


def test_accept_refuses_an_open_input_request(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    dispatcher.request_input(t.id, "permission", "Bash", {"command": "rm x"})
    assert client.post(f"/api/tasks/{t.id}/accept").status_code == 409
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS


def test_accept_refuses_a_failed_card_without_a_working_copy(repo, dispatcher, project, client):
    t = repo.add_task(project.id, "A", "the job", status="failed")
    assert client.post(f"/api/tasks/{t.id}/accept").status_code == 409
    assert client.post("/api/tasks/999999/accept").status_code == 404


def test_accept_refuses_a_failed_card_whose_session_never_ran(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    # As after a start refused for an untrusted folder: the working copy exists, no session ever ran in it
    repo.update_task(t.id, status="failed", blocker="untrusted", session_id=None, job_id=None)
    r = client.post(f"/api/tasks/{t.id}/accept")
    assert r.status_code == 409 and "no session" in r.json()["detail"]
    assert repo.get_task(t.id).status == TaskStatus.FAILED


def test_accept_refuses_uncommitted_changes_and_names_them(repo, dispatcher, fake_cli, project, client, tmp_path):
    # They would not reach the merge, and the card would go green with the work left behind
    t = _started(repo, dispatcher, project)
    (Path(t.worktree_path) / "a.txt").write_text("changed\n")
    repo.update_task(t.id, status="failed")
    r = client.post(f"/api/tasks/{t.id}/accept")
    assert r.status_code == 409 and "a.txt" in r.json()["detail"]


# ---------- the transition: report.json from sessions on the old prompt ----------

def test_legacy_success_in_the_current_turn_hands_in(repo, dispatcher, fake_cli, project, tmp_path):
    t = _started(repo, dispatcher, project)
    _write_report(t, summary="from the old prompt")
    _end_turn(fake_cli, t, tmp_path)
    dispatcher._sync_running()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.VERIFYING and t.handoff_status == "done"
    assert json.loads(t.report_json)["summary"] == "from the old prompt"


def test_legacy_failed_in_the_current_turn_fails(repo, dispatcher, fake_cli, project, tmp_path):
    t = _started(repo, dispatcher, project)
    _write_report(t, status="failed", summary="could not", notes="the owner decides")
    _end_turn(fake_cli, t, tmp_path)
    dispatcher._sync_running()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "could not" in t.blocker_detail and "the owner decides" in t.blocker_detail


def test_legacy_needs_input_waits(repo, dispatcher, fake_cli, project, tmp_path):
    t = _started(repo, dispatcher, project)
    _write_report(t, status="needs_input")
    _end_turn(fake_cli, t, tmp_path)
    dispatcher._sync_running()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.blocker == Blocker.NEEDS_INPUT and t.handoff_status is None


def test_legacy_report_from_a_previous_turn_is_ignored(repo, dispatcher, fake_cli, project, tmp_path):
    t = _started(repo, dispatcher, project)
    started_at = time.time() - 3600
    _write_report(t, at=started_at - 60)
    _end_turn(fake_cli, t, tmp_path, started_at=started_at)
    dispatcher._sync_running()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.blocker == Blocker.NEEDS_INPUT


def test_legacy_unreadable_report_is_not_a_handoff(repo, dispatcher, fake_cli, project, tmp_path):
    t = _started(repo, dispatcher, project)
    p = Path(t.worktree_path) / REPORT_REL_PATH
    p.parent.mkdir(exist_ok=True)
    p.write_text("not json")
    _end_turn(fake_cli, t, tmp_path)
    dispatcher._sync_running()
    assert repo.get_task(t.id).blocker == Blocker.NEEDS_INPUT


def test_a_task_in_verifying_at_the_upgrade_reads_the_file(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    _write_report(t, summary="before the restart", at=time.time() - 7200)
    repo.update_task(t.id, status="verifying")
    dispatcher._process_verifying()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.MERGING and json.loads(t.report_json)["summary"] == "before the restart"


def test_a_task_in_verifying_at_the_upgrade_with_a_failed_file_fails(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    _write_report(t, status="failed", summary="could not", at=time.time() - 7200)
    repo.update_task(t.id, status="verifying")
    dispatcher._process_verifying()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "could not" in t.blocker_detail


def test_a_newer_signal_outweighs_an_older_file(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    _write_report(t, status="failed", summary="old", at=time.time() - 7200)
    handoff.record(repo, t.id, handoff.STATUS_DONE, "new")
    repo.update_task(t.id, status="verifying")
    dispatcher._process_verifying()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.MERGING and json.loads(t.report_json)["summary"] == "new"


def test_legacy_needs_input_after_a_signal_takes_it_back(repo, dispatcher, project):
    t = _started(repo, dispatcher, project)
    handoff.record(repo, t.id, handoff.STATUS_DONE, "done", at=time.time() - 60)
    _write_report(t, status="needs_input")
    t = handoff.ingest_report(repo, repo.get_task(t.id))
    assert t.handoff_status is None


# ---------- the prompt template in the database ----------

def _database_at_version_4(path, template: str | None):
    conn = connect(path)
    init_schema(conn)
    if template is not None:
        conn.execute("INSERT INTO settings (key, value) VALUES ('prompt_template', ?)", (template,))
    conn.execute("PRAGMA user_version = 4")
    conn.commit()
    return conn


OLD_TEMPLATE = ("You are performing a task. Be brief.\n\n# Task: {title}\n{description}\n\n# Rules\n"
                "- Verify command: {verify_cmd}. Run it before finishing.\n" + db._OLD_REPORT_BLOCK)


# The default template as it was released, verbatim: this test must not rest on the literal in the migration.
RELEASED_DEFAULT = """You are performing a task from the orchestrator queue. Work autonomously.

# Task: {title}
{description}

# Rules
- Work only in the current folder (a git worktree on branch {branch}, base {target_branch}). Do not switch branches, do not touch other worktrees.
- Do not ask questions if you can make the decision yourself. Ask only if the task is impossible without an answer.
- When done, git commit all changes with a meaningful message.
- Verify command: {verify_cmd}. Run it before finishing.
- As your last action, write the file {report_path} in JSON format:
  {{"status": "success" | "failed" | "needs_input", "summary": "what was done in 2-3 sentences", "notes": "what failed or what to pay attention to"}}
  Write summary and notes in the same language as the task description.
  Use status=failed if the task could not be completed. Do not write success if the tests fail.
  Use status=needs_input if you stopped for the owner's answer, decision or check, and put the question in your final message. status=success hands the work in: it goes to verification and merge right away, and nobody reads your questions first.
"""


def _setting(conn, key):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def test_migration_removes_the_block_on_an_exact_match(tmp_path):
    conn = _database_at_version_4(tmp_path / "orc.db", OLD_TEMPLATE)
    init_schema(conn)
    template = _setting(conn, "prompt_template")
    assert "report" not in template and "Be brief." in template and "{verify_cmd}" in template
    assert _setting(conn, "prompt_template_before_handoff") == OLD_TEMPLATE
    events = [row["message"] for row in conn.execute("SELECT message FROM events")]
    assert len(events) == 1 and "prompt_template_before_handoff" in events[0]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION


def test_migration_turns_the_released_default_into_the_new_one(tmp_path):
    conn = _database_at_version_4(tmp_path / "orc.db", RELEASED_DEFAULT)
    init_schema(conn)
    assert _setting(conn, "prompt_template") == DEFAULT_TEMPLATE
    assert _setting(conn, "prompt_template_before_handoff") == RELEASED_DEFAULT


def test_migration_leaves_a_reworded_template_alone(tmp_path):
    reworded = "Do it, then write {report_path} with your status.\n"
    conn = _database_at_version_4(tmp_path / "orc.db", reworded)
    init_schema(conn)
    assert _setting(conn, "prompt_template") == reworded
    assert _setting(conn, "prompt_template_before_handoff") is None
    assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0


def test_migration_without_a_custom_template_does_nothing(tmp_path):
    conn = _database_at_version_4(tmp_path / "orc.db", None)
    init_schema(conn)
    assert _setting(conn, "prompt_template") is None
    assert _setting(conn, "prompt_template_before_handoff") is None


def test_migration_runs_once(tmp_path):
    conn = _database_at_version_4(tmp_path / "orc.db", OLD_TEMPLATE)
    init_schema(conn)
    conn.execute("UPDATE settings SET value = ? WHERE key = 'prompt_template'", (OLD_TEMPLATE,))
    conn.commit()
    init_schema(conn)
    assert _setting(conn, "prompt_template") == OLD_TEMPLATE
    assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1


def test_the_frozen_block_is_no_longer_in_the_default_template():
    assert "{report_path}" not in DEFAULT_TEMPLATE and "report.json" not in DEFAULT_TEMPLATE


def test_settings_expose_the_default_template_for_the_reset(client):
    settings = client.get("/api/settings").json()
    assert settings["prompt_template_default"] == DEFAULT_TEMPLATE
    # Read-only: the dialog sends only what changed, and this key is not one of the settings
    assert client.patch("/api/settings", json={"prompt_template_default": "x"}).status_code == 400
