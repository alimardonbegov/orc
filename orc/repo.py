"""The only place where SQL lives. All methods are serialized by an RLock: the connection is shared by two threads."""
from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterable
from typing import Any

from orc.models import (
    AGENT_COLUMNS, CHAT_COLUMNS, PROJECT_COLUMNS, ROUTINE_COLUMNS, TASK_COLUMNS, Agent, Chat, Project, Routine, Task,
)
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
        labels: list[str] | tuple[str, ...] = (),
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
                if labels:
                    self._attach_labels(task_id, labels)
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return self.get_task(task_id)

    def add_task_graph(self, rows: list[dict], deps: list[tuple[list[int], list[int]]],
                       labels: list[list[str]] | None = None) -> list[Task]:
        """Several cards and their links as one transaction: all of them or none.

        rows[i] holds the columns of a card. deps[i] is (ids of existing blockers, indexes of blockers
        within rows), and every index must be below i, which is what a topological order gives. The
        reasoning is the same as in add_task: a tick must never see a card without its blockers.
        labels[i] are the label names of rows[i]; missing labels are created in the same transaction.
        """
        allowed = TASK_COLUMNS - {"id", "created_at", "updated_at"}
        ts = now_iso()
        ids: list[int] = []
        with self._lock:
            try:
                for row, (existing, local) in zip(rows, deps):
                    self._check_columns(row, allowed)
                    cols = {**row, "created_at": ts, "updated_at": ts}
                    cur = self.conn.execute(
                        f"INSERT INTO tasks ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                        list(cols.values()),
                    )
                    blockers = _unique([*existing, *(ids[i] for i in local)])
                    self.conn.executemany(
                        "INSERT INTO task_deps (task_id, depends_on_id) VALUES (?, ?)",
                        [(cur.lastrowid, d) for d in blockers],
                    )
                    ids.append(cur.lastrowid)
                    if labels and labels[len(ids) - 1]:
                        self._attach_labels(cur.lastrowid, labels[len(ids) - 1])
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return [self.get_task(i) for i in ids]

    def tasks_by_batch_key(self, project_id: int, key: str, since: str) -> list[Task]:
        """The cards of an earlier request with the same idempotency key, oldest first."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM tasks WHERE project_id = ? AND batch_key = ? AND created_at >= ? ORDER BY id",
                (project_id, key, since),
            ).fetchall()
        return [Task(**dict(r)) for r in rows]

    def count_created_by(self, task_id: int) -> int:
        """How many cards this card's session has created. Deleted ones no longer count."""
        with self._lock:
            row = self.conn.execute("SELECT COUNT(*) AS n FROM tasks WHERE created_by_task_id = ?", (task_id,)).fetchone()
        return row["n"]

    def get_task(self, task_id: int) -> Task | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return Task(**dict(row)) if row else None

    def list_tasks(self, project_id: int | None = None, status: str | None = None,
                   archived: bool | None = False, label_id: int | None = None) -> list[Task]:
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
        if label_id is not None:
            where.append("id IN (SELECT task_id FROM task_labels WHERE label_id = ?)")
            params.append(label_id)
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
        if "blocker_detail" in fields and "detail_code" not in fields:
            fields["detail_code"] = None  # a code describes one text: a new or cleared text drops it
        self._update("tasks", task_id, fields)
        return self.get_task(task_id)

    def move_task_to_project(self, task_id: int, project_id: int, **fields: Any) -> Task:
        """Put a card into another project. update_task refuses project_id on purpose: only the move
        (Dispatcher.move_task) may change it, and it has checked that the card has not started."""
        self._check_columns(fields, TASK_COLUMNS - {"id", "project_id", "created_at"})
        self._update("tasks", task_id, {**fields, "project_id": project_id, "updated_at": now_iso()})
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
            # Subtasks outlive their parent as top-level cards: the reference has no foreign key to do it.
            # Both or neither: a pending UPDATE left on the shared connection would be written by the next commit.
            try:
                self.conn.execute("UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?", (task_id,))
                self.conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

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

    # ---------- labels (orc/labels.py) ----------

    def list_labels(self) -> list[dict]:
        """Every label with the number of cards that carry it, in one query. Archived cards count too:
        the label is theirs until they are deleted."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT l.id, l.name, l.color, COUNT(tl.task_id) AS task_count FROM labels l "
                "LEFT JOIN task_labels tl ON tl.label_id = l.id GROUP BY l.id ORDER BY l.name COLLATE NOCASE"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_label(self, label_id: int) -> dict | None:
        with self._lock:
            row = self.conn.execute("SELECT id, name, color FROM labels WHERE id = ?", (label_id,)).fetchone()
        return dict(row) if row else None

    def get_label_by_name(self, name: str) -> dict | None:
        with self._lock:
            row = self.conn.execute("SELECT id, name, color FROM labels WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        return dict(row) if row else None

    def add_label(self, name: str, color: str) -> dict:
        """Raises sqlite3.IntegrityError when a label with this name (ignoring case) exists."""
        with self._lock:
            try:
                cur = self.conn.execute("INSERT INTO labels (name, color) VALUES (?, ?)", (name, color))
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
            return self.get_label(cur.lastrowid)

    def update_label(self, label_id: int, **fields: str) -> dict:
        """Rename or recolour. Raises sqlite3.IntegrityError when the new name is taken."""
        if not fields:
            return self.get_label(label_id)
        if set(fields) - {"name", "color"}:
            raise ValueError(f"unknown label fields: {sorted(set(fields) - {'name', 'color'})}")
        with self._lock:
            try:
                self.conn.execute(f"UPDATE labels SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                                  [*fields.values(), label_id])
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
            return self.get_label(label_id)

    def delete_label(self, label_id: int) -> None:
        """The label leaves every card through ON DELETE CASCADE."""
        with self._lock:
            self.conn.execute("DELETE FROM labels WHERE id = ?", (label_id,))
            self.conn.commit()

    def _attach_labels(self, task_id: int, names: Iterable[str]) -> None:
        """Make `names` the card's labels, creating missing ones. No commit: the caller owns the transaction."""
        ids: list[int] = []
        for name in names:
            row = self.conn.execute("SELECT id FROM labels WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
            if row is None:
                from orc.labels import DEFAULT_COLOR

                row = {"id": self.conn.execute("INSERT INTO labels (name, color) VALUES (?, ?)",
                                               (name, DEFAULT_COLOR)).lastrowid}
            ids.append(row["id"])
        self.conn.execute("DELETE FROM task_labels WHERE task_id = ?", (task_id,))
        self.conn.executemany("INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)",
                              [(task_id, i) for i in ids])

    def set_task_labels(self, task_id: int, names: list[str]) -> None:
        with self._lock:
            try:
                self._attach_labels(task_id, names)
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

    def labels_by_task(self) -> dict[int, list[dict]]:
        """The labels of every card in ONE query, for the list: a query per card would grow with the board."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT tl.task_id, l.id, l.name, l.color FROM task_labels tl JOIN labels l ON l.id = tl.label_id "
                "ORDER BY l.name COLLATE NOCASE"
            ).fetchall()
        result: dict[int, list[dict]] = {}
        for r in rows:
            result.setdefault(r["task_id"], []).append({"id": r["id"], "name": r["name"], "color": r["color"]})
        return result

    def labels_of(self, task_id: int) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT l.id, l.name, l.color FROM task_labels tl JOIN labels l ON l.id = tl.label_id "
                "WHERE tl.task_id = ? ORDER BY l.name COLLATE NOCASE", (task_id,)
            ).fetchall()
        return [dict(r) for r in rows]

    # ---------- saved board views (orc/board_views.py) ----------

    def list_board_views(self, project_id: int) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT id, project_id, name, filters_json, created_at FROM board_views "
                "WHERE project_id = ? ORDER BY name COLLATE NOCASE", (project_id,)
            ).fetchall()
        return [dict(r) for r in rows]

    def get_board_view(self, view_id: int) -> dict | None:
        with self._lock:
            row = self.conn.execute(
                "SELECT id, project_id, name, filters_json, created_at FROM board_views WHERE id = ?", (view_id,)
            ).fetchone()
        return dict(row) if row else None

    def add_board_view(self, project_id: int, name: str, filters_json: str) -> dict:
        """Raises sqlite3.IntegrityError when the project already has a view with this name (ignoring case)."""
        with self._lock:
            try:
                cur = self.conn.execute(
                    "INSERT INTO board_views (project_id, name, filters_json, created_at) VALUES (?, ?, ?, ?)",
                    (project_id, name, filters_json, now_iso()),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
            return self.get_board_view(cur.lastrowid)

    def update_board_view(self, view_id: int, **fields: str) -> dict | None:
        """Rename or replace the filters. Raises sqlite3.IntegrityError when the new name is taken."""
        if set(fields) - {"name", "filters_json"}:
            raise ValueError(f"unknown view fields: {sorted(set(fields) - {'name', 'filters_json'})}")
        if fields:
            with self._lock:
                try:
                    self.conn.execute(f"UPDATE board_views SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                                      [*fields.values(), view_id])
                    self.conn.commit()
                except Exception:
                    self.conn.rollback()
                    raise
        return self.get_board_view(view_id)

    def delete_board_view(self, view_id: int) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM board_views WHERE id = ?", (view_id,))
            self.conn.commit()

    # ---------- task sessions ----------

    def add_task_session(self, task_id: int, job_id: str, session_id: str | None,
                         transcript_path: str | None, trigger: str | None = None,
                         agent_id: int | None = None, trigger_detail: str | None = None) -> dict:
        """Record a session in the task journal. A repeat of the same pair (task_id, job_id) is not an error:
        backfill and registration at startup may see one job twice.

        With a trigger this is a run starting (orc/sessions.py, register), and a repeat means the job came back:
        the row gets the new trigger and is open again. Without one it is bookkeeping, and an existing row
        keeps what it has."""
        with self._lock:
            if trigger is None:
                self.conn.execute(
                    "INSERT INTO task_sessions (task_id, job_id, session_id, transcript_path, created_at) "
                    "VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, job_id) DO NOTHING",
                    (task_id, job_id, session_id, transcript_path, now_iso()),
                )
            else:
                self.conn.execute(
                    "INSERT INTO task_sessions (task_id, job_id, session_id, transcript_path, created_at, trigger, "
                    "agent_id, trigger_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, job_id) DO UPDATE "
                    "SET trigger = excluded.trigger, agent_id = excluded.agent_id, "
                    "trigger_detail = excluded.trigger_detail, ended_at = NULL, outcome = NULL",
                    (task_id, job_id, session_id, transcript_path, now_iso(), trigger, agent_id, trigger_detail),
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

    def end_task_runs(self, task_id: int, outcome: str, except_id: int | None = None,
                      at: str | None = None) -> int:
        """Close the task's open runs with an outcome. Only open ones: the first outcome recorded is the one that
        happened, and a later bookkeeping call must not rewrite it. Returns how many were closed."""
        with self._lock:
            cur = self.conn.execute(
                "UPDATE task_sessions SET ended_at = ?, outcome = ? "
                "WHERE task_id = ? AND ended_at IS NULL AND id IS NOT ?",
                (at or now_iso(), outcome, task_id, except_id),
            )
            self.conn.commit()
        return cur.rowcount

    # ---------- wakeups (orc/wakeups.py) ----------

    def add_wakeup(self, task_id: int, kind: str, wake_at: str | None, watch_task_id: int | None,
                   note: str) -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO task_wakeups (task_id, kind, wake_at, watch_task_id, note, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (task_id, kind, wake_at, watch_task_id, note, now_iso()),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM task_wakeups WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def get_wakeup(self, wakeup_id: int) -> dict | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM task_wakeups WHERE id = ?", (wakeup_id,)).fetchone()
        return dict(row) if row else None

    def list_wakeups(self, task_id: int, state: str | None = None) -> list[dict]:
        sql, params = "SELECT * FROM task_wakeups WHERE task_id = ?", [task_id]
        if state is not None:
            sql += " AND state = ?"
            params.append(state)
        with self._lock:
            rows = self.conn.execute(sql + " ORDER BY id", params).fetchall()
        return [dict(r) for r in rows]

    def end_wakeup(self, wakeup_id: int, state: str, reason: str) -> bool:
        """Fire or cancel one pending wakeup. False if it was not pending any more: the conditional update is what
        keeps a wakeup from firing twice."""
        with self._lock:
            cur = self.conn.execute(
                "UPDATE task_wakeups SET state = ?, reason = ?, ended_at = ? WHERE id = ? AND state = 'pending'",
                (state, reason, now_iso(), wakeup_id),
            )
            self.conn.commit()
        return cur.rowcount == 1

    def cancel_wakeups(self, task_id: int, reason: str) -> int:
        """Cancel every pending wakeup of a task. Returns how many there were."""
        with self._lock:
            cur = self.conn.execute(
                "UPDATE task_wakeups SET state = 'cancelled', reason = ?, ended_at = ? "
                "WHERE task_id = ? AND state = 'pending'",
                (reason, now_iso(), task_id),
            )
            self.conn.commit()
        return cur.rowcount

    def orphan_wakeup_tasks(self) -> list[int]:
        """Tasks with a pending wakeup that are no longer in progress: nothing can be woken there."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT DISTINCT w.task_id FROM task_wakeups w JOIN tasks t ON t.id = w.task_id "
                "WHERE w.state = 'pending' AND (t.status != 'in_progress' OR t.archived_at IS NOT NULL) "
                "ORDER BY w.task_id"
            ).fetchall()
        return [r["task_id"] for r in rows]

    def add_task_check(self, task_id: int, job_id: str | None, cmd: str, ok: bool, duration_sec: float,
                       output_tail: str, exit_code: int | None = None, timed_out: bool = False) -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO task_checks (task_id, job_id, cmd, ok, duration_sec, output_tail, exit_code, timed_out, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (task_id, job_id, cmd, int(ok), duration_sec, output_tail, exit_code, int(timed_out), now_iso()),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM task_checks WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def list_task_checks(self, task_id: int) -> list[dict]:
        with self._lock:
            rows = self.conn.execute("SELECT * FROM task_checks WHERE task_id = ? ORDER BY id", (task_id,)).fetchall()
        return [dict(r) for r in rows]

    def task_usage_entries(self, task_id: int) -> list[dict]:
        """The task's spending log, oldest first: the execution log divides it between runs."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT at, tokens, cost_usd FROM usage_ledger WHERE task_id = ? ORDER BY id", (task_id,)
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

    # ---------- deliverables ----------

    def add_deliverable(self, task_id: int, name: str, attachment_id: int, sha256: str) -> dict:
        with self._lock:
            version = self.conn.execute(
                "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM deliverables WHERE task_id = ? AND name = ?",
                (task_id, name)).fetchone()["v"]
            cur = self.conn.execute(
                "INSERT INTO deliverables (task_id, name, version, attachment_id, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (task_id, name, version, attachment_id, sha256, now_iso()))
            self.conn.commit()
            row = self.conn.execute(self._DELIVERABLE_SELECT + " WHERE d.id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)

    _DELIVERABLE_SELECT = ("SELECT d.id, d.task_id, d.name, d.version, d.sha256, d.created_at, d.attachment_id, "
                           "a.size, a.rel_path FROM deliverables d JOIN attachments a ON a.id = d.attachment_id")

    def list_deliverables(self, task_id: int) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(self._DELIVERABLE_SELECT + " WHERE d.task_id = ? ORDER BY d.name, d.version DESC",
                                     (task_id,)).fetchall()
        return [dict(r) for r in rows]

    def latest_deliverable(self, task_id: int, name: str) -> dict | None:
        with self._lock:
            row = self.conn.execute(self._DELIVERABLE_SELECT + " WHERE d.task_id = ? AND d.name = ? ORDER BY d.version DESC LIMIT 1",
                                    (task_id, name)).fetchone()
        return dict(row) if row else None

    def get_deliverable(self, deliverable_id: int) -> dict | None:
        with self._lock:
            row = self.conn.execute(self._DELIVERABLE_SELECT + " WHERE d.id = ?", (deliverable_id,)).fetchone()
        return dict(row) if row else None

    def count_deliverables(self, task_id: int) -> int:
        with self._lock:
            return self.conn.execute("SELECT COUNT(*) AS n FROM deliverables WHERE task_id = ?", (task_id,)).fetchone()["n"]

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

    def task_events(self, task_id: int, limit: int = 200) -> list[dict]:
        """The latest events of one task, oldest first: the stages a card shows in its conversation."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?", (task_id, limit)
            ).fetchall()
        return [dict(r) for r in reversed(rows)]

    def task_events_containing(self, task_id: int, fragments: Iterable[str]) -> list[dict]:
        """A task's events whose text holds one of the fragments, oldest first. Unlike task_events, not cut
        to the latest: the execution log needs every merge however long the card has lived."""
        fragments = list(fragments)
        if not fragments:
            return []
        where = " OR ".join("instr(message, ?) > 0" for _ in fragments)
        with self._lock:
            rows = self.conn.execute(
                f"SELECT * FROM events WHERE task_id = ? AND ({where}) ORDER BY id", (task_id, *fragments)
            ).fetchall()
        return [dict(r) for r in rows]

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

    def add_routine(self, project_id: int | None, title: str, **fields: Any) -> Routine:
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
        self._check_columns(fields, ROUTINE_COLUMNS - {"id", "created_at"})
        fields = {**fields, "updated_at": now_iso()}
        self._update("routines", routine_id, fields)
        return self.get_routine(routine_id)

    def delete_routine(self, routine_id: int) -> None:
        """Delete a routine. Its runs stay regular tasks: the reports and work history
        are real, and there is no reason to lose them together with the schedule."""
        with self._lock:
            self.conn.execute("UPDATE tasks SET routine_id = NULL WHERE routine_id = ?", (routine_id,))
            self.conn.execute("UPDATE chats SET routine_id = NULL WHERE routine_id = ?", (routine_id,))
            self.conn.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
            self.conn.commit()

    # ---------- agents (orc/agents.py) ----------

    def add_agent(self, name: str, **fields: Any) -> Agent:
        self._check_columns(fields, AGENT_COLUMNS - {"id", "name", "created_at", "updated_at"})
        ts = now_iso()
        cols = {"name": name, "created_at": ts, "updated_at": ts, **fields}
        with self._lock:
            cur = self.conn.execute(
                f"INSERT INTO agents ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                list(cols.values()),
            )
            self.conn.commit()
            return self.get_agent(cur.lastrowid)

    def get_agent(self, agent_id: int) -> Agent | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
        return Agent(**dict(row)) if row else None

    def find_agent_by_name(self, name: str) -> Agent | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM agents WHERE name = ?", (name,)).fetchone()
        return Agent(**dict(row)) if row else None

    def list_agents(self, project_id: int | None = None) -> list[Agent]:
        """All agents; with project_id only those usable in that project: its own and the shared ones."""
        sql, params = "SELECT * FROM agents", []
        if project_id is not None:
            sql += " WHERE project_id IS NULL OR project_id = ?"
            params.append(project_id)
        sql += " ORDER BY name COLLATE NOCASE"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [Agent(**dict(r)) for r in rows]

    def update_agent(self, agent_id: int, **fields: Any) -> Agent:
        self._check_columns(fields, AGENT_COLUMNS - {"id", "created_at"})
        self._update("agents", agent_id, {**fields, "updated_at": now_iso()})
        return self.get_agent(agent_id)

    def agent_blockers(self, agent_id: int) -> dict[str, list[int]]:
        """What would silently change if the agent disappeared: tasks that may still run (a failed
        one can be retried, an archived one cannot start) and routines that create new runs."""
        with self._lock:
            tasks = self.conn.execute(
                "SELECT id FROM tasks WHERE agent_id = ? AND status != 'done' AND archived_at IS NULL ORDER BY id",
                (agent_id,)).fetchall()
            routines = self.conn.execute("SELECT id FROM routines WHERE agent_id = ? ORDER BY id",
                                         (agent_id,)).fetchall()
        return {"tasks": [r["id"] for r in tasks], "routines": [r["id"] for r in routines]}

    def agent_free_routines(self, agent_id: int) -> list[int]:
        """Routines outside any project that run with the agent: they need it available everywhere."""
        with self._lock:
            rows = self.conn.execute("SELECT id FROM routines WHERE agent_id = ? AND project_id IS NULL ORDER BY id",
                                     (agent_id,)).fetchall()
        return [r["id"] for r in rows]

    def agent_project_uses(self, agent_id: int) -> set[int]:
        """Projects whose tasks, routines or chats reference the agent: its scope cannot exclude them.
        Leadership is not here because one save can release it: see lead_projects."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT project_id AS p FROM tasks WHERE agent_id = ? "
                "UNION SELECT project_id FROM routines WHERE agent_id = ? AND project_id IS NOT NULL "
                "UNION SELECT project_id FROM chats WHERE agent_id = ? AND project_id IS NOT NULL",
                (agent_id, agent_id, agent_id)).fetchall()
        return {r["p"] for r in rows}

    def lead_projects(self) -> dict[int, list[int]]:
        """The projects each agent leads, for all agents in one query: {agent_id: [project_id]}."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT id, lead_agent_id FROM projects WHERE lead_agent_id IS NOT NULL ORDER BY id").fetchall()
        out: dict[int, list[int]] = {}
        for r in rows:
            out.setdefault(r["lead_agent_id"], []).append(r["id"])
        return out

    def set_agent_leads(self, agent_id: int, project_ids: Iterable[int]) -> tuple[dict[int, int | None], list[int]]:
        """Make the agent the lead of exactly these projects, in one transaction.

        A project has one lead, so a listed project led by another agent changes hands. A project the
        agent stops leading is left without a lead; other agents' projects are not touched.
        Returns the appointments as {project_id: previous lead} and the released project ids.
        """
        wanted = set(project_ids)
        with self._lock:
            rows = self.conn.execute("SELECT id, lead_agent_id FROM projects ORDER BY id").fetchall()
            appointed = {r["id"]: r["lead_agent_id"] for r in rows
                         if r["id"] in wanted and r["lead_agent_id"] != agent_id}
            released = [r["id"] for r in rows if r["lead_agent_id"] == agent_id and r["id"] not in wanted]
            self.conn.executemany("UPDATE projects SET lead_agent_id = ? WHERE id = ?",
                                  [(agent_id, project_id) for project_id in appointed])
            self.conn.executemany("UPDATE projects SET lead_agent_id = NULL WHERE id = ?",
                                  [(project_id,) for project_id in released])
            self.conn.commit()
        return appointed, released

    def agent_task_counts(self) -> dict[int, dict[str, int]]:
        """Task counters by status for all agents in one query: {agent_id: {status: n}}."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT agent_id, status, COUNT(*) AS n FROM tasks "
                "WHERE agent_id IS NOT NULL AND archived_at IS NULL GROUP BY agent_id, status").fetchall()
        out: dict[int, dict[str, int]] = {}
        for r in rows:
            out.setdefault(r["agent_id"], {})[r["status"]] = r["n"]
        return out

    def delete_agent(self, agent_id: int) -> None:
        """Delete an agent. Finished tasks stay and just lose the label; the caller has checked
        agent_blockers. Chats go with the agent by the foreign key."""
        with self._lock:
            self.conn.execute("UPDATE tasks SET agent_id = NULL WHERE agent_id = ?", (agent_id,))
            self.conn.execute("UPDATE routines SET agent_id = NULL WHERE agent_id = ?", (agent_id,))
            self.conn.execute("UPDATE projects SET lead_agent_id = NULL WHERE lead_agent_id = ?", (agent_id,))
            self.conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
            self.conn.commit()

    # ---------- chats (orc/chats.py) ----------

    def add_chat(self, agent_id: int, project_id: int | None, title: str = "", **fields: Any) -> Chat:
        self._check_columns(fields, {"routine_id", "routine_run", "status"})
        ts = now_iso()
        cols = {"agent_id": agent_id, "project_id": project_id, "title": title, "created_at": ts, "updated_at": ts,
                **fields}
        with self._lock:
            cur = self.conn.execute(
                f"INSERT INTO chats ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                list(cols.values()),
            )
            self.conn.commit()
            return self.get_chat(cur.lastrowid)

    def get_chat(self, chat_id: int) -> Chat | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        return Chat(**dict(row)) if row else None

    def list_chats(self, agent_id: int | None = None, project_id: int | None = None) -> list[Chat]:
        sql, where, params = "SELECT * FROM chats", [], []
        if agent_id is not None:
            where.append("agent_id = ?")
            params.append(agent_id)
        if project_id is not None:
            where.append("project_id = ?")
            params.append(project_id)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY updated_at DESC, id DESC"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [Chat(**dict(r)) for r in rows]

    def active_chats(self) -> list[Chat]:
        """Chats that need the chat loop: a turn is queued, running or stuck on a dialog."""
        with self._lock:
            rows = self.conn.execute("SELECT * FROM chats WHERE status != 'idle' ORDER BY id").fetchall()
        return [Chat(**dict(r)) for r in rows]

    def update_chat(self, chat_id: int, touch: bool = True, **fields: Any) -> Chat:
        """touch=False keeps updated_at: the list is ordered by it, so pinning, archiving or marking a chat
        read must not make it jump to the top as if it had news."""
        self._check_columns(fields, CHAT_COLUMNS - {"id", "created_at"})
        self._update("chats", chat_id, {**fields, "updated_at": now_iso()} if touch else fields)
        return self.get_chat(chat_id)

    def mark_all_chats_read(self) -> int:
        """Everything that exists now counts as read, in every chat. Returns how many chats had news."""
        with self._lock:
            cur = self.conn.execute(
                "UPDATE chats SET last_read_message_id = "
                "(SELECT COALESCE(MAX(m.id), 0) FROM chat_messages m WHERE m.chat_id = chats.id) "
                "WHERE last_read_message_id < (SELECT COALESCE(MAX(m.id), 0) FROM chat_messages m WHERE m.chat_id = chats.id)")
            self.conn.commit()
            return cur.rowcount

    def last_message_id(self, chat_id: int) -> int:
        with self._lock:
            row = self.conn.execute("SELECT MAX(id) AS id FROM chat_messages WHERE chat_id = ?", (chat_id,)).fetchone()
        return row["id"] or 0

    def last_reply_id(self, chat_id: int) -> int | None:
        """The newest message that can be unread: a reply or a proposal."""
        with self._lock:
            row = self.conn.execute(
                "SELECT MAX(id) AS id FROM chat_messages WHERE chat_id = ? AND role IN ('assistant', 'proposal')",
                (chat_id,)).fetchone()
        return row["id"]

    def delete_chat(self, chat_id: int) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
            self.conn.commit()

    def add_chat_message(self, chat_id: int, role: str, body: str, state: str | None = None) -> dict:
        ts = now_iso()
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO chat_messages (chat_id, role, body, state, created_at) VALUES (?, ?, ?, ?, ?)",
                (chat_id, role, body, state, ts),
            )
            self.conn.execute("UPDATE chats SET updated_at = ? WHERE id = ?", (ts, chat_id))
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM chat_messages WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def get_chat_message(self, message_id: int) -> dict | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM chat_messages WHERE id = ?", (message_id,)).fetchone()
        return dict(row) if row else None

    def list_chat_messages(self, chat_id: int, role: str | None = None, state: str | None = None) -> list[dict]:
        sql, params = "SELECT * FROM chat_messages WHERE chat_id = ?", [chat_id]
        if role is not None:
            sql += " AND role = ?"
            params.append(role)
        if state is not None:
            sql += " AND state = ?"
            params.append(state)
        sql += " ORDER BY id"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def update_chat_message(self, message_id: int, **fields: Any) -> None:
        self._check_columns(fields, {"body", "state"})
        self._update("chat_messages", message_id, fields)

    def chat_summaries(self) -> dict[int, dict]:
        """For the chat list, in one query: the last reply and how many replies are unread."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT c.id AS chat_id, "
                "(SELECT body FROM chat_messages m WHERE m.chat_id = c.id AND m.role IN ('user', 'assistant') "
                " ORDER BY m.id DESC LIMIT 1) AS last_message, "
                "(SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id AND m.role IN ('assistant', 'proposal') "
                " AND m.id > c.last_read_message_id) AS unread "
                "FROM chats c").fetchall()
        return {r["chat_id"]: {"last_message": r["last_message"], "unread": r["unread"]} for r in rows}

    def routine_runs(self, routine_id: int) -> list[Task]:
        """All runs of a routine, including archived ones, newest first."""
        with self._lock:
            rows = self.conn.execute("SELECT * FROM tasks WHERE routine_id = ? ORDER BY id DESC",
                                     (routine_id,)).fetchall()
        return [Task(**dict(r)) for r in rows]

    def routine_chats(self, routine_id: int) -> list[Chat]:
        """All runs of a routine outside any project, newest first."""
        with self._lock:
            rows = self.conn.execute("SELECT * FROM chats WHERE routine_id = ? ORDER BY id DESC",
                                     (routine_id,)).fetchall()
        return [Chat(**dict(r)) for r in rows]

    def routine_chat_stats(self) -> dict[int, dict[str, int]]:
        """Run counters by chat status for all routines outside a project: {routine_id: {status: n}}."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT routine_id, status, COUNT(*) AS n FROM chats WHERE routine_id IS NOT NULL "
                "GROUP BY routine_id, status").fetchall()
        out: dict[int, dict[str, int]] = {}
        for r in rows:
            out.setdefault(r["routine_id"], {})[r["status"]] = r["n"]
        return out

    def last_routine_chats(self) -> dict[int, Chat]:
        """The latest run of each routine outside a project: {routine_id: Chat}."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM chats WHERE id IN (SELECT MAX(id) FROM chats WHERE routine_id IS NOT NULL "
                "GROUP BY routine_id)").fetchall()
        return {r["routine_id"]: Chat(**dict(r)) for r in rows}

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
