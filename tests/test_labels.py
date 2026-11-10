"""Labels and planning dates (orc/labels.py): the API, the board list, the batch plan and `orc task`."""
import sqlite3

import pytest

from orc import labels, task_cli
from orc.main import parse_args
from tests.fakes import to_work


def _card(client, project, **extra):
    r = client.post("/api/tasks", json={"project_id": project.id, "title": "A", "description": "x", **extra})
    assert r.status_code == 201, r.text
    return r.json()


# ---------- validation without a server ----------

def test_names_are_trimmed_deduplicated_and_bounded():
    assert labels.normalize_names(["  bug ", "Bug", "ui  kit"]) == ["bug", "ui kit"]
    with pytest.raises(ValueError):
        labels.normalize_name("   ")
    with pytest.raises(ValueError):
        labels.normalize_name("x" * 41)


@pytest.mark.parametrize("raw", ["2026-13-01", "2026-02-30", "26-01-01", "2026-1-1", "tomorrow"])
def test_bad_dates_are_refused(raw):
    with pytest.raises(ValueError):
        labels.normalize_date(raw)


def test_dates_normalize_and_order():
    assert labels.normalize_date(" 2026-11-07 ") == "2026-11-07"
    assert labels.normalize_date("") is None
    labels.check_date_order("2026-11-07", "2026-11-07")
    with pytest.raises(ValueError):
        labels.check_date_order("2026-11-08", "2026-11-07")


# ---------- the label endpoints ----------

def test_label_crud_and_case_insensitive_names(client):
    made = client.post("/api/labels", json={"name": "Bug", "color": "#FF0000"})
    assert made.status_code == 201 and made.json()["color"] == "#ff0000"
    assert client.post("/api/labels", json={"name": "bug"}).status_code == 409
    other = client.post("/api/labels", json={"name": "UI"}).json()
    assert other["color"] == labels.DEFAULT_COLOR
    assert client.patch(f"/api/labels/{other['id']}", json={"name": "BUG"}).status_code == 409
    renamed = client.patch(f"/api/labels/{other['id']}", json={"name": "Frontend", "color": "#00ff00"})
    assert renamed.json()["name"] == "Frontend"
    assert client.post("/api/labels", json={"name": "x", "color": "red"}).status_code == 400
    assert [item["name"] for item in client.get("/api/labels").json()] == ["Bug", "Frontend"]
    assert client.delete(f"/api/labels/{other['id']}").status_code == 200
    assert client.delete(f"/api/labels/{other['id']}").status_code == 404


def test_deleting_a_label_takes_it_off_cards(client, project):
    card = _card(client, project, labels=["bug"])
    label_id = card["labels"][0]["id"]
    client.delete(f"/api/labels/{label_id}")
    assert client.get(f"/api/tasks/{card['id']}").json()["labels"] == []


# ---------- labels on cards ----------

def test_create_creates_missing_labels_and_reuses_existing(client, project):
    client.post("/api/labels", json={"name": "Bug", "color": "#ff0000"})
    card = _card(client, project, labels=["bug", "new one", "BUG"])
    assert sorted(item["name"] for item in card["labels"]) == ["Bug", "new one"]
    assert {item["name"]: item["color"] for item in client.get("/api/labels").json()}["Bug"] == "#ff0000"


def test_patch_replaces_the_list_and_null_leaves_it(client, project):
    card = _card(client, project, labels=["a", "b"])
    r = client.patch(f"/api/tasks/{card['id']}", json={"labels": ["b", "c"]})
    assert [item["name"] for item in r.json()["labels"]] == ["b", "c"]
    r = client.patch(f"/api/tasks/{card['id']}", json={"labels": None, "title": "T"})
    assert [item["name"] for item in r.json()["labels"]] == ["b", "c"]
    r = client.patch(f"/api/tasks/{card['id']}", json={"labels": []})
    assert r.json()["labels"] == []


def test_list_carries_labels_and_filters_by_label(client, project):
    a = _card(client, project, labels=["x"])
    b = _card(client, project, labels=["y"])
    c = _card(client, project)
    rows = {t["id"]: t["labels"] for t in client.get("/api/tasks").json()}
    assert [item["name"] for item in rows[a["id"]]] == ["x"] and rows[c["id"]] == []
    label_id = rows[b["id"]][0]["id"]
    only = client.get("/api/tasks", params={"label_id": label_id}).json()
    assert [t["id"] for t in only] == [b["id"]]


def test_listing_does_not_query_per_card(client, project, repo):
    for i in range(8):
        _card(client, project, labels=[f"l{i}", "shared"])
    seen: list[str] = []
    repo.conn.set_trace_callback(seen.append)
    assert client.get("/api/tasks").status_code == 200
    repo.conn.set_trace_callback(None)
    label_queries = [q for q in seen if "task_labels" in q]
    assert len(label_queries) == 1


def test_label_counts(client, project):
    _card(client, project, labels=["x"])
    _card(client, project, labels=["x"])
    assert client.get("/api/labels").json()[0]["task_count"] == 2


# ---------- dates ----------

def test_dates_are_validated_and_ordered(client, project):
    card = _card(client, project, start_date="2026-11-01", due_date="2026-11-09")
    assert (card["start_date"], card["due_date"]) == ("2026-11-01", "2026-11-09")
    for bad in ({"start_date": "2026-13-01"}, {"due_date": "2026-10-31"}):
        r = client.patch(f"/api/tasks/{card['id']}", json=bad)
        assert r.status_code == 400, bad
    assert client.post("/api/tasks", json={"project_id": project.id, "title": "A", "start_date": "2026-11-09",
                                           "due_date": "2026-11-01"}).status_code == 400
    r = client.patch(f"/api/tasks/{card['id']}", json={"due_date": None})
    assert r.json()["due_date"] is None and r.json()["start_date"] == "2026-11-01"


def test_dates_do_not_hold_the_queue(client, project, dispatcher, repo):
    card = _card(client, project, start_date="2099-01-01", due_date="2099-02-01")
    client.patch(f"/api/tasks/{card['id']}", json=to_work(client))
    dispatcher.tick()
    assert repo.get_task(card["id"]).status != "todo"


def test_planning_survives_every_status(client, project, repo):
    card = _card(client, project, start_date="2026-11-01", due_date="2026-11-09", labels=["keep"])
    for status in ("backlog", "todo", "in_progress", "verifying", "merging", "failed", "done"):
        repo.update_task(card["id"], status=status)
        r = client.patch(f"/api/tasks/{card['id']}", json={"due_date": f"2026-12-{10 + len(status) % 10}"})
        assert r.status_code == 200, status
        again = client.get(f"/api/tasks/{card['id']}").json()
        assert again["start_date"] == "2026-11-01" and again["due_date"].startswith("2026-12")
        assert [item["name"] for item in again["labels"]] == ["keep"]
    client.post(f"/api/tasks/{card['id']}/archive")
    r = client.patch(f"/api/tasks/{card['id']}", json={"labels": ["keep", "more"]})
    assert r.status_code == 200 and len(r.json()["labels"]) == 2


def test_retry_keeps_the_plan(client, project, repo):
    card = _card(client, project, start_date="2026-11-01", due_date="2026-11-09", labels=["keep"])
    repo.update_task(card["id"], status="failed")
    client.patch(f"/api/tasks/{card['id']}", json=to_work(client))
    again = client.get(f"/api/tasks/{card['id']}").json()
    assert again["start_date"] == "2026-11-01" and again["due_date"] == "2026-11-09" and again["labels"]


# ---------- the batch plan ----------

def test_batch_plan_takes_labels_and_dates(client, project, git_repo):
    r = client.post("/api/tasks/batch", json={
        "project_id": project.id, "defaults": {"labels": ["epic"]},
        "tasks": [{"title": "one", "start_date": "2026-11-02", "due_date": "2026-11-03"},
                  {"title": "two", "labels": ["solo", "Epic"]}]})
    assert r.status_code == 201, r.text
    created = {c["title"]: c for c in r.json()["created"]}
    assert created["one"]["labels"] == ["epic"]
    # "Epic" is the existing label "epic": names match ignoring case, and the card's own list replaces the default
    assert created["two"]["labels"] == ["epic", "solo"]
    one = client.get(f"/api/tasks/{created['one']['id']}").json()
    assert (one["start_date"], one["due_date"]) == ("2026-11-02", "2026-11-03")
    two = client.get(f"/api/tasks/{created['two']['id']}").json()
    assert sorted(item["name"] for item in two["labels"]) == ["epic", "solo"]


def test_batch_plan_refuses_bad_dates_and_creates_nothing(client, project):
    r = client.post("/api/tasks/batch", json={"project_id": project.id, "tasks": [
        {"title": "ok"}, {"title": "bad", "due_date": "soon"}]})
    assert r.status_code == 400
    assert client.get("/api/tasks").json() == []


# ---------- migration of an old database ----------

def test_old_database_gets_the_new_columns(tmp_path):
    from orc.db import connect, init_schema

    path = tmp_path / "old.db"
    conn = connect(path)
    init_schema(conn)
    conn.execute("ALTER TABLE tasks DROP COLUMN start_date")
    conn.execute("ALTER TABLE tasks DROP COLUMN due_date")
    conn.execute("DROP TABLE task_labels")
    conn.execute("DROP TABLE labels")
    conn.commit()
    init_schema(conn)
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)")}
    assert {"start_date", "due_date"} <= cols
    conn.execute("INSERT INTO labels (name) VALUES ('a')")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO labels (name) VALUES ('A')")


# ---------- orc task ----------

@pytest.fixture
def through_api(client):
    def call(method, path, payload=None):
        r = client.request(method, path, json=payload) if payload is not None else client.request(method, path)
        if r.status_code >= 400:
            raise task_cli.CliError(task_cli._error_text(r.text))
        return r.json()
    return call


@pytest.fixture
def in_project(client, git_repo, monkeypatch):
    client.post("/api/projects", json={"name": "demo", "path": str(git_repo)})
    monkeypatch.chdir(git_repo)


def _run(argv, call, capsys):
    code = task_cli.run(parse_args(["task", *argv]), call)
    out = capsys.readouterr()
    return code, out.out, out.err


def test_cli_add_edit_and_filter_by_label(client, in_project, through_api, capsys):
    code, out, _ = _run(["add", "Cli", "--label", "bug", "--label", "ui", "--start-date", "2026-11-01",
                         "--due-date", "2026-11-05"], through_api, capsys)
    assert code == 0 and "labels bug, ui" in out
    card = client.get("/api/tasks").json()[0]
    assert (card["start_date"], card["due_date"]) == ("2026-11-01", "2026-11-05")
    code, out, _ = _run(["edit", str(card["id"]), "--label", "later", "--remove-label", "BUG", "--clear", "due_date"],
                        through_api, capsys)
    assert code == 0 and "labels: later, ui" in out
    assert client.get(f"/api/tasks/{card['id']}").json()["due_date"] is None
    client.post("/api/tasks", json={"project_id": card["project_id"], "title": "other"})
    code, out, _ = _run(["list", "--label", "later"], through_api, capsys)
    assert "Cli" in out and "other" not in out
    code, _, err = _run(["list", "--label", "nope"], through_api, capsys)
    assert code == 1 and "not found" in err


def test_cli_sends_nothing_new_unless_asked(in_project, capsys):
    sent = []

    def call(method, path, payload=None):
        sent.append((method, path, payload))
        return {"created": [], "warnings": []}

    _run(["add", "Plain"], call, capsys)
    card = sent[-1][2]["tasks"][0]
    assert not {"labels", "start_date", "due_date"} & set(card)


def test_cli_tells_when_the_server_is_older(in_project, capsys):
    def old_server(method, path, payload=None):
        if path == "/api/labels":
            raise task_cli.CliError("Not Found")
        if path.startswith("/api/tasks/context"):
            return {"project": {"id": 1}, "projects": []}
        if method == "POST":
            raise task_cli.CliError("tasks.0.labels: Extra inputs are not permitted")
        if method == "PATCH":
            return {"id": 1, "status": "backlog"}  # an old server drops unknown fields and answers as usual
        return {"id": 1, "status": "backlog", "project_id": 1}

    code, _, err = _run(["list", "--label", "x"], old_server, capsys)
    assert code == 1 and "older than this CLI" in err
    code, _, err = _run(["add", "T", "--label", "x"], old_server, capsys)
    assert code == 1 and "older than this CLI" in err
    code, _, err = _run(["edit", "1", "--due-date", "2026-11-05"], old_server, capsys)
    assert code == 1 and "older than this CLI" in err
    code, _, err = _run(["edit", "1", "--label", "x"], old_server, capsys)
    assert code == 1 and "older than this CLI" in err
