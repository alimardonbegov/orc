"""The only place where SQL lives. All methods are serialized by an RLock: the connection is shared by two threads."""
from __future__ import annotations

import sqlite3
import threading
from typing import Any

from orc.models import PROJECT_COLUMNS, ROUTINE_COLUMNS, TASK_COLUMNS, Project, Routine, Task
from orc.util import now_iso
from orc.viewing import STALE_UNVIEWED_SQL, UNVIEWED_SQL


def _unique(ids: list[int] | tuple[int, ...]) -> list[int]:
    """Duplicates in the blockers list: (task_id, depends_on_id) is the primary key, a second insert
    of the same id fails on UNIQUE. We keep the order, it is visible to the owner on the card."""
    return list(dict.fromkeys(ids))


class Repo:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self._lock = threading.RLock()

    # ---------- projects ----------

    def add_project(self, name: str, path: str, **fields: Any) -> Project:
        self._check_columns(fields, PROJECT_COLUMNS - {"id", "name", "path", "created_at"})
        cols = {"name": name, "path": path, "created_at": now_iso(), **fields}
        with self._lock:
            cur = self.conn.execute(
                f"INSERT INTO projects ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                list(cols.values()),
            )
            self.conn.commit()
            return self.get_project(cur.lastrowid)

    def list_projects(self, archived: bool | None = None) -> list[Project]:
        """archived=None (default) means all projects, False only live ones, True only the archive.

        The default is the opposite of tasks: the dispatcher looks here for the project of a task already picked up,
        and an archived project card must still be found for it, otherwise the task
        it is handling would suddenly end up "without a project". The archive is filtered out by whoever draws
        the list, that is, the API.
        """
        sql = "SELECT * FROM projects"
        if archived is not None:
            sql += " WHERE archived_at IS NOT NULL" if archived else " WHERE archived_at IS NULL"
        sql += " ORDER BY id"
        with self._lock:
            rows = self.conn.execute(sql).fetchall()
        return [Project(**dict(r)) for r in rows]

    def project_by_path(self, path: str) -> Project | None:
        """The project that already occupies this folder. path is UNIQUE in the table: without this check
        changing the path would fail with a bare "UNIQUE constraint failed" instead of an explanation."""
        with self._lock:
            row = self.conn.execute("SELECT * FROM projects WHERE path = ?", (path,)).fetchone()
        return Project(**dict(row)) if row else None

    def get_project(self, project_id: int) -> Project | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return Project(**dict(row)) if row else None

    def update_project(self, project_id: int, **fields: Any) -> Project:
        self._check_columns(fields, PROJECT_COLUMNS - {"id", "created_at"})
        self._update("projects", project_id, fields)
        return self.get_project(project_id)

    # ---------- tasks ----------

    def add_task(
        self,
        project_id: int,
        title: str,
        description: str = "",
        priority: str = "normal",
        target_branch: str | None = None,
        depends_on: list[int] | tuple[int, ...] = (),
        **fields: Any,
    ) -> Task:
        self._check_columns(fields, TASK_COLUMNS - {"id", "project_id", "created_at", "updated_at"})
        ts = now_iso()
        cols = {
            "project_id": project_id,
            "title": title,
            "description": description,
            "priority": priority,
            "target_branch": target_branch,
            "created_at": ts,
            "updated_at": ts,
            **fields,
        }
        # The task and its dependencies are written in ONE transaction under one lock acquisition.
        # Otherwise between the task commit and the insert of the links there is a window in which a card with
        # status todo is already visible but has no blockers yet: a dispatcher tick from a background
        # thread considers it ready and picks it up. A failure while inserting the links must, for the same
        # reason, roll back the task itself too: a "task without blockers" is worse than its
        # absence: the dispatcher will start it immediately.
        with self._lock:
            try:
                cur = self.conn.execute(
                    f"INSERT INTO tasks ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                    list(cols.values()),
                )
                task_id = cur.lastrowid
                if depends_on:
                    self.conn.executemany(
                        "INSERT INTO task_deps (task_id, depends_on_id) VALUES (?, ?)",
                        [(task_id, d) for d in _unique(depends_on)],
                    )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return self.get_task(task_id)

    def get_task(self, task_id: int) -> Task | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return Task(**dict(row)) if row else None

    def list_tasks(self, project_id: int | None = None, status: str | None = None,
                   archived: bool | None = False) -> list[Task]:
        """archived=False (default) means only live tasks, True only the archive, None all.

        The default is deliberate: the task list is also read by the dispatcher, and an archived card does not
        exist for it: it is not picked up, not merged and not counted in the worker limit.
        So that this does not have to be remembered at every call, the archive is filtered out here.
        """
        where, params = [], []
        if project_id is not None:
            where.append("project_id = ?")
            params.append(project_id)
        if status is not None:
            where.append("status = ?")
            params.append(status)
        if archived is not None:
            where.append("archived_at IS NOT NULL" if archived else "archived_at IS NULL")
        sql = "SELECT * FROM tasks"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [Task(**dict(r)) for r in rows]

    def update_task(self, task_id: int, **fields: Any) -> Task:
        self._check_columns(fields, TASK_COLUMNS - {"id", "project_id", "created_at"})
        fields = {**fields, "updated_at": now_iso()}
        self._update("tasks", task_id, fields)
        return self.get_task(task_id)

    # ---------- viewing results (orc/viewing.py) ----------

    def set_viewed(self, task_id: int, viewed: bool) -> Task:
        """Mark a task result as viewed or return it to unviewed.

        Deliberately bypassing update_task: a look is not an edit, and it does not move updated_at
        (tasks without done_at are sorted by it and an open card is re-read by it).
        """
        with self._lock:
            self.conn.execute("UPDATE tasks SET viewed_at = ? WHERE id = ?",
                              (now_iso() if viewed else None, task_id))
            self.conn.commit()
        return self.get_task(task_id)

    def mark_all_viewed(self, project_id: int, before: str | None = None) -> int:
        """Mark all unviewed finished tasks of a project as viewed; return how many.

        before: only those closed earlier than this moment, so enabling viewing for a project
        leaves fresh ones unviewed rather than the whole archive. Archived cards are
        marked too: when they return to the board, they must not surface as new.
        """
        condition = UNVIEWED_SQL if before is None else STALE_UNVIEWED_SQL
        sql = f"UPDATE tasks SET viewed_at = ? WHERE project_id = ? AND {condition}"
        params: list[Any] = [now_iso(), project_id]
        if before is not None:
            params.append(before)
        with self._lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
        return cur.rowcount

    def delete_task(self, task_id: int) -> None:
        """Delete a task for good. Comments, the message queue and dependency links
        go away through ON DELETE CASCADE, events through SET NULL (the feed record stays,
        but without a link to the card). PRAGMA foreign_keys is enabled in db.connect."""
        with self._lock:
            self.conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
            self.conn.commit()

    def dependents_of(self, task_id: int) -> list[int]:
        """Who is waiting for this task. Needed before deletion and archiving: the link will disappear,
        and a person should learn about it in advance, not from a suddenly shifted card."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT task_id FROM task_deps WHERE depends_on_id = ? ORDER BY task_id", (task_id,)
            ).fetchall()
        return [r["task_id"] for r in rows]

    def set_deps(self, task_id: int, depends_on: list[int]) -> None:
        with self._lock:
            # Rollback is mandatory: without it an uncommitted DELETE stays hanging in the open
            # transaction of the connection, and the next commit() of any other method will write it
            # to the database: the task silently ends up with no blockers at all.
            try:
                self.conn.execute("DELETE FROM task_deps WHERE task_id = ?", (task_id,))
                self.conn.executemany(
                    "INSERT INTO task_deps (task_id, depends_on_id) VALUES (?, ?)",
                    [(task_id, d) for d in _unique(depends_on)],
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

    def deps_of(self, task_id: int) -> list[int]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT depends_on_id FROM task_deps WHERE task_id = ? ORDER BY depends_on_id", (task_id,)
            ).fetchall()
        return [r["depends_on_id"] for r in rows]

    def all_deps(self) -> dict[int, list[int]]:
        with self._lock:
            rows = self.conn.execute("SELECT task_id, depends_on_id FROM task_deps ORDER BY task_id, depends_on_id").fetchall()
        result: dict[int, list[int]] = {}
        for r in rows:
            result.setdefault(r["task_id"], []).append(r["depends_on_id"])
        return result

    # ---------- task sessions ----------

    def add_task_session(self, task_id: int, job_id: str, session_id: str | None,
                         transcript_path: str | None) -> dict:
        """Record a session in the task journal. A repeat of the same pair (task_id, job_id) is not an error:
        backfill and registration at startup may see one job twice."""
        with self._lock:
            self.conn.execute(
                "INSERT INTO task_sessions (task_id, job_id, session_id, transcript_path, created_at) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, job_id) DO NOTHING",
                (task_id, job_id, session_id, transcript_path, now_iso()),
            )
            self.conn.commit()
            row = self.conn.execute(
                "SELECT * FROM task_sessions WHERE task_id = ? AND job_id = ?", (task_id, job_id)
            ).fetchone()
        return dict(row)

    def list_task_sessions(self, task_id: int) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM task_sessions WHERE task_id = ? ORDER BY id", (task_id,)
            ).fetchall()
        return [dict(r) for r in rows]

    def session_owners(self) -> dict[str, int]:
        """All jobs orc has ever launched -> task number. The source of truth for the cleaner:
        what is not here, orc did not launch and has no right to touch."""
        with self._lock:
            rows = self.conn.execute("SELECT job_id, task_id FROM task_sessions").fetchall()
        return {r["job_id"]: r["task_id"] for r in rows}

    def update_task_session(self, session_row_id: int, **fields: Any) -> None:
        self._check_columns(fields, {"session_id", "transcript_path"})
        self._update("task_sessions", session_row_id, fields)

    def first_session_times(self) -> dict[int, str]:
        """Task -> the moment of its FIRST session. For the dashboard this is "when the agent actually got to it":
        from submission until that moment the card simply sat in the queue (orc/analytics.py)."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT task_id, MIN(created_at) AS started_at FROM task_sessions GROUP BY task_id"
            ).fetchall()
        return {r["task_id"]: r["started_at"] for r in rows}

    def first_session_time(self, task_id: int) -> str | None:
        """The moment of the first session of one task: the same as first_session_times, for a card."""
        with self._lock:
            row = self.conn.execute(
                "SELECT MIN(created_at) AS started_at FROM task_sessions WHERE task_id = ?", (task_id,)
            ).fetchone()
        return row["started_at"] if row else None

    def input_requests_since(self, since_iso: str, project_id: int | None = None) -> list[dict]:
        """Input requests created no earlier than the given moment. The dashboard needs them to
        count how often the agent calls a human and how long the human takes to come (orc/analytics.py)."""
        sql = ("SELECT r.task_id, r.kind, r.state, r.created_at, r.answered_at "
               "FROM input_requests r JOIN tasks t ON t.id = r.task_id WHERE r.created_at >= ?")
        params: list[Any] = [since_iso]
        if project_id is not None:
            sql += " AND t.project_id = ?"
            params.append(project_id)
        sql += " ORDER BY r.id"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def tasks_without_sessions(self) -> list[Task]:
        """Tasks with a job_id but without a single record in the session journal: they appeared before the
        journal did. The archive too: the token badge is needed there as well."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT t.* FROM tasks t WHERE t.job_id IS NOT NULL "
                "AND NOT EXISTS (SELECT 1 FROM task_sessions s WHERE s.task_id = t.id) ORDER BY t.id"
            ).fetchall()
        return [Task(**dict(r)) for r in rows]

    # ---------- usage journal and limit history (orc/forecast.py) ----------

    def add_usage_entry(self, task_id: int | None, project_id: int | None, tokens: int, cost_usd: float,
                        at: str | None = None) -> None:
        """Increment of task usage since the previous token recount."""
        with self._lock:
            self.conn.execute(
                "INSERT INTO usage_ledger (task_id, project_id, at, tokens, cost_usd) VALUES (?, ?, ?, ?, ?)",
                (task_id, project_id, at or now_iso(), tokens, cost_usd),
            )
            self.conn.commit()

    def rescale_usage_entries(self, task_id: int, cost_usd: float) -> None:
        """Rewrite the money of the task journal so that the total comes to `cost_usd`.

        Needed after a price change: the increment was recorded at old prices, and splitting it by models
        retroactively is impossible. So the new total is divided across rows proportionally to
        tokens: time and projects stay the same, only the price changes.
        """
        with self._lock:
            row = self.conn.execute("SELECT SUM(tokens) AS t FROM usage_ledger WHERE task_id = ?",
                                    (task_id,)).fetchone()
            total = row["t"] if row and row["t"] else 0
            if total <= 0:
                return
            self.conn.execute("UPDATE usage_ledger SET cost_usd = ROUND(? * tokens / ?, 6) WHERE task_id = ?",
                              (cost_usd, float(total), task_id))
            self.conn.commit()

    def usage_entries_since(self, since_iso: str) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT task_id, project_id, at, tokens, cost_usd FROM usage_ledger WHERE at >= ? ORDER BY at",
                (since_iso,),
            ).fetchall()
        return [dict(r) for r in rows]

    def add_limit_sample(self, window: str, measured_at: float, used_pct: float, resets_at: float | None) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO limit_samples (limit_window, measured_at, used_pct, resets_at) VALUES (?, ?, ?, ?)",
                (window, measured_at, used_pct, resets_at),
            )
            self.conn.commit()

    def last_limit_sample(self, window: str) -> dict | None:
        with self._lock:
            row = self.conn.execute(
                "SELECT measured_at, used_pct, resets_at FROM limit_samples WHERE limit_window = ? "
                "ORDER BY measured_at DESC, id DESC LIMIT 1",
                (window,),
            ).fetchone()
        return dict(row) if row else None

    def limit_samples_since(self, window: str, since: float) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT measured_at, used_pct, resets_at FROM limit_samples WHERE limit_window = ? "
                "AND measured_at >= ? ORDER BY measured_at, id",
                (window, since),
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_limit_samples_before(self, before: float) -> int:
        with self._lock:
            cur = self.conn.execute("DELETE FROM limit_samples WHERE measured_at < ?", (before,))
            self.conn.commit()
        return cur.rowcount

    # ---------- attachments ----------

    def add_attachment(self, filename: str, mime: str, size: int, rel_path: str) -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO attachments (filename, mime, size, rel_path, created_at) VALUES (?, ?, ?, ?, ?)",
                (filename, mime, size, rel_path, now_iso()),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM attachments WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def get_attachment(self, attachment_id: int) -> dict | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM attachments WHERE id = ?", (attachment_id,)).fetchone()
        return dict(row) if row else None

    def attachments_total_size(self) -> int:
        """Sum of the sizes of all attachments across the database. From the database, not by walking the directory: on every
        save this is one query instead of a stat of all files."""
        with self._lock:
            row = self.conn.execute("SELECT COALESCE(SUM(size), 0) AS total FROM attachments").fetchone()
        return int(row["total"])

    # ---------- comments, events, settings ----------

    def add_comment(self, task_id: int, author: str, kind: str, body: str) -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO comments (task_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?)",
                (task_id, author, kind, body, now_iso()),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM comments WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def list_comments(self, task_id: int) -> list[dict]:
        with self._lock:
            rows = self.conn.execute("SELECT * FROM comments WHERE task_id = ? ORDER BY id", (task_id,)).fetchall()
        return [dict(r) for r in rows]

    # ---------- message queue into a session ----------

    def add_message(self, task_id: int, body: str, mode: str = "soft") -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO outbox (task_id, body, mode, created_at) VALUES (?, ?, ?, ?)",
                (task_id, body, mode, now_iso()),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM outbox WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def pending_messages(self, task_id: int | None = None) -> list[dict]:
        """Messages that are not yet delivered and not declared undeliverable."""
        sql = "SELECT * FROM outbox WHERE state NOT IN ('delivered', 'failed')"
        params: tuple = ()
        if task_id is not None:
            sql += " AND task_id = ?"
            params = (task_id,)
        sql += " ORDER BY id"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def tasks_with_pending_messages(self) -> list[int]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT DISTINCT task_id FROM outbox WHERE state NOT IN ('delivered', 'failed') ORDER BY task_id"
            ).fetchall()
        return [r["task_id"] for r in rows]

    def list_messages(self, task_id: int) -> list[dict]:
        with self._lock:
            rows = self.conn.execute("SELECT * FROM outbox WHERE task_id = ? ORDER BY id", (task_id,)).fetchall()
        return [dict(r) for r in rows]

    def update_message(self, message_id: int, **fields: Any) -> dict:
        self._check_columns(fields, {"body", "mode", "state", "attempts", "delivered_at"})
        self._update("outbox", message_id, fields)
        with self._lock:
            row = self.conn.execute("SELECT * FROM outbox WHERE id = ?", (message_id,)).fetchone()
        return dict(row)

    def mark_delivered(self, message_id: int) -> dict:
        return self.update_message(message_id, state="delivered", delivered_at=now_iso())

    # ---------- input requests from a session ----------

    def add_input_request(self, task_id: int, kind: str, tool_name: str, tool_input: str,
                          summary: str, session_id: str | None = None) -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO input_requests (task_id, session_id, kind, tool_name, tool_input, summary, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (task_id, session_id, kind, tool_name, tool_input, summary, now_iso()),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM input_requests WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def get_input_request(self, request_id: int) -> dict | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM input_requests WHERE id = ?", (request_id,)).fetchone()
        return dict(row) if row else None

    def open_input_request(self, task_id: int) -> dict | None:
        """A task's open request. There is never more than one: a new one closes the old one."""
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM input_requests WHERE task_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1",
                (task_id,),
            ).fetchone()
        return dict(row) if row else None

    def open_input_requests(self) -> dict[int, dict]:
        """Open requests of all tasks in one query, for the card list on the board."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM input_requests WHERE state = 'open' ORDER BY id"
            ).fetchall()
        return {r["task_id"]: dict(r) for r in rows}

    def answer_input_request(self, request_id: int, decision: str) -> dict:
        self._update("input_requests", request_id, {"state": "answered", "decision": decision, "answered_at": now_iso()})
        return self.get_input_request(request_id)

    def last_input_answer_at(self, task_id: int) -> str | None:
        """When the owner last answered a task's request. None means never."""
        with self._lock:
            row = self.conn.execute(
                "SELECT MAX(answered_at) AS at FROM input_requests WHERE task_id = ? AND state = 'answered'", (task_id,)
            ).fetchone()
        return row["at"] if row and row["at"] else None

    def cancel_input_requests(self, task_id: int) -> int:
        """Close a task's open requests without an answer: the session is gone, there is nobody to wait for its decision."""
        with self._lock:
            cur = self.conn.execute(
                "UPDATE input_requests SET state = 'cancelled' WHERE task_id = ? AND state = 'open'", (task_id,)
            )
            self.conn.commit()
        return cur.rowcount

    def add_event(self, message: str, level: str = "info", task_id: int | None = None, project_id: int | None = None) -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO events (task_id, project_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)",
                (task_id, project_id, level, message, now_iso()),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM events WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)

    # The event feed is returned right away with the project name and the task title: without them a line
    # like "#12 is waiting for an answer" says nothing when there are several projects and events are mixed.
    # A join, not separate requests from the client: up to two hundred events, and the task may have been
    # deleted, in which case task_id is already NULL (ON DELETE SET NULL) and there is nothing to pull in.
    _EVENTS_SELECT = """
        SELECT e.id,
               e.task_id,
               -- project_id may not have been recorded for old events: take it from the task
               COALESCE(e.project_id, t.project_id) AS project_id,
               e.level,
               e.message,
               e.is_read,
               e.created_at,
               COALESCE(p.name, tp.name) AS project_name,
               t.title  AS task_title,
               t.status AS task_status
        FROM events e
        LEFT JOIN tasks t     ON t.id  = e.task_id
        LEFT JOIN projects p  ON p.id  = e.project_id
        LEFT JOIN projects tp ON tp.id = t.project_id
    """

    def list_events(self, unread_only: bool = False, limit: int = 200) -> list[dict]:
        sql = self._EVENTS_SELECT
        if unread_only:
            sql += " WHERE e.is_read = 0"
        sql += " ORDER BY e.id DESC LIMIT ?"
        with self._lock:
            rows = self.conn.execute(sql, (limit,)).fetchall()
        return [dict(r) for r in rows]

    def mark_events_read(self) -> None:
        with self._lock:
            self.conn.execute("UPDATE events SET is_read = 1 WHERE is_read = 0")
            self.conn.commit()

    def delete_events_before(self, iso: str) -> int:
        """Remove events older than the given moment. Returns the number of deleted rows."""
        with self._lock:
            cur = self.conn.execute("DELETE FROM events WHERE created_at < ?", (iso,))
            self.conn.commit()
        return cur.rowcount

    def get_setting(self, key: str, default: str | None = None) -> str | None:
        with self._lock:
            row = self.conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
            self.conn.commit()

    def delete_setting(self, key: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM settings WHERE key = ?", (key,))
            self.conn.commit()

    # ---------- recurring tasks (orc/routines.py) ----------

    def add_routine(self, project_id: int, title: str, **fields: Any) -> Routine:
        self._check_columns(fields, ROUTINE_COLUMNS - {"id", "project_id", "title", "created_at", "updated_at"})
        ts = now_iso()
        cols = {"project_id": project_id, "title": title, "created_at": ts, "updated_at": ts, **fields}
        with self._lock:
            cur = self.conn.execute(
                f"INSERT INTO routines ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                list(cols.values()),
            )
            self.conn.commit()
            return self.get_routine(cur.lastrowid)

    def get_routine(self, routine_id: int) -> Routine | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM routines WHERE id = ?", (routine_id,)).fetchone()
        return Routine(**dict(row)) if row else None

    def list_routines(self, project_id: int | None = None) -> list[Routine]:
        sql, params = "SELECT * FROM routines", []
        if project_id is not None:
            sql += " WHERE project_id = ?"
            params.append(project_id)
        sql += " ORDER BY id"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [Routine(**dict(r)) for r in rows]

    def update_routine(self, routine_id: int, **fields: Any) -> Routine:
        self._check_columns(fields, ROUTINE_COLUMNS - {"id", "project_id", "created_at"})
        fields = {**fields, "updated_at": now_iso()}
        self._update("routines", routine_id, fields)
        return self.get_routine(routine_id)

    def delete_routine(self, routine_id: int) -> None:
        """Delete a routine. Its runs stay regular tasks: the reports and work history
        are real, and there is no reason to lose them together with the schedule."""
        with self._lock:
            self.conn.execute("UPDATE tasks SET routine_id = NULL WHERE routine_id = ?", (routine_id,))
            self.conn.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
            self.conn.commit()

    def routine_runs(self, routine_id: int) -> list[Task]:
        """All runs of a routine, including archived ones, newest first."""
        with self._lock:
            rows = self.conn.execute("SELECT * FROM tasks WHERE routine_id = ? ORDER BY id DESC",
                                     (routine_id,)).fetchall()
        return [Task(**dict(r)) for r in rows]

    def routine_run_stats(self) -> dict[int, dict[str, int]]:
        """Run counters by status for all routines in one query: {routine_id: {status: n}}."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT routine_id, status, COUNT(*) AS n FROM tasks WHERE routine_id IS NOT NULL "
                "GROUP BY routine_id, status").fetchall()
        out: dict[int, dict[str, int]] = {}
        for r in rows:
            out.setdefault(r["routine_id"], {})[r["status"]] = r["n"]
        return out

    def last_routine_runs(self) -> dict[int, Task]:
        """The latest run of each routine: {routine_id: Task}."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM tasks WHERE id IN (SELECT MAX(id) FROM tasks WHERE routine_id IS NOT NULL "
                "GROUP BY routine_id)").fetchall()
        return {r["routine_id"]: Task(**dict(r)) for r in rows}

    # ---------- internal ----------

    @staticmethod
    def _check_columns(fields: dict, allowed: set[str]) -> None:
        unknown = set(fields) - allowed
        if unknown:
            raise ValueError(f"unknown fields: {sorted(unknown)}")

    def _update(self, table: str, row_id: int, fields: dict) -> None:
        if not fields:
            return
        assignments = ", ".join(f"{k} = ?" for k in fields)
        with self._lock:
            self.conn.execute(f"UPDATE {table} SET {assignments} WHERE id = ?", [*fields.values(), row_id])
            self.conn.commit()
