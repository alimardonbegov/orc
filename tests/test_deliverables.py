"""Files an agent hands in as a card's result: `orc task attach`, storage that outlives the working copy, versions,
limits, and the rule that nothing handed in can run on the orchestrator's origin."""
import base64
import shutil
from pathlib import Path

import pytest

from orc import deliverables, task_cli
from orc.main import parse_args

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _started(repo, dispatcher, project):
    t = repo.add_task(project.id, "A", "the job", status="todo")
    dispatcher.tick()
    return repo.get_task(t.id)


def _hook(repo, task_id):
    return {"x-orc-hook": repo.get_task(task_id).hook_secret or ""}


def _post(client, repo, task_id, name, data: bytes, headers=None):
    return client.post(f"/api/hooks/tasks/{task_id}/deliverables",
                       json={"name": name, "data": base64.b64encode(data).decode()},
                       headers=headers if headers is not None else _hook(repo, task_id))


@pytest.fixture
def through_api(client, dispatcher, monkeypatch):
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


# ---------- handing in and reading back ----------

def test_the_cli_hands_in_a_file_and_the_card_lists_and_serves_it(repo, dispatcher, project, client, through_api, capsys, monkeypatch):
    t = _started(repo, dispatcher, project)
    report = Path(t.worktree_path) / "report.md"
    report.write_text("# Result\nall green\n")
    monkeypatch.chdir(t.worktree_path)
    code, out, _ = _cli(["attach", "report.md"], through_api, capsys)
    assert code == 0 and "report.md v1" in out
    groups = client.get(f"/api/tasks/{t.id}/deliverables").json()
    assert [g["name"] for g in groups] == ["report.md"] and groups[0]["latest"]["version"] == 1
    r = client.get(groups[0]["latest"]["url"] + "?inline=1")
    assert r.status_code == 200 and r.text == "# Result\nall green\n"
    assert r.headers["content-type"].startswith("text/plain")


def test_the_file_outlives_the_working_copy(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    assert _post(client, repo, t.id, "shot.png", PNG).status_code == 201
    shutil.rmtree(t.worktree_path)
    url = client.get(f"/api/tasks/{t.id}/deliverables").json()[0]["latest"]["url"]
    r = client.get(url + "?inline=1")
    assert r.status_code == 200 and r.content == PNG and r.headers["content-type"] == "image/png"


def test_handing_in_a_name_again_makes_a_version_and_the_same_bytes_do_not(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    assert _post(client, repo, t.id, "out.txt", b"one").json()["version"] == 1
    again = _post(client, repo, t.id, "out.txt", b"one").json()
    assert again["version"] == 1 and again["duplicate"] is True
    assert _post(client, repo, t.id, "out.txt", b"two").json()["version"] == 2
    group = client.get(f"/api/tasks/{t.id}/deliverables").json()[0]
    assert [v["version"] for v in group["versions"]] == [2, 1] and group["latest"]["version"] == 2
    old = client.get(group["versions"][1]["url"]).content
    assert old == b"one"


def test_the_cli_names_the_file_and_refuses_what_is_not_a_file(repo, dispatcher, project, through_api, capsys, monkeypatch, tmp_path):
    t = _started(repo, dispatcher, project)
    monkeypatch.chdir(t.worktree_path)
    (tmp_path / "x.log").write_text("hello")
    code, out, _ = _cli(["attach", str(tmp_path / "x.log"), "--name", "build.log"], through_api, capsys)
    assert code == 0 and "build.log v1" in out
    code, _, err = _cli(["attach", "missing.txt"], through_api, capsys)
    assert code == 1 and "is not a file" in err
    code, _, err = _cli(["attach", str(tmp_path / "x.log"), str(tmp_path / "x.log"), "--name", "a"], through_api, capsys)
    assert code == 1 and "--name" in err


def test_the_cli_refuses_outside_a_card_worktree(through_api, capsys, monkeypatch, tmp_path):
    (tmp_path / "f.txt").write_text("x")
    monkeypatch.chdir(tmp_path)
    code, _, err = _cli(["attach", "f.txt"], through_api, capsys)
    assert code == 1 and "not the worktree of any card" in err


def test_a_cli_against_an_older_server_says_so(repo, dispatcher, project, capsys, monkeypatch):
    t = _started(repo, dispatcher, project)
    monkeypatch.chdir(t.worktree_path)
    monkeypatch.setenv("ORC_DATA_DIR", str(dispatcher.settings.data_dir))
    (Path(t.worktree_path) / "f.txt").write_text("x")

    def old_server(method, path, payload, hook_secret=None):
        if path.startswith("/api/tasks/context"):
            return {"caller": {"id": t.id}}
        raise task_cli.CliError("Not Found")
    code, _, err = _cli(["attach", "f.txt"], old_server, capsys)
    assert code == 1 and "older than this CLI" in err


# ---------- who may hand in ----------

def test_only_the_session_of_the_card_may_hand_in(repo, dispatcher, project, client, anon_client):
    t = _started(repo, dispatcher, project)
    other = _started(repo, dispatcher, project)
    assert _post(anon_client, repo, t.id, "a.txt", b"x", headers={}).status_code == 403
    assert _post(anon_client, repo, t.id, "a.txt", b"x", headers=_hook(repo, other.id)).status_code == 403
    assert _post(client, repo, 9999, "a.txt", b"x", headers={"x-orc-hook": "x"}).status_code == 404
    assert client.get(f"/api/tasks/{t.id}/deliverables").json() == []


# ---------- what is accepted ----------

@pytest.mark.parametrize("name", ["tool.exe", "noextension", "run.sh", "page.js", "x.py"])
def test_types_outside_the_allowlist_are_refused(repo, dispatcher, project, client, name):
    t = _started(repo, dispatcher, project)
    r = _post(client, repo, t.id, name, b"data")
    assert r.status_code == 400 and "cannot be handed in" in r.json()["detail"]


def test_size_and_emptiness_and_fake_images_are_refused(repo, dispatcher, project, client, monkeypatch):
    t = _started(repo, dispatcher, project)
    assert _post(client, repo, t.id, "e.txt", b"").status_code == 400
    monkeypatch.setattr(deliverables, "MAX_FILE_BYTES", 10)
    r = _post(client, repo, t.id, "big.txt", b"x" * 11)
    assert r.status_code == 400 and "larger" in r.json()["detail"]
    monkeypatch.setattr(deliverables, "MAX_FILE_BYTES", 1024)
    r = _post(client, repo, t.id, "fake.png", b"<html><script>alert(1)</script>")
    assert r.status_code == 400 and "not a png" in r.json()["detail"]


def test_the_shared_attachment_ceiling_applies(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    repo.set_setting("attachments_max_total_mb", "1")
    assert _post(client, repo, t.id, "a.txt", b"x" * (700 * 1024)).status_code == 201
    r = _post(client, repo, t.id, "b.txt", b"y" * (700 * 1024))
    assert r.status_code == 400 and "no room" in r.json()["detail"]


def test_a_card_has_a_cap_on_versions(repo, dispatcher, project, client, monkeypatch):
    t = _started(repo, dispatcher, project)
    monkeypatch.setattr(deliverables, "MAX_ROWS_PER_CARD", 2)
    assert _post(client, repo, t.id, "a.txt", b"1").status_code == 201
    assert _post(client, repo, t.id, "a.txt", b"2").status_code == 201
    assert _post(client, repo, t.id, "a.txt", b"3").status_code == 400


def test_a_path_in_the_name_is_cut_to_the_file_name(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    r = _post(client, repo, t.id, "../../etc/.hidden/report.txt", b"x")
    assert r.status_code == 201 and r.json()["name"] == "report.txt"
    assert deliverables.clean_name("..\\..\\win\\a.txt") == "a.txt"
    assert deliverables.clean_name("a\x00b\n.txt") == "ab.txt"


# ---------- nothing handed in can run ----------

@pytest.mark.parametrize("name,body", [
    ("report.html", b"<html><script>fetch('/api/tasks')</script></html>"),
    ("pic.svg", b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"),
    ("data.xml", b"<?xml version='1.0'?><a/>"),
])
def test_risky_types_are_served_as_a_neutral_download_even_when_inline_is_asked(repo, dispatcher, project, client, name, body):
    t = _started(repo, dispatcher, project)
    assert _post(client, repo, t.id, name, body).status_code == 201
    url = client.get(f"/api/tasks/{t.id}/deliverables").json()[0]["latest"]["url"]
    r = client.get(url + "?inline=1")
    assert r.status_code == 200 and r.content == body
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"]


def test_only_images_and_text_may_be_shown_in_the_page(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    _post(client, repo, t.id, "doc.pdf", b"%PDF-1.4")
    _post(client, repo, t.id, "notes.json", b'{"a": 1}')
    by_name = {g["name"]: g["latest"] for g in client.get(f"/api/tasks/{t.id}/deliverables").json()}
    assert by_name["doc.pdf"]["inline"] is False and by_name["notes.json"]["inline"] is True
    pdf = client.get(by_name["doc.pdf"]["url"] + "?inline=1")
    assert pdf.headers["content-disposition"].startswith("attachment")
    js = client.get(by_name["notes.json"]["url"] + "?inline=1")
    assert js.headers["content-disposition"].startswith("inline") and js.headers["content-type"].startswith("text/plain")
    assert "sandbox" in js.headers["content-security-policy"]
    # Without the explicit request even a safe type downloads
    assert client.get(by_name["notes.json"]["url"]).headers["content-disposition"].startswith("attachment")


def test_a_handed_in_file_cannot_be_reached_through_the_image_endpoint(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    stored = _post(client, repo, t.id, "page.html", b"<script>1</script>").json()
    row = repo.get_deliverable(stored["id"])
    assert client.get(f"/api/attachments/{row['attachment_id']}").status_code == 404


def test_deleting_the_card_removes_its_rows(repo, dispatcher, project, client):
    t = _started(repo, dispatcher, project)
    _post(client, repo, t.id, "a.txt", b"x")
    repo.delete_task(t.id)
    assert repo.list_deliverables(t.id) == []
