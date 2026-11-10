"""Waking a parent card when its subtasks are done (orc/child_wake.py): the rules, the fuses and the plumbing."""
import shutil
from pathlib import Path

import pytest

from orc import child_wake, task_cli
from orc.main import parse_args
from orc.models import TaskStatus


def _resumes(fake_cli):
    return [c for c in fake_cli.calls if c[0] == "resume_bg"]


@pytest.fixture(autouse=True)
def _stoppable(fake_cli):
    """A wake stops a live session before resuming it; the fake daemon confirms the stop."""
    fake_cli.stop_marks_stopped = True


def _parent(repo, dispatcher, project, **fields):
    """A card that has run (so it has a session and a working copy) and is done, as a parent that handed in."""
    task = repo.add_task(project.id, "Split the work", status="todo", **fields)
    dispatcher.tick()
    task = repo.get_task(task.id)
    assert task.session_id and Path(task.worktree_path).is_dir()
    return repo.update_task(task.id, status=TaskStatus.DONE, done_at="2026-11-08T10:00:00+00:00")


def _child(repo, project, parent, status=TaskStatus.DONE, done_at="2026-11-08T11:00:00+00:00", **fields):
    done = done_at if status == TaskStatus.DONE else None
    return repo.add_task(project.id, f"piece {parent.id}", status=status, parent_task_id=parent.id, done_at=done,
                         target_branch="main", **fields)


def _enable(repo, parent):
    return repo.update_task(parent.id, wake_on_children=1)


def test_off_by_default(repo, dispatcher, fake_cli, project):
    parent = _parent(repo, dispatcher, project)
    _child(repo, project, parent)
    dispatcher.tick()
    assert repo.get_task(parent.id).status == TaskStatus.DONE
    assert repo.get_task(parent.id).children_wake_count == 0


def test_wakes_once_after_the_last_subtask_and_not_again(repo, dispatcher, fake_cli, project):
    parent = _enable(repo, _parent(repo, dispatcher, project))
    first = _child(repo, project, parent)
    second = _child(repo, project, parent, status=TaskStatus.IN_PROGRESS)
    dispatcher.tick()
    assert repo.get_task(parent.id).status == TaskStatus.DONE  # one subtask is still going
    repo.update_task(second.id, status=TaskStatus.DONE, done_at="2026-11-08T12:00:00+00:00")
    dispatcher.tick()
    woken = repo.get_task(parent.id)
    assert woken.children_wake_count == 1
    assert woken.status in (TaskStatus.IN_PROGRESS, TaskStatus.TODO)
    resume = _resumes(fake_cli)[-1]
    assert f"#{first.id}" in resume[3] and f"#{second.id}" in resume[3]
    assert "<untrusted>" in resume[3]
    # the run is named in the execution log, the conversation and the feed
    assert [r["trigger"] for r in repo.list_task_sessions(parent.id)][-1] == "subtasks_done"
    comments = repo.list_comments(parent.id)
    assert comments[-1]["author"] == "orc" and comments[-1]["kind"] == "subtasks_done"
    assert "<untrusted>" not in comments[-1]["body"]
    assert any("after its subtasks were done" in e["message"] for e in repo.list_events())
    # the parent lands again with the same finished set: no second wake, however many ticks pass
    repo.update_task(parent.id, status=TaskStatus.DONE, done_at="2026-11-08T13:00:00+00:00")
    for _ in range(3):
        dispatcher.tick()
    assert repo.get_task(parent.id).children_wake_count == 1
    assert len(_resumes(fake_cli)) == 1


def test_a_parent_that_is_still_working_is_woken_after_it_lands(repo, dispatcher, fake_cli, project):
    parent = _enable(repo, _parent(repo, dispatcher, project))
    repo.update_task(parent.id, status=TaskStatus.MERGING)
    _child(repo, project, parent)
    dispatcher._wake_parents()  # a full tick would merge the parent
    assert repo.get_task(parent.id).children_wake_count == 0
    repo.update_task(parent.id, status=TaskStatus.DONE)
    dispatcher._wake_parents()
    assert repo.get_task(parent.id).children_wake_count == 1


def test_a_failed_subtask_holds_the_wake_and_says_so_once(repo, dispatcher, fake_cli, project):
    parent = _enable(repo, _parent(repo, dispatcher, project))
    _child(repo, project, parent)
    broken = _child(repo, project, parent, status=TaskStatus.FAILED)
    for _ in range(3):
        dispatcher.tick()
    assert repo.get_task(parent.id).children_wake_count == 0
    held = [e for e in repo.list_events() if "not woken" in e["message"]]
    assert len(held) == 1 and f"#{broken.id}" in held[0]["message"]
    # the owner closes it by hand: now the set is done and the parent hears about it
    repo.update_task(broken.id, status=TaskStatus.DONE, done_at="2026-11-08T12:00:00+00:00")
    dispatcher.tick()
    assert repo.get_task(parent.id).children_wake_count == 1


def test_archived_subtasks_do_not_count(repo, dispatcher, fake_cli, project):
    parent = _enable(repo, _parent(repo, dispatcher, project))
    _child(repo, project, parent)
    stray = _child(repo, project, parent, status=TaskStatus.BACKLOG)
    repo.update_task(stray.id, archived_at="2026-11-08T11:30:00+00:00")
    dispatcher.tick()
    assert repo.get_task(parent.id).children_wake_count == 1


def test_a_parent_whose_working_copy_is_gone_is_refused_honestly(repo, dispatcher, fake_cli, project):
    parent = _enable(repo, _parent(repo, dispatcher, project))
    shutil.rmtree(parent.worktree_path)
    _child(repo, project, parent)
    dispatcher.tick()
    after = repo.get_task(parent.id)
    assert after.status == TaskStatus.DONE and after.children_wake_count == 0
    assert after.children_wake_key  # remembered: the refusal is not repeated every tick
    assert "working copy has been removed" in repo.list_comments(parent.id)[-1]["body"]
    assert any("not woken" in e["message"] for e in repo.list_events())
    events = len(repo.list_events())
    dispatcher.tick()
    assert len(repo.list_events()) == events
    assert _resumes(fake_cli) == []


def test_a_working_copy_that_vanishes_after_queueing_does_not_start_a_blank_session(repo, dispatcher, fake_cli, project):
    parent = _enable(repo, _parent(repo, dispatcher, project))
    _child(repo, project, parent)
    dispatcher._wake_parents()
    assert repo.get_task(parent.id).status == TaskStatus.TODO
    shutil.rmtree(parent.worktree_path)
    before = len(fake_cli.calls)
    dispatcher.tick()
    after = repo.get_task(parent.id)
    assert after.status == TaskStatus.DONE and after.resume_with is None and after.resume_trigger is None
    assert [c for c in fake_cli.calls[before:] if c[0] in ("start_bg", "resume_bg")] == []


def test_the_wake_ceiling(repo, dispatcher, fake_cli, project):
    parent = _enable(repo, _parent(repo, dispatcher, project))
    repo.update_task(parent.id, children_wake_count=child_wake.MAX_WAKES)
    _child(repo, project, parent)
    dispatcher.tick()
    after = repo.get_task(parent.id)
    assert after.status == TaskStatus.DONE and after.children_wake_count == child_wake.MAX_WAKES
    assert "woken" in repo.list_comments(parent.id)[-1]["body"]


def test_the_generation_fuse(repo, dispatcher, fake_cli, project):
    from orc import task_plans
    deep = None
    for _ in range(task_plans.MAX_AUTOSTART_GENERATION + 2):  # the last card stands MAX + 1 generations deep
        deep = repo.add_task(project.id, "gen", target_branch="main", created_by_task_id=deep.id if deep else None)
    deep = repo.update_task(deep.id, status="todo")
    dispatcher.tick()
    deep = _enable(repo, repo.update_task(deep.id, status=TaskStatus.DONE, done_at="2026-11-08T10:00:00+00:00"))
    _child(repo, project, deep)
    dispatcher.tick()
    assert repo.get_task(deep.id).status == TaskStatus.DONE
    assert "generations" in repo.list_comments(deep.id)[-1]["body"]


def test_a_full_project_makes_the_woken_parent_wait_in_the_queue(repo, dispatcher, fake_cli, project):
    repo.update_project(project.id, max_workers=1)
    parent = _enable(repo, _parent(repo, dispatcher, project))
    _child(repo, project, parent)
    busy = repo.add_task(project.id, "Busy", status=TaskStatus.IN_PROGRESS, job_id="x")
    dispatcher._wake_parents()
    assert repo.get_task(parent.id).status == TaskStatus.TODO
    dispatcher._start_ready()
    assert repo.get_task(parent.id).status == TaskStatus.TODO  # the slot is taken: no resume yet
    assert _resumes(fake_cli) == []
    repo.update_task(busy.id, status=TaskStatus.DONE)
    dispatcher._start_ready()
    assert repo.get_task(parent.id).status == TaskStatus.IN_PROGRESS
    assert _resumes(fake_cli)


def test_the_project_setting_enables_it_and_a_card_can_opt_out(repo, dispatcher, fake_cli, project, client):
    r = client.patch(f"/api/projects/{project.id}", json={"card_settings": {"wake_parent": True}})
    assert r.status_code == 200, r.text
    parent = _parent(repo, dispatcher, project)
    quiet = _parent(repo, dispatcher, project)
    repo.update_task(quiet.id, wake_on_children=0)
    _child(repo, project, parent)
    _child(repo, project, quiet)
    dispatcher.tick()
    assert repo.get_task(parent.id).children_wake_count == 1
    assert repo.get_task(quiet.id).children_wake_count == 0


def test_turning_the_setting_on_leaves_a_finished_tree_quiet(repo, dispatcher, fake_cli, project, client):
    parent = _parent(repo, dispatcher, project)
    _child(repo, project, parent)
    r = client.patch(f"/api/tasks/{parent.id}", json={"wake_on_children": True})
    assert r.status_code == 200 and r.json()["wake_on_children"] == 1
    dispatcher.tick()
    assert repo.get_task(parent.id).children_wake_count == 0
    # a subtask that is added and finished afterwards is news
    _child(repo, project, parent, done_at="2026-11-08T15:00:00+00:00")
    dispatcher.tick()
    assert repo.get_task(parent.id).children_wake_count == 1


def test_project_baseline_and_instruction(repo, dispatcher, fake_cli, project, client):
    parent = _parent(repo, dispatcher, project)
    _child(repo, project, parent)
    client.patch(f"/api/projects/{project.id}",
                 json={"card_settings": {"wake_parent": True, "wake_parent_instruction": "Check the build, then stop."}})
    dispatcher.tick()
    assert repo.get_task(parent.id).children_wake_count == 0
    _child(repo, project, parent, done_at="2026-11-08T15:00:00+00:00")
    dispatcher.tick()
    assert _resumes(fake_cli)[-1][3].startswith("Check the build, then stop.")


def test_settings_reject_junk(client, project):
    assert client.patch(f"/api/projects/{project.id}", json={"card_settings": {"wake_parent": "yes"}}).status_code == 400
    assert client.patch(f"/api/projects/{project.id}",
                        json={"card_settings": {"wake_parent_instruction": "x" * 5000}}).status_code == 400


def test_an_ordinary_rework_still_says_rework(repo, dispatcher, fake_cli, project):
    parent = _parent(repo, dispatcher, project)
    dispatcher.rework(parent.id, "fix the title")
    dispatcher.tick()
    assert [r["trigger"] for r in repo.list_task_sessions(parent.id)][-1] == "rework"
    assert repo.get_task(parent.id).resume_trigger is None


def test_the_trigger_is_in_the_execution_log(repo, dispatcher, fake_cli, project, client):
    parent = _enable(repo, _parent(repo, dispatcher, project))
    _child(repo, project, parent)
    dispatcher.tick()
    log = client.get(f"/api/tasks/{parent.id}/runs").json()
    assert log["runs"][-1]["trigger"] == "subtasks_done"


# ---------- the CLI against this server and an older one ----------

def _cli(client, argv):
    def call(method, path, payload):
        r = client.request(method, path, json=payload)
        if r.status_code >= 400:
            raise task_cli.CliError(task_cli._error_text(r.text))
        return r.json()
    return task_cli.run(parse_args(["task", *argv]), call)


def test_cli_edit_sets_and_clears_the_flag(repo, project, client):
    card = repo.add_task(project.id, "P", target_branch="main")
    calls = []

    def call(method, path, payload):
        calls.append((method, path, payload))
        r = client.request(method, path, json=payload)
        return r.json()
    args = parse_args(["task", "edit", str(card.id), "--wake-on-children"])
    task_cli.run(args, call)
    assert repo.get_task(card.id).wake_on_children == 1
    task_cli.run(parse_args(["task", "edit", str(card.id), "--clear", "wake_on_children"]), call)
    assert repo.get_task(card.id).wake_on_children is None
    # a command that does not mention the flag never sends the field
    task_cli.run(parse_args(["task", "edit", str(card.id), "--priority", "high"]), call)
    assert "wake_on_children" not in calls[-1][2]


def test_cli_tells_the_owner_when_the_server_is_older(repo, project, capsys):
    card = repo.add_task(project.id, "P", target_branch="main")

    def old_server(method, path, payload):
        if method == "GET":
            return {"id": card.id, "project_id": project.id, "status": "backlog"}
        return {"id": card.id, "status": "backlog"}  # an old server drops the field it does not know
    code = task_cli.run(parse_args(["task", "edit", str(card.id), "--wake-on-children"]), old_server)
    assert code == 1
    assert "older than this CLI" in capsys.readouterr().err
