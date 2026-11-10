import sqlite3

import pytest

from orc.config import Settings
from orc.db import ADD_COLUMNS, SCHEMA, connect, init_schema
from orc.repo import Repo


def test_init_schema_creates_tables(tmp_path):
    conn = connect(tmp_path / "orc.db")
    init_schema(conn)
    names = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"projects", "tasks", "task_deps", "comments", "events", "settings"} <= names


def test_init_schema_is_idempotent(tmp_path):
    conn = connect(tmp_path / "orc.db")
    init_schema(conn)
    init_schema(conn)  # the second call does not fail


def test_rows_are_dict_like(tmp_path):
    conn = connect(tmp_path / "orc.db")
    row = conn.execute("SELECT 1 AS one").fetchone()
    assert isinstance(row, sqlite3.Row)
    assert row["one"] == 1


def test_settings_db_path(tmp_path):
    s = Settings(data_dir=tmp_path)
    assert s.db_path == tmp_path / "orc.db"


def test_foreign_keys_are_enforced(tmp_path):
    conn = connect(tmp_path / "orc.db")
    init_schema(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO tasks (project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (999, "no such project", "2030-01-01T00:00:00+00:00", "2030-01-01T00:00:00+00:00"),
        )


def test_existing_db_without_new_columns_is_migrated(tmp_path):
    # The schema is created via CREATE TABLE IF NOT EXISTS, so in an already existing database
    # new columns will not appear on their own: init_schema must add them with ALTER TABLE and not
    # lose data.
    db = tmp_path / "old.db"
    conn = connect(db)
    old_schema = SCHEMA
    for column in ADD_COLUMNS["tasks"]:
        old_schema = "\n".join(line for line in old_schema.splitlines() if not line.strip().startswith(column))
    conn.executescript(old_schema)
    conn.execute("INSERT INTO projects (name, path, created_at) VALUES ('p', '/tmp/p', '2026-01-01T00:00:00+00:00')")
    conn.execute(
        "INSERT INTO tasks (project_id, title, created_at, updated_at) VALUES (1, 'old task', ?, ?)",
        ("2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)")}
    assert not (set(ADD_COLUMNS["tasks"]) & columns)  # the columns really are absent

    init_schema(conn)  # migration
    row = conn.execute("SELECT * FROM tasks WHERE id = 1").fetchone()
    assert row["title"] == "old task"
    for column, definition in ADD_COLUMNS["tasks"].items():
        # A counter column has default 0, an optional string column has none: the old row
        # must get exactly the default in both cases, not garbage.
        assert row[column] == (0 if "DEFAULT 0" in definition else None)
    init_schema(conn)  # a repeated migration does not fail
    assert Repo(conn).get_task(1).state_miss_count == 0  # the Task dataclass is built from the row


def test_key_queries_use_indexes(tmp_path):
    """Queries the dispatcher runs on every tick must not scan the whole table."""
    conn = connect(tmp_path / "orc.db")
    init_schema(conn)

    plans = {
        "tasks_by_status": "SELECT * FROM tasks WHERE status = 'todo' AND archived_at IS NULL",
        "tasks_by_project": "SELECT * FROM tasks WHERE project_id = 1",
        "pending_messages": "SELECT * FROM outbox WHERE task_id = 1 AND state = 'queued'",
        "unread_events": "SELECT * FROM events WHERE is_read = 0",
        "open_inputs": "SELECT * FROM input_requests WHERE task_id = 1 AND state = 'open'",
        "comments": "SELECT * FROM comments WHERE task_id = 1",
    }
    for name, sql in plans.items():
        plan = " ".join(row[3] for row in conn.execute(f"EXPLAIN QUERY PLAN {sql}"))
        assert "USING INDEX" in plan or "USING COVERING INDEX" in plan, f"{name}: {plan}"


def test_schema_version_is_written(tmp_path):
    from orc.db import SCHEMA_VERSION

    conn = connect(tmp_path / "orc.db")
    init_schema(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION


def test_database_from_the_future_is_refused(tmp_path):
    """An old orc must not silently work with a database written by a newer version:
    it does not know its columns and would quietly lose data."""
    from orc.db import SCHEMA_VERSION, SchemaTooNewError

    path = tmp_path / "orc.db"
    conn = connect(path)
    init_schema(conn)
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 5}")
    conn.commit()
    conn.close()

    again = connect(path)
    with pytest.raises(SchemaTooNewError) as e:
        init_schema(again)
    assert "update the code" in str(e.value)


def test_migrations_run_in_order_once(tmp_path, monkeypatch):
    """A migration is applied once, to a database older than its version, and the version grows with the registry."""
    from orc import db

    applied = []

    def migrate_1(conn):
        applied.append("m1")
        conn.execute("CREATE TABLE IF NOT EXISTS migrated (x INTEGER)")

    monkeypatch.setattr(db, "MIGRATIONS", [migrate_1])
    monkeypatch.setattr(db, "SCHEMA_VERSION", 2)

    path = tmp_path / "orc.db"
    conn = connect(path)
    init_schema(conn)          # database from version 0: the migration is applied
    init_schema(conn)          # already version 2: not applied again
    assert applied == ["m1"]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2


def test_routines_project_id_becomes_nullable_keeping_rows(tmp_path):
    """Routines outside a project need project_id to accept NULL: an old table (NOT NULL, with agent_id added
    by ALTER) is rebuilt without losing rows or columns, and a repeated start leaves it alone."""
    conn = connect(tmp_path / "old.db")
    conn.executescript(SCHEMA.replace(
        "  -- NULL means a routine outside any project: each run is a chat with its agent (orc/routines.py)\n"
        "  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,",
        "  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,"))
    conn.execute("ALTER TABLE routines ADD COLUMN agent_id INTEGER")
    conn.execute("PRAGMA user_version = 3")  # the state before this migration
    conn.execute("INSERT INTO projects (name, path, created_at) VALUES ('p', '/tmp/p', '2026-01-01T00:00:00+00:00')")
    conn.execute(
        "INSERT INTO routines (project_id, title, description, run_count, agent_id, created_at, updated_at) "
        "VALUES (1, 'old routine', 'do it', 7, 5, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')")
    conn.commit()
    assert {r["name"]: r["notnull"] for r in conn.execute("PRAGMA table_info(routines)")}["project_id"] == 1

    init_schema(conn)
    info = {r["name"]: r["notnull"] for r in conn.execute("PRAGMA table_info(routines)")}
    assert info["project_id"] == 0
    repo = Repo(conn)
    old = repo.get_routine(1)
    assert (old.title, old.project_id, old.run_count, old.agent_id) == ("old routine", 1, 7, 5)
    free = repo.add_routine(None, "free", description="x")  # NULL project_id is accepted now
    assert free.project_id is None
    init_schema(conn)  # a repeated start does not rebuild again
    assert repo.get_routine(free.id).title == "free"


def test_migration_clears_run_parameters_left_in_cards(tmp_path):
    """A card is tied to its agent: values an older version stored in its row are cleared, not left to look like a setting."""
    from orc import db
    conn = db.connect(tmp_path / "orc.db")
    db.init_schema(conn)
    conn.execute("INSERT INTO projects (name, path, created_at) VALUES ('p', '/p', 't')")
    conn.execute("INSERT INTO tasks (project_id, title, description, model, effort, permission_mode, created_at, updated_at) "
                 "VALUES (1, 't', '', 'opus', 'high', 'auto', 't', 't')")
    db._drop_card_run_parameters(conn)
    row = conn.execute("SELECT model, effort, permission_mode FROM tasks").fetchone()
    assert (row["model"], row["effort"], row["permission_mode"]) == (None, None, None)
