"""`orc task ...`: arguments, what goes to the server, and the guide."""
import json
import subprocess
import sys
import urllib.error
from io import StringIO

import pytest

from orc import task_cli, task_guide
from orc.main import parse_args


@pytest.fixture
def through_api(client):
    """The real API instead of a socket: what the client sends is what the server has to understand."""
    def call(method, path, payload):
        r = client.request(method, path, json=payload) if payload is not None else client.request(method, path)
        if r.status_code >= 400:
            raise task_cli.CliError(task_cli._error_text(r.text))
        return r.json()
    return call


@pytest.fixture
def in_project(client, git_repo, monkeypatch):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    monkeypatch.chdir(git_repo)
    return git_repo


def _run(argv, call, capsys):
    code = task_cli.run(parse_args(["task", *argv]), call)
    out = capsys.readouterr()
    return code, out.out, out.err


def test_add_uses_the_folder_and_passes_parameters(client, repo, in_project, through_api, capsys):
    client.post("/api/agents", json={"name": "Senior"})
    code, out, _ = _run(["add", "Do it", "--description", "the job", "--agent", "Senior",
                         "--status", "todo", "--verify-cmd", "make test"], through_api, capsys)
    assert code == 0 and "[todo, base main]" in out
    task = repo.list_tasks()[0]
    assert (task.title, task.description, task.status, task.verify_cmd) == ("Do it", "the job", "todo", "make test")
    assert repo.get_agent(task.agent_id).name == "Senior"


def test_add_reads_the_description_from_a_file_or_stdin(repo, in_project, through_api, capsys, monkeypatch, tmp_path):
    spec = tmp_path / "spec.txt"
    spec.write_text("from file")
    assert _run(["add", "A", "--description-file", str(spec)], through_api, capsys)[0] == 0
    monkeypatch.setattr(sys, "stdin", StringIO("from stdin"))
    assert _run(["add", "B", "--description-file", "-"], through_api, capsys)[0] == 0
    assert sorted(t.description for t in repo.list_tasks()) == ["from file", "from stdin"]
    code, _, err = _run(["add", "C", "--description", "x", "--description-file", "y"], through_api, capsys)
    assert code == 1 and "pick one" in err


def test_add_links_and_new_base(repo, in_project, through_api, capsys):
    _, out, _ = _run(["add", "First", "--base", "feature/a", "--base-from", "main"], through_api, capsys)
    first = repo.list_tasks()[0]
    assert first.target_branch == "feature/a"
    _, out, _ = _run(["add", "Second", "--after", str(first.id)], through_api, capsys)
    assert f"waits for #{first.id}" in out and "base feature/a" in out


def test_batch_from_a_file_and_a_bare_list(repo, in_project, through_api, capsys, tmp_path):
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"sequential": True, "tasks": [{"title": "1"}, {"title": "2"}]}))
    code, out, _ = _run(["batch", str(plan)], through_api, capsys)
    assert code == 0 and "#1 1" in out and "waits for #1" in out
    plan.write_text(json.dumps([{"title": "3"}]))
    assert _run(["batch", str(plan), "--json"], through_api, capsys)[0] == 0
    assert len(repo.list_tasks()) == 3


def test_repeating_a_command_creates_nothing_new_unless_told(repo, in_project, through_api, capsys):
    assert _run(["add", "Once", "--description", "x"], through_api, capsys)[0] == 0
    code, out, _ = _run(["add", "Once", "--description", "x"], through_api, capsys)
    assert code == 0 and "already made" in out and len(repo.list_tasks()) == 1
    assert _run(["add", "Once", "--description", "x", "--no-dedupe"], through_api, capsys)[0] == 0
    assert len(repo.list_tasks()) == 2


@pytest.mark.parametrize("content", ["{not json", '"a string"'])
def test_batch_with_a_broken_plan_says_so(in_project, through_api, capsys, tmp_path, content):
    plan = tmp_path / "plan.json"
    plan.write_text(content)
    code, _, err = _run(["batch", str(plan)], through_api, capsys)
    assert code == 1 and "plan" in err


def test_a_server_refusal_reaches_the_caller_with_exit_code_1(in_project, through_api, capsys):
    code, _, err = _run(["add", "x", "--agent", "Nobody"], through_api, capsys)
    assert code == 1 and "agent 'Nobody' not found" in err
    code, _, err = _run(["batch", "/no/such/file"], through_api, capsys)
    assert code == 1 and "cannot read" in err


def test_a_validation_error_names_the_field():
    raw = json.dumps({"detail": [{"loc": ["body", "tasks", 0, "agnet"], "msg": "Extra inputs are not permitted"}]})
    assert task_cli._error_text(raw) == "tasks.0.agnet: Extra inputs are not permitted"
    assert task_cli._error_text("<html>") == "<html>"


def test_link_and_context(repo, in_project, through_api, capsys):
    project = repo.list_projects()[0]
    a = repo.add_task(project.id, "A", target_branch="main")
    b = repo.add_task(project.id, "B", target_branch="main")
    code, out, _ = _run(["link", str(b.id), "--after", str(a.id)], through_api, capsys)
    assert code == 0 and f"waits for #{a.id}" in out
    assert _run(["link", str(b.id)], through_api, capsys)[0] == 1
    code, out, _ = _run(["context"], through_api, capsys)
    assert code == 0 and "Project: demo" in out and "Base branch for new cards: main" in out and f"#{b.id} [backlog] B" in out


def test_context_outside_a_project_lists_them(client, git_repo, through_api, capsys, monkeypatch, tmp_path):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    monkeypatch.chdir(tmp_path)
    _, out, _ = _run(["context"], through_api, capsys)
    assert "--project" in out and "demo (#1)" in out


def test_a_silent_server_and_a_missing_token_are_explained(tmp_path, monkeypatch):
    monkeypatch.setenv("ORC_URL", "http://127.0.0.1:9")  # the discard port: nothing answers there
    call = task_cli.http_transport(tmp_path)
    with pytest.raises(task_cli.CliError, match="no token"):
        call("POST", "/api/tasks/batch", {})
    (tmp_path / "pult-token").write_text("t")
    with pytest.raises(task_cli.CliError, match="not answering"):
        call("POST", "/api/tasks/batch", {})
    with pytest.raises(task_cli.CliError, match="not answering"):
        call("GET", "/api/tasks/context", None)  # reads need no token


def test_server_url_comes_from_the_environment_then_the_file(tmp_path, monkeypatch):
    monkeypatch.delenv("ORC_URL", raising=False)
    assert task_cli.server_url(tmp_path) == task_cli.DEFAULT_URL
    task_cli.write_server_url(tmp_path, "http://127.0.0.1:8799")
    assert task_cli.server_url(tmp_path) == "http://127.0.0.1:8799"
    monkeypatch.setenv("ORC_URL", "http://127.0.0.1:1/")
    assert task_cli.server_url(tmp_path) == "http://127.0.0.1:1"


def test_http_error_detail_is_read_from_the_body(tmp_path, monkeypatch):
    (tmp_path / "pult-token").write_text("tok")
    seen = {}

    class Opener:
        def open(self, request, timeout):
            seen["token"] = request.get_header("X-orc-token")
            raise urllib.error.HTTPError(request.full_url, 400, "bad", {}, StringIOBytes(b'{"detail": "nope"}'))

    class StringIOBytes:
        def __init__(self, data):
            self.data = data

        def read(self, *_):
            return self.data

        def close(self):
            pass

    monkeypatch.setattr(task_cli.urllib.request, "build_opener", lambda *_: Opener())
    with pytest.raises(task_cli.CliError, match="nope"):
        task_cli.http_transport(tmp_path)("POST", "/api/x", {})
    assert seen["token"] == "tok"


# ---------- what agents are told ----------

def test_the_command_points_at_this_orc_and_its_data(tmp_path, monkeypatch):
    command = task_guide.cli_command(tmp_path)
    assert command.startswith(f"ORC_DATA_DIR={tmp_path.resolve()} ")
    assert command.endswith(("/orc", "-m orc.main"))
    assert "ORC_DATA_DIR" not in task_guide.cli_command(task_guide.default_data_dir())


def test_session_note_names_the_card_and_never_starts_with_a_dash(tmp_path):
    note = task_guide.session_note(tmp_path, 7)
    assert "card #7" in note and "task guide" in note and not note.startswith("-")
    assert "card #" not in task_guide.session_note(tmp_path)
    # The handover rule is for task sessions, and reaches them even under a replaced prompt template
    assert "task done" in note and "task done" not in task_guide.session_note(tmp_path)
    assert "task fail" in note and "{cmd}" not in note


def test_guide_covers_what_goes_wrong(tmp_path, capsys):
    assert task_cli.run(parse_args(["task", "guide"])) == 0
    text = capsys.readouterr().out
    for fragment in ('"depends_on": ["current"]', "same base", "Do not wait", "sequential", "backlog", "Decomposing a feature"):
        assert fragment in text
    assert "{" + "cmd" + "}" not in text


def test_install_skill_respects_a_file_it_did_not_write(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("ORC_DATA_DIR", str(tmp_path / "data"))
    skills = tmp_path / "skills"
    assert task_cli.run(parse_args(["task", "install-skill", "--dir", str(skills)])) == 0
    path = skills / "orc-tasks" / "SKILL.md"
    text = path.read_text()
    assert text.startswith("---\nname: orc-tasks\ndescription: ") and "ORC_DATA_DIR=" in text
    # Ours can be refreshed, a stranger's cannot without an explicit force
    assert task_cli.run(parse_args(["task", "install-skill", "--dir", str(skills)])) == 0
    path.write_text("my own skill")
    assert task_cli.run(parse_args(["task", "install-skill", "--dir", str(skills)])) == 1
    assert path.read_text() == "my own skill" and "--force" in capsys.readouterr().err
    assert task_cli.run(parse_args(["task", "install-skill", "--dir", str(skills), "--force"])) == 0
    assert task_guide.SKILL_MARKER in path.read_text()


# ---------- reading, changing, moving and removing cards ----------

def _card(repo, title="Card", **fields):
    project = repo.list_projects()[0]
    return repo.add_task(project.id, title, fields.pop("description", "the job"), target_branch="main", **fields)


def test_show_prints_the_card_and_current_needs_a_card(repo, in_project, through_api, capsys):
    card = _card(repo, "Look at me", description="do the thing", verify_cmd="make test")
    repo.add_comment(card.id, "user", "comment", "remember this")
    code, out, _ = _run(["show", str(card.id)], through_api, capsys)
    assert code == 0 and "Look at me" in out and "do the thing" in out and "verify_cmd make test" in out and "remember this" in out
    code, _, err = _run(["show", "current"], through_api, capsys)
    assert code == 1 and "not the worktree of any card" in err
    assert _run(["show", "nonsense"], through_api, capsys)[0] == 1
    assert _run(["show", "999"], through_api, capsys)[0] == 1


def test_current_means_the_card_of_this_worktree(repo, in_project, through_api, capsys, monkeypatch):
    card = _card(repo, "Mine", status="in_progress")
    worktree = in_project / ".claude" / "worktrees" / "mine"
    worktree.mkdir(parents=True)
    repo.update_task(card.id, worktree_path=str(worktree))
    monkeypatch.chdir(worktree)
    code, out, _ = _run(["show", "current"], through_api, capsys)
    assert code == 0 and "Mine" in out
    code, _, err = _run(["delete", "current", "--yes", "--force"], through_api, capsys)
    assert code == 1 and "your own session" in err and repo.get_task(card.id) is not None


def test_list_filters_by_project_status_and_archive(client, repo, in_project, through_api, capsys, tmp_path):
    a = _card(repo, "Plain")
    b = _card(repo, "Todo one", status="todo")
    _run(["archive", str(a.id)], through_api, capsys)
    code, out, _ = _run(["list"], through_api, capsys)
    assert code == 0 and "Todo one" in out and "Plain" not in out
    assert "Plain" in _run(["list", "--archived", "only"], through_api, capsys)[1]
    assert "Todo one" not in _run(["list", "--status", "backlog", "--archived", "all"], through_api, capsys)[1]
    assert _run(["list", "--project", "nope"], through_api, capsys)[0] == 1
    assert json.loads(_run(["list", "--json", "--project", "demo"], through_api, capsys)[1])["tasks"][0]["id"] == b.id


def test_edit_changes_only_the_fields_that_were_passed(repo, in_project, through_api, capsys):
    card = _card(repo, "Old title", description="old text", model="opus", effort="high")
    code, out, _ = _run(["edit", str(card.id), "--title", "New title", "--priority", "high"], through_api, capsys)
    assert code == 0 and "New title" in out
    task = repo.get_task(card.id)
    assert (task.title, task.priority, task.description, task.model, task.effort) == ("New title", "high", "old text", "opus", "high")


def test_edit_reads_the_description_and_clears_values(repo, in_project, through_api, capsys, tmp_path):
    card = _card(repo, verify_cmd="make test", start_date="2026-01-02")
    spec = tmp_path / "spec.txt"
    spec.write_text("from a file")
    code, _, _ = _run(["edit", str(card.id), "--description-file", str(spec), "--clear", "start_date", "--clear", "verify_cmd"],
                      through_api, capsys)
    task = repo.get_task(card.id)
    assert code == 0 and (task.description, task.start_date, task.verify_cmd) == ("from a file", None, None)
    code, _, err = _run(["edit", str(card.id), "--verify-cmd", "x", "--clear", "verify_cmd"], through_api, capsys)
    assert code == 1 and "pick one" in err
    # a card has no model of its own: the flag is gone, not silently accepted
    for argv in (["edit", str(card.id), "--model", "x"], ["add", "A", "--effort", "high"]):
        with pytest.raises(SystemExit):
            _run(argv, through_api, capsys)
    assert _run(["edit", str(card.id)], through_api, capsys)[0] == 1
    assert _run(["edit", str(card.id), "--description", "a", "--description-file", "b"], through_api, capsys)[0] == 1


def test_edit_assigns_an_agent_by_name_and_sends_a_card_to_work(client, repo, in_project, through_api, capsys):
    client.post("/api/agents", json={"name": "Senior"})
    card = _card(repo)
    code, _, err = _run(["edit", str(card.id), "--status", "todo"], through_api, capsys)
    assert code == 1 and "no assignee" in err
    code, _, _ = _run(["edit", str(card.id), "--agent", "senior", "--status", "todo"], through_api, capsys)
    task = repo.get_task(card.id)
    assert code == 0 and task.status == "todo" and repo.get_agent(task.agent_id).name == "Senior"
    code, out, _ = _run(["edit", str(card.id), "--clear", "agent"], through_api, capsys)
    assert code == 0 and repo.get_task(card.id).status == "backlog" and "went from todo to backlog" in out
    assert _run(["edit", str(card.id), "--agent", "Nobody"], through_api, capsys)[0] == 1


def test_closing_a_card_by_hand_needs_force(repo, in_project, through_api, capsys):
    card = _card(repo, status="failed")
    code, _, err = _run(["edit", str(card.id), "--status", "done"], through_api, capsys)
    assert code == 1 and "--force" in err and repo.get_task(card.id).status == "failed"
    assert _run(["edit", str(card.id), "--status", "done", "--force"], through_api, capsys)[0] == 0
    assert repo.get_task(card.id).status == "done"


def test_move_to_another_project(client, repo, in_project, through_api, capsys, tmp_path):
    other = tmp_path / "second"
    other.mkdir()
    for args in (["init", "-b", "trunk"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                 ["commit", "--allow-empty", "-m", "init"]):
        subprocess.run(["git", *args], cwd=other, check=True, capture_output=True)
    client.post("/api/projects", json={"name": "second", "path": str(other)})
    card = _card(repo, "Wanderer")
    code, out, _ = _run(["move", str(card.id), "--to", "second"], through_api, capsys)
    moved = repo.get_task(card.id)
    assert code == 0 and "moved" in out and moved.target_branch == "trunk"
    assert repo.get_project(moved.project_id).name == "second"
    code, _, err = _run(["move", str(card.id), "--to", "second"], through_api, capsys)
    assert code == 1 and "already in project" in err
    assert _run(["move", str(card.id), "--to", "missing"], through_api, capsys)[0] == 1


def test_archive_and_unarchive_round_trip(repo, in_project, through_api, capsys):
    card = _card(repo)
    assert _run(["archive", str(card.id)], through_api, capsys)[0] == 0 and repo.get_task(card.id).archived_at
    code, out, _ = _run(["unarchive", str(card.id)], through_api, capsys)
    assert code == 0 and "restored" in out and repo.get_task(card.id).archived_at is None
    running = _card(repo, status="in_progress")
    assert _run(["archive", str(running.id)], through_api, capsys)[0] == 1


def test_delete_asks_to_be_sure_and_reports_who_was_waiting(repo, in_project, through_api, capsys):
    card = _card(repo, "Doomed")
    waiter = _card(repo, "Waiter")
    repo.set_deps(waiter.id, [card.id])
    code, _, err = _run(["delete", str(card.id)], through_api, capsys)
    assert code == 1 and "--yes" in err and "archive" in err and repo.get_task(card.id) is not None
    code, out, _ = _run(["delete", str(card.id), "--yes"], through_api, capsys)
    assert code == 0 and f"#{card.id} deleted" in out and f"#{waiter.id}" in out
    assert repo.get_task(card.id) is None and repo.deps_of(waiter.id) == []


def test_deleting_a_running_card_needs_force(repo, in_project, through_api, capsys):
    card = _card(repo, status="in_progress")
    code, _, err = _run(["delete", str(card.id), "--yes"], through_api, capsys)
    assert code == 1 and "force" in err and repo.get_task(card.id) is not None
    assert _run(["delete", str(card.id), "--yes", "--force"], through_api, capsys)[0] == 0


def test_link_accepts_current(repo, in_project, through_api, capsys, monkeypatch):
    mine = _card(repo, "Mine", status="in_progress")
    worktree = in_project / ".claude" / "worktrees" / "mine"
    worktree.mkdir(parents=True)
    repo.update_task(mine.id, worktree_path=str(worktree))
    other = _card(repo, "Other")
    monkeypatch.chdir(worktree)
    code, out, _ = _run(["link", str(other.id), "--after", "current"], through_api, capsys)
    assert code == 0 and f"waits for #{mine.id}" in out


def test_the_guide_and_the_note_mention_changing_cards(tmp_path):
    guide = task_guide.guide(tmp_path)
    for word in ("task edit", "task move", "task archive", "task delete"):
        assert word in guide
    assert "change" in task_guide.session_note(tmp_path)
    description = task_guide.skill_text(tmp_path).split("description:")[1].split("\n")[0]
    assert "edit" in description and "move" in description and "delete" in description
