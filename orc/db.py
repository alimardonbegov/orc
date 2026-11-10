"""SQLite connection and schema. The schema is created via IF NOT EXISTS, new columns via ADD_COLUMNS."""
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Callable

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  default_model TEXT,
  default_effort TEXT,
  default_permission_mode TEXT NOT NULL DEFAULT 'auto',
  -- Base branch for a project's new tasks. NULL means use the repository's current branch.
  default_branch TEXT,
  verify_cmd TEXT,
  verify_timeout_sec INTEGER NOT NULL DEFAULT 900,
  max_workers INTEGER NOT NULL DEFAULT 2,
  push_enabled INTEGER NOT NULL DEFAULT 0,
  -- The moment the project was archived. NULL means an ordinary project; otherwise it is removed from the dashboard,
  -- the dispatcher does not pick up its tasks, but the data is intact and the project comes back with one request.
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'normal',
  blocker TEXT,
  blocker_detail TEXT,
  target_branch TEXT,
  model TEXT,
  effort TEXT,
  permission_mode TEXT,
  verify_cmd TEXT,
  requires_review INTEGER NOT NULL DEFAULT 0,
  worktree_path TEXT,
  branch TEXT,
  job_id TEXT,
  session_id TEXT,
  auto_resume_count INTEGER NOT NULL DEFAULT 0,
  state_miss_count INTEGER NOT NULL DEFAULT 0,
  quota_retry_count INTEGER NOT NULL DEFAULT 0,
  conflict_retry_count INTEGER NOT NULL DEFAULT 0,
  resume_with TEXT,
  merge_queued_at TEXT,
  retry_after TEXT,
  report_json TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);

-- Log of the Claude Code sessions a task spawned over its life: start, resumes, the conflict
-- resolution session. tasks stores only the current job_id, while tokens (tasks.usage_json)
-- are counted over the transcripts of ALL sessions; without the log, spending before a resume/retry would be lost.
CREATE TABLE IF NOT EXISTS task_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  session_id TEXT,
  transcript_path TEXT,        -- ~/.claude/projects/<slug>/<session_id>.jsonl; NULL means not known yet
  created_at TEXT NOT NULL,
  UNIQUE (task_id, job_id)
);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'comment',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'soft',        -- soft: via the inbox; interrupt: stop the session
  state TEXT NOT NULL DEFAULT 'queued',     -- queued | sent | stopping | delivered | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

-- Input requests from a task's session: permission for a tool, an AskUserQuestion question, plan
-- approval. They are written by the hook orc/hooks/input_hook.py through the API, which waits for the owner's decision without leaving
-- the session; the decision goes back through the same hook. See docs/internals/input-requests.md.
CREATE TABLE IF NOT EXISTS input_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT,
  kind TEXT NOT NULL,                       -- permission | question | plan
  tool_name TEXT NOT NULL DEFAULT '',
  tool_input TEXT NOT NULL DEFAULT '{}',    -- JSON: the tool input as Claude Code passed it
  summary TEXT NOT NULL DEFAULT '',         -- a human-readable line for the badge and the feed
  state TEXT NOT NULL DEFAULT 'open',       -- open | answered | cancelled
  decision TEXT,                            -- JSON of the owner's decision; NULL while open/cancelled
  created_at TEXT NOT NULL,
  answered_at TEXT
);

-- One row per verification run (orc/dispatcher.py, _apply_verify_outcome): the card's execution log shows it to the
-- owner. Before, a failed check's output reached only the agent. output_tail is capped (orc/runs.py, OUTPUT_TAIL).
CREATE TABLE IF NOT EXISTS task_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  job_id TEXT,                 -- the session whose work was checked
  cmd TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_sec REAL NOT NULL DEFAULT 0,
  output_tail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Wakeups a task session asked for (orc/wakeups.py): resume me at a time, or when another card is done. While a
-- card sleeps it has no live session and holds no worker slot. watch_task_id has no foreign key: a deleted card is
-- itself a reason to wake.
CREATE TABLE IF NOT EXISTS task_wakeups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                      -- at | task
  wake_at TEXT,                            -- ISO UTC: the time, or the deadline of a task wakeup; NULL means none
  watch_task_id INTEGER,                   -- the card a task wakeup waits for
  note TEXT NOT NULL DEFAULT '',           -- what the agent wants to do when it wakes, given back to it
  state TEXT NOT NULL DEFAULT 'pending',   -- pending | fired | cancelled
  reason TEXT,                             -- why it fired or was cancelled
  created_at TEXT NOT NULL,
  ended_at TEXT
);

-- Recurring tasks (orc/routines.py): the task statement and schedule. Each run is an ordinary
-- row in tasks with routine_id, so a run has its own log, report, tokens and status.
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL means a routine outside any project: each run is a chat with its agent (orc/routines.py)
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  model TEXT,
  effort TEXT,
  permission_mode TEXT,
  verify_cmd TEXT,
  target_branch TEXT,
  schedule_kind TEXT NOT NULL DEFAULT 'interval',   -- interval | cron
  interval_minutes INTEGER,
  cron TEXT,
  timezone TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  max_runs INTEGER,
  archive_runs INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A pre-configured executor (orc/agents.py): run parameters plus an optional prompt. A task or a
-- routine points at one instead of carrying its own parameters. NULL project_id means available
-- everywhere; otherwise the agent is internal to that project. Empty run parameters are inherited
-- from the project, the same way a task inherits them.
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  avatar TEXT,                     -- a small data:image URL or a short glyph; NULL means initials
  model TEXT,
  effort TEXT,
  permission_mode TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  memory_enabled INTEGER NOT NULL DEFAULT 0,  -- 1: the agent's own memory directory (orc/agents.py)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A direct conversation with an agent (orc/chats.py): one Claude Code session in its own folder.
-- It lives apart from tasks: it has no board status, no verification and no merge.
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',     -- idle | queued | running | waiting
  cwd TEXT,
  branch TEXT,
  job_id TEXT,
  session_id TEXT,
  transcript_path TEXT,
  transcript_offset INTEGER NOT NULL DEFAULT 0,  -- bytes of the transcript already turned into messages
  turn_started_at TEXT,
  turn_progress INTEGER NOT NULL DEFAULT 0,      -- the current turn has written something to the transcript
  waiting_detail TEXT,
  usage_json TEXT,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                      -- user | assistant | activity | system | proposal
  body TEXT NOT NULL,
  -- user: queued | sent | failed | cancelled; proposal: open | accepted | dismissed; otherwise NULL
  state TEXT,
  created_at TEXT NOT NULL
);

-- Labels (orc/labels.py): global across projects, the name is unique ignoring case.
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#8b8b95'
);

CREATE TABLE IF NOT EXISTS task_labels (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

-- Saved board views (orc/board_views.py): a named set of board filters, per project.
CREATE TABLE IF NOT EXISTS board_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  filters_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Images pasted into the task text. There is deliberately no link to the task: the reference lives
-- as the marker ![caption](orc-image:<id>) inside the description itself, so an image's position
-- in the text is the position of the substring, and there is nothing to let the list drift out of sync with the text.
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  rel_path TEXT NOT NULL,      -- file name inside <data_dir>/attachments
  created_at TEXT NOT NULL
);

-- Files an agent hands in as the result of a card (orc/deliverables.py). The bytes live in the attachment store,
-- so they outlive the working copy. Handing in a name again makes the next version; the card going away takes
-- the rows with it, the stored file stays, as for any attachment.
CREATE TABLE IF NOT EXISTS deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, name, version)
);

-- Spending log over time: every recount of a task's tokens (orc/dispatcher.py,
-- _collect_usage) appends the INCREMENT since the previous recount here. tasks.usage_json is
-- only the total, and it cannot tell how much was spent over the last five hours, and without that
-- there is nothing to forecast the limit from (orc/forecast.py). A task may be deleted while real tokens
-- were spent on it, hence SET NULL, and project_id is stored here as well.
CREATE TABLE IF NOT EXISTS usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  project_id INTEGER,
  at TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);

-- History of the account limit percentages (5h and week). The orc/usage.py cache holds only
-- the latest probe, while the burn rate is the difference between probes over time. Times are epoch, as in
-- the probes themselves.
CREATE TABLE IF NOT EXISTS limit_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  limit_window TEXT NOT NULL,      -- five_hour | seven_day
  measured_at REAL NOT NULL,
  used_pct REAL NOT NULL,
  resets_at REAL
);
"""

# Indexes. The dispatcher runs all the queries below on EVERY pass, and the board does so every five
# seconds: without indexes this is a full table scan on every tick. Kept apart from SCHEMA and
# applied AFTER ADD_COLUMNS: some indexes reference columns (for example,
# tasks.archived_at) that an old database does not have yet at the time of CREATE TABLE IF NOT EXISTS.
INDEXES = """
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_outbox_task_state ON outbox (task_id, state);
CREATE INDEX IF NOT EXISTS idx_events_unread ON events (is_read);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments (task_id);
CREATE INDEX IF NOT EXISTS idx_input_requests_task_state ON input_requests (task_id, state);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_at ON usage_ledger (at);
CREATE INDEX IF NOT EXISTS idx_limit_samples_window ON limit_samples (limit_window, measured_at);
CREATE INDEX IF NOT EXISTS idx_tasks_routine ON tasks (routine_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks (agent_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages (chat_id, id);
CREATE INDEX IF NOT EXISTS idx_chats_status ON chats (status);
CREATE INDEX IF NOT EXISTS idx_task_checks_task ON task_checks (task_id);
CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels (label_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_task_wakeups_state ON task_wakeups (state, task_id);
"""


# Columns added after the first schema release. CREATE TABLE IF NOT EXISTS will not add them to an already
# existing database, so init_schema appends the missing ones via ALTER TABLE.
# Each must have a DEFAULT: the table already has rows.
ADD_COLUMNS: dict[str, dict[str, str]] = {
    "projects": {
        # Which branch to create new tasks' worktrees from and where to merge them.
        # NULL means as before the setting existed: the repository's current branch is used.
        "default_branch": "TEXT",
        # The moment the project was archived. NULL means the project is visible and working.
        "archived_at": "TEXT",
        # Manual order in the sidebar (drag, see web/src/components/Sidebar.tsx).
        # NULL means the project was never reordered by hand, the list is sorted by id (as before).
        "position": "INTEGER",
        # Models hidden from the model-selection dropdowns in this project: a JSON list of ids.
        # NULL means no list of its own, the shared one from the orc settings applies (settings.hidden_models).
        "hidden_models": "TEXT",
        # Result viewing (orc/viewing.py): a project's finished tasks wait for the owner's look.
        # On by default; 0 means a project without marks and unviewed counters.
        "track_viewed": "INTEGER NOT NULL DEFAULT 1",
        # The project's lead (orc/agents.py): an agent that sees the board in its chats and may
        # propose tasks. It does not change anyone's run parameters. NULL means no lead.
        "lead_agent_id": "INTEGER",
        # What this project's cards show and start with (orc/card_settings.py): a JSON object.
        # NULL means nothing of its own, the settings.card_settings of orc apply.
        "card_settings": "TEXT",
    },
    "tasks": {
        "state_miss_count": "INTEGER NOT NULL DEFAULT 0",
        "quota_retry_count": "INTEGER NOT NULL DEFAULT 0",
        # How many times the task was already sent to resolve a conflict with the target branch
        "conflict_retry_count": "INTEGER NOT NULL DEFAULT 0",
        # Message delivery state is denormalized onto the task so that the board is drawn
        # with a single task-list query, without fetching the queue for each card.
        "outbox_state": "TEXT",
        # The moment of archiving. NULL means the task is on the board; otherwise it is out of sight but intact:
        # the dispatcher does not pick it up, the board does not show it, and it can be returned with one request.
        "archived_at": "TEXT",
        # Manual order within a column (see web/src/components/Board.tsx, REORDERABLE).
        # NULL means the task was never reordered by hand, the board sorts such tasks by id (as before).
        "position": "INTEGER",
        # Token aggregate over all of the task's sessions (format: orc/token_usage.py). NULL means not counted.
        "usage_json": "TEXT",
        # This task's secret for its own hooks (orc/inputs.py). The session presents it
        # in the X-Orc-Hook header, and so cannot speak for a neighboring task.
        # NULL means the task was started before secrets existed; such hooks are let through for now (see api).
        "hook_secret": "TEXT",
        # Deferred start (orc/schedule.py): do not start earlier than start_after or later than
        # start_before. ISO UTC; NULL means no schedule. start_before without start_after does not occur.
        "start_after": "TEXT",
        "start_before": "TEXT",
        # When the owner viewed the result of a finished task (orc/viewing.py). NULL means not viewed.
        "viewed_at": "TEXT",
        # A run of a recurring task (orc/routines.py). There is deliberately no foreign key: ALTER TABLE
        # will not add one, and deleting a routine already nulls the reference (Repo.delete_routine).
        "routine_id": "INTEGER",
        "routine_run": "INTEGER",
        # The agent the task is allocated to (orc/agents.py). No foreign key for the same reason as
        # routine_id: Repo.delete_agent nulls the reference. NULL means the project's parameters.
        "agent_id": "INTEGER",
        # Who created the card (orc/task_plans.py). No foreign key for the same reason as routine_id,
        # and a dangling id is harmless: it only ends the walk that counts generations.
        "created_by_task_id": "INTEGER",
        # Idempotency key of a batch (orc/api/task_plans.py). NULL means no deduplication was asked for.
        "batch_key": "TEXT",
        # The session's signal that the work is handed in (orc/handoff.py): when, in epoch seconds so that it
        # compares with the start of a turn, and what it said: done | failed. NULL means no signal.
        "handoff_at": "REAL",
        "handoff_status": "TEXT",
        # Planning dates, YYYY-MM-DD (orc/labels.py). The dispatcher never reads them; start_after is the
        # deferred start that holds the queue. NULL means no date.
        "start_date": "TEXT",
        "due_date": "TEXT",
        # The card this one is a subtask of (web/src/relations.ts): grouping for decomposition, with no effect on the
        # queue. Not created_by_task_id, which the generation fuse walks: a person's subtask must not eat that budget.
        # No foreign key for the same reason as routine_id; Repo.delete_task nulls the children's reference.
        "parent_task_id": "INTEGER",
        # Waking the parent when its subtasks are done (orc/child_wake.py). wake_on_children: 1 wakes, 0 never,
        # NULL follows the project's and orc's card settings (off unless they say otherwise). children_wake_key is the
        # fingerprint of the subtasks the last wake (or the baseline taken when the setting was turned on) covered, so
        # the same finished set never wakes twice; children_wake_count caps the wakes of one card.
        "wake_on_children": "INTEGER",
        "children_wake_key": "TEXT",
        "children_wake_count": "INTEGER NOT NULL DEFAULT 0",
        # Why the pending resume (resume_with) was queued, as a run trigger (sessions.TRIGGERS). NULL means rework.
        "resume_trigger": "TEXT",
        # The stage among the subtasks of one parent (orc/stages.py); the blockers are derived, not stored
        "stage": "INTEGER",
        # The code of the reason in blocker_detail (orc/failures.py); NULL means the text stands alone
        "detail_code": "TEXT",
    },
    "task_sessions": {
        # The execution log (orc/runs.py): why the run started (sessions.TRIGGERS), when and how it ended
        # (sessions.OUTCOMES), and on behalf of which agent. NULL in rows written before the log existed: the card
        # labels them "Run" and derives their end from the next run.
        "trigger": "TEXT",
        "ended_at": "TEXT",
        "outcome": "TEXT",
        "agent_id": "INTEGER",
        # What exactly started the run, when the trigger alone does not say: for `wakeup`, which condition held.
        "trigger_detail": "TEXT",
    },
    "task_checks": {
        # How the check ended (orc/verify.py): the process exit code, and whether the timeout killed it.
        # NULL in rows written before the log kept it: the card then shows nothing about the code.
        "exit_code": "INTEGER",
        "timed_out": "INTEGER",
    },
    "routines": {
        # The agent each run is allocated to: copied into the run's task.
        "agent_id": "INTEGER",
    },
    "chats": {
        # A run of a routine outside any project (orc/routines.py): whose chat this is and which run
        # by count. No foreign key for the same reason as tasks.routine_id; Repo.delete_routine nulls it.
        "routine_id": "INTEGER",
        "routine_run": "INTEGER",
        # List organisation chosen by the owner: a pinned chat stays on top, an archived one leaves the
        # default list (orc/api/chats.py). Neither touches the conversation itself.
        "pinned": "INTEGER NOT NULL DEFAULT 0",
        "archived_at": "TEXT",
        # The chat's secret for its input-request hook (orc/inputs.py). NULL means none issued yet.
        "hook_secret": "TEXT",
    },
}


def _seed_usage_ledger(conn: sqlite3.Connection) -> None:
    """The spending log appeared later than tokens: the spending already counted for tasks goes into it as one
    row per task, at the moment of the last count (`scanned_at`), otherwise at the very end:
    `updated_at`. This is an approximation: a long task lands entirely at its end. But without it
    the weekly window would show almost zero per project for the first week after the update.
    The seeding moment is remembered: before it the breakdown over time is an estimate, and the dashboard says so.
    """
    import json

    from orc.util import now_iso

    rows = conn.execute("SELECT id, project_id, usage_json, updated_at FROM tasks WHERE usage_json IS NOT NULL").fetchall()
    for row in rows:
        try:
            usage = json.loads(row["usage_json"])
        except ValueError:
            continue
        if not isinstance(usage, dict):
            continue
        tokens = usage.get("total_tokens")
        if not isinstance(tokens, int) or isinstance(tokens, bool) or tokens <= 0:
            continue
        cost = ledger_cost(usage)
        at = usage.get("scanned_at") if isinstance(usage.get("scanned_at"), str) else row["updated_at"]
        conn.execute("INSERT INTO usage_ledger (task_id, project_id, at, tokens, cost_usd) VALUES (?, ?, ?, ?, ?)",
                     (row["id"], row["project_id"], at, tokens, cost))
    conn.execute("INSERT INTO settings (key, value) VALUES ('usage_ledger_since', ?) "
                 "ON CONFLICT(key) DO NOTHING", (now_iso(),))


def ledger_cost(usage: dict) -> float:
    """A task's money for the spending log: our own estimate by the price list, otherwise the exact one from Claude Code.

    The estimate goes first, unlike on the dashboard: the exact price arrives only when the
    session finishes, and its appearance on top of the estimate would give the log a jump that did not
    really happen over time. For an increment continuity matters, not the last cent.

    We recompute the estimate from the breakdown and the CURRENT price list rather than take the stored one: an increment
    is the difference of two estimates, and if one was computed at old prices and the other at new ones, a price
    change would land in the log as a fake jump in spending.
    """
    from orc.token_usage import estimate_cost_usd

    models = usage.get("models")
    fresh = estimate_cost_usd(models) if isinstance(models, dict) else None
    if fresh is not None:
        return fresh
    for key in ("cost_usd_estimated", "cost_usd"):
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return 0.0


def _seed_viewed(conn: sqlite3.Connection) -> None:
    """The "viewed" mark appeared later than the tasks themselves: without seeding, the whole "Done" archive
    would become unviewed at once: hundreds of cards the owner saw long ago.
    So everything closed earlier than the last day is considered viewed, and fresh ones
    are left as they are: that is what is worth a glance right after the update.
    """
    from orc import viewing
    from orc.util import now_iso, utc_now

    conn.execute(f"UPDATE tasks SET viewed_at = ? WHERE {viewing.STALE_UNVIEWED_SQL}",
                 (now_iso(), viewing.grace_cutoff(utc_now())))


def _routines_project_nullable(conn: sqlite3.Connection) -> None:
    """Routines outside a project appeared later: routines.project_id must accept NULL. SQLite cannot drop
    NOT NULL with ALTER TABLE, so the table is rebuilt. A database created from the current SCHEMA already
    has the nullable column and is left alone."""
    info = {row["name"]: row for row in conn.execute("PRAGMA table_info(routines)")}
    if not info or not info["project_id"]["notnull"]:
        return
    columns = ", ".join(info)
    # The plain recipe: the new table is created from the current SCHEMA text, rows are copied by name.
    # Nothing references routines by a foreign key (tasks.routine_id deliberately has none).
    conn.execute("ALTER TABLE routines RENAME TO routines_old")
    match = re.search(r"CREATE TABLE IF NOT EXISTS routines \(.*?\n\);", SCHEMA, re.DOTALL)
    conn.execute(match.group(0).replace("IF NOT EXISTS ", ""))
    # agent_id was added by ALTER, so a table made from the new SCHEMA text does not have it yet
    for name, declaration in ADD_COLUMNS["routines"].items():
        conn.execute(f"ALTER TABLE routines ADD COLUMN {name} {declaration}")
    conn.execute(f"INSERT INTO routines ({columns}) SELECT {columns} FROM routines_old")
    conn.execute("DROP TABLE routines_old")


# The block every prompt template carried while report.json told orc that work was handed in. A literal on
# purpose: it describes what is stored in old databases, whatever the default template says today.
_OLD_REPORT_BLOCK = """- As your last action, write the file {report_path} in JSON format:
  {{"status": "success" | "failed" | "needs_input", "summary": "what was done in 2-3 sentences", "notes": "what failed or what to pay attention to"}}
  Write summary and notes in the same language as the task description.
  Use status=failed if the task could not be completed. Do not write success if the tests fail.
  Use status=needs_input if you stopped for the owner's answer, decision or check, and put the question in your final message. status=success hands the work in: it goes to verification and merge right away, and nobody reads your questions first.
"""


def _template_without_report(conn: sqlite3.Connection) -> None:
    """An edited prompt template still orders the report that `orc task done` replaced. The block goes only on an
    exact match, with the old text kept beside it. A template that mentions the report in other words
    is the owner's own writing: it stays as it is, and the settings dialog warns about it."""
    from orc.util import now_iso

    row = conn.execute("SELECT value FROM settings WHERE key = 'prompt_template'").fetchone()
    if row is None or _OLD_REPORT_BLOCK not in row["value"]:
        return
    conn.execute("INSERT INTO settings (key, value) VALUES ('prompt_template_before_handoff', ?) "
                 "ON CONFLICT(key) DO NOTHING", (row["value"],))
    conn.execute("UPDATE settings SET value = ? WHERE key = 'prompt_template'",
                 (row["value"].replace(_OLD_REPORT_BLOCK, ""),))
    conn.execute("INSERT INTO events (level, message, created_at) VALUES ('info', ?, ?)",
                 ("The report block was removed from the prompt template: sessions hand in with `orc task done` now. "
                  "The old text is kept in the setting prompt_template_before_handoff.", now_iso()))


def _parents_from_creators(conn: sqlite3.Connection) -> None:
    """Subtasks appeared after cards created by agents: a card made by a session was its subtask all along. A dangling
    creator is skipped, it names no card to group under. Runs once, so a later card made with --no-parent stays apart."""
    conn.execute("UPDATE tasks SET parent_task_id = created_by_task_id "
                 "WHERE parent_task_id IS NULL AND created_by_task_id IN (SELECT id FROM tasks)")


def _drop_card_run_parameters(conn: sqlite3.Connection) -> None:
    """A card is tied to its agent and holds no model, effort or permission mode of its own. The columns stay
    (SQLite cannot drop them cheaply and an older build still reads them) but nothing reads or writes them
    any more, so stored values are cleared rather than left to look like a setting that does nothing."""
    for table in ("tasks", "routines"):
        have = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        cols = [c for c in ("model", "effort", "permission_mode") if c in have]
        if cols:
            conn.execute(f"UPDATE {table} SET " + ", ".join(f"{c} = NULL" for c in cols))


# Migrations that cannot be expressed via ADD_COLUMNS: renaming a column, changing a type,
# filling new fields from old ones. Each is a function that changes the connection;
# the order in the list is the order of application. The migration with index i (from one) raises
# the database to version i + 1.
MIGRATIONS: list[Callable[[sqlite3.Connection], None]] = [_seed_usage_ledger, _seed_viewed, _routines_project_nullable,
                                                         _template_without_report, _parents_from_creators,
                                                         _drop_card_run_parameters]

# The schema version that THIS code understands. Grows together with MIGRATIONS.
SCHEMA_VERSION = 1 + len(MIGRATIONS)


class SchemaTooNewError(RuntimeError):
    """The database was written by a newer version of orc: this code does not know its columns."""


def connect(db_path: Path | str) -> sqlite3.Connection:
    # check_same_thread=False: the connection is shared by the API thread and the dispatcher thread, access is serialized by Repo
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    # Set permissions BEFORE enabling WAL: sqlite creates -wal and -shm with the database file's permissions,
    # and after the very first PRAGMA journal_mode they are already lying next to it with 0644.
    try:
        os.chmod(db_path, 0o600)
    except OSError:
        pass  # the database is not a file (:memory:) or a foreign volume without chmod: no reason not to start
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    # busy_timeout: the connection is shared by two threads, and with concurrent writes sqlite must not
    # immediately return "database is locked": wait up to 5 seconds for it to be released
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    if current > SCHEMA_VERSION:
        raise SchemaTooNewError(
            f"the database was created by a newer version of orc (schema version {current} vs "
            f"{SCHEMA_VERSION}): update the code, otherwise some data will be lost"
        )
    conn.executescript(SCHEMA)
    for table, columns in ADD_COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, declaration in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
    conn.executescript(INDEXES)
    # Migrations run after ADD_COLUMNS: they rely on columns that already exist.
    # current == 0 for a database created before versions existed: all migrations are applied to it.
    for version, migrate in enumerate(MIGRATIONS, start=2):
        if current < version:
            migrate(conn)
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()
