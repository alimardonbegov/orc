"""Shared by all routers: access to application state, input validation, serialization."""
from __future__ import annotations

import json
import re
import secrets
from dataclasses import asdict
from pathlib import Path

from fastapi import HTTPException, Request

from orc import branches, git_ops, projects, schedule
from orc.attachments import AttachmentStore
from orc.models import TaskStatus
from orc.prompt import build_conflict_prompt, build_prompt
from orc.report import REPORT_REL_PATH
from orc.util import utc_now

# Transitions that may be made by hand (drag on the board). Everything else is moved by the dispatcher.
# Allowed: backlog <-> todo, failed -> todo (manual retry), done -> backlog (return
# to work). Removing a card from the board is not a move but archive/DELETE (see below).
MANUAL_MOVES = {
    (TaskStatus.BACKLOG, TaskStatus.TODO),
    (TaskStatus.TODO, TaskStatus.BACKLOG),
    (TaskStatus.FAILED, TaskStatus.TODO),
    (TaskStatus.DONE, TaskStatus.BACKLOG),
}
# Emergency exit to done: a card stuck in in_progress/verifying/merging, or
# a task that did not make it (failed), may be closed by hand. Separate from
# MANUAL_MOVES because this is not an ordinary move: the task goes to done bypassing verification and
# merge (and from working statuses also stops the session). So such a transition requires
# an explicit force=true: the UI asks for confirmation first.
FORCE_MOVES = {(status, TaskStatus.DONE)
               for status in (TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING, TaskStatus.MERGING, TaskStatus.FAILED)}
PERMISSION_MODES = {"auto", "acceptEdits", "dontAsk", "bypassPermissions"}
SETTING_KEYS = {"global_max_workers", "prompt_template", "quota_patterns", "poll_interval_sec",
                "conflict_autoresolve", "conflict_prompt_template", "verify_workers",
                "events_retention_days", "attachments_max_total_mb",
                "worktree_autoclean", "worktree_retention_days", "hidden_models", "session_reaper",
                "start_max_load_pct", "start_min_free_mem_pct"}
# The target branch can be changed only while the task is not running: the worktree is created from one base,
# and swapping the branch on in_progress/verifying/merging sends the merge to the wrong place.
TARGET_BRANCH_EDITABLE = {TaskStatus.BACKLOG, TaskStatus.TODO, TaskStatus.FAILED}
# The start schedule can be changed until the task has started (same set as for the base branch):
# for a failed one it is set to "retry overnight"; retry does not touch the schedule.
SCHEDULE_EDITABLE = {TaskStatus.BACKLOG, TaskStatus.TODO, TaskStatus.FAILED}
WINDOW_CLOSED_ERROR = "the start window has already passed: set a new time or remove the schedule"
SLICE2 = "not supported yet"


def _repo(request: Request):
    return request.app.state.repo


def _dispatcher(request: Request):
    return request.app.state.dispatcher


def _attachments(request: Request) -> AttachmentStore:
    # Take the storage from the dispatcher rather than building our own: the directory must be exactly the one
    # the dispatcher later uses to expand paths into the prompt.
    return request.app.state.dispatcher.attachments


def _check_mode(mode: str | None) -> None:
    if mode is not None and mode not in PERMISSION_MODES:
        raise HTTPException(400, f"permission mode must be one of {sorted(PERMISSION_MODES)}")


def _check_int_setting(key: str, raw: str, minimum: int, maximum: int | None = None) -> None:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(400, f"setting {key}: an integer is required, got {raw!r}")
    if value < minimum:
        raise HTTPException(400, f"setting {key}: minimum is {minimum}, got {value}")
    if maximum is not None and value > maximum:
        raise HTTPException(400, f"setting {key}: maximum is {maximum}, got {value}")


def _check_quota_patterns(raw: str) -> None:
    try:
        patterns = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"setting quota_patterns: a JSON list of strings is expected ({e})")
    if not isinstance(patterns, list) or not all(isinstance(p, str) for p in patterns):
        raise HTTPException(400, "setting quota_patterns: a JSON list of strings is expected")
    for pattern in patterns:
        # An invalid regex breaks _sync_running on EVERY task on every tick
        try:
            re.compile(pattern)
        except re.error as e:
            raise HTTPException(400, f"setting quota_patterns: regex {pattern!r} does not compile ({e})")


# {title.__class__} is evaluated in format_map: the secrets cannot be reached (the namespace holds only
# strings, and format does not allow calls), but attributes and indexes have no business in a prompt template.
PLACEHOLDER_ATTR_RE = re.compile(r"\{[A-Za-z_][A-Za-z0-9_]*[.\[]")


def _check_placeholders(key: str, raw: str, allowed: str) -> None:
    if PLACEHOLDER_ATTR_RE.search(raw):
        raise HTTPException(400, f"setting {key}: placeholders must not access attributes "
                                 f"or elements, only {allowed}")


def _check_prompt_template(raw: str) -> None:
    _check_placeholders("prompt_template", raw,
                        "{title}, {description}, {branch}, {target_branch}, {verify_cmd}, {report_path}")
    # A broken curly brace in the template breaks _start of every task: run it through the same
    # build_prompt with dummy values as the dispatcher
    try:
        build_prompt(raw, title="t", description="d", branch="b", target_branch="tb",
                     verify_cmd="c", report_path=REPORT_REL_PATH)
    except Exception as e:
        raise HTTPException(400, f"setting prompt_template: the template does not expand ({e})")


def _check_conflict_prompt_template(raw: str) -> None:
    _check_placeholders("conflict_prompt_template", raw,
                        "{title}, {description}, {branch}, {target_branch}, {verify_cmd}, "
                        "{report_path}, {files}, {incoming}, {untrusted_note}")
    try:
        build_conflict_prompt(raw, title="t", description="d", branch="b", target_branch="tb",
                              verify_cmd="c", report_path=REPORT_REL_PATH, files=["f"], incoming=["c"])
    except Exception as e:
        raise HTTPException(400, f"setting conflict_prompt_template: the template does not expand ({e})")


def normalize_hidden_models(models: list[str]) -> list[str]:
    """List of hidden models without empty strings and duplicates, in the original order.

    This is only visibility in the dashboard dropdowns: the dispatcher ignores the list, and a task
    that already has a model assigned runs with it as before, even if the model was hidden.
    """
    seen: list[str] = []
    for model in models:
        model = model.strip()
        if model and model not in seen:
            seen.append(model)
    return seen


def _parse_hidden_models(key: str, raw: str) -> list[str]:
    try:
        models = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"setting {key}: a JSON list of model ids is expected ({e})")
    if not isinstance(models, list) or not all(isinstance(m, str) for m in models):
        raise HTTPException(400, f"setting {key}: a JSON list of model ids is expected")
    return models


def hidden_models_json(models: list[str] | None) -> str | None:
    """The projects.hidden_models column: None stays None, meaning "no list of its own, same as in orc"."""
    # Compact, like JSON.stringify in the dashboard: otherwise the "has it changed" comparison in the settings window
    # would see a difference in whitespace where the list is the same
    return None if models is None else json.dumps(normalize_hidden_models(models), separators=(",", ":"))


def _hidden_models_out(raw: str | None) -> list[str] | None:
    """Outwards as a list already. A broken value (hand-edited database) reads as "none of its own":
    the whole project list must not fail because of it."""
    if raw is None:
        return None
    try:
        models = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(models, list):
        return None
    return normalize_hidden_models([m for m in models if isinstance(m, str)])


def _check_flag(key: str, raw: str) -> None:
    if raw not in ("0", "1"):
        raise HTTPException(400, f"setting {key}: expected \"0\" or \"1\", got {raw!r}")


def _check_settings(body: dict[str, str]) -> None:
    for key, value in body.items():
        if key == "global_max_workers":
            _check_int_setting(key, value, minimum=1)
        elif key == "poll_interval_sec":
            _check_int_setting(key, value, minimum=5)
        elif key == "quota_patterns":
            _check_quota_patterns(value)
        elif key == "prompt_template":
            _check_prompt_template(value)
        elif key == "conflict_prompt_template":
            _check_conflict_prompt_template(value)
        elif key in ("conflict_autoresolve", "worktree_autoclean", "session_reaper"):
            _check_flag(key, value)
        elif key == "verify_workers":
            _check_int_setting(key, value, minimum=1)
        elif key == "start_min_free_mem_pct":
            # Free memory percentage: a value above 100 can never be satisfied and would forbid starts forever
            _check_int_setting(key, value, minimum=0, maximum=100)
        elif key in ("events_retention_days", "worktree_retention_days", "start_max_load_pct"):
            _check_int_setting(key, value, minimum=0)
        elif key == "attachments_max_total_mb":
            _check_int_setting(key, value, minimum=1)
        elif key == "hidden_models":
            _parse_hidden_models(key, value)


def _check_branch_exists(repo_path: Path | str, branch: str | None) -> None:
    """The target branch may not exist: it was deleted by hand or mistyped in the request.
    We catch it here, otherwise the task would reach the dispatcher and fail on `git worktree add`."""
    if branch is None:
        return
    try:
        existing = git_ops.list_branches(Path(repo_path))
    except git_ops.GitError as e:
        raise HTTPException(400, f"cannot read the project branches: {e}")
    if branch not in existing:
        raise HTTPException(400, f"branch {branch} does not exist in the repository")


# The text a person sees when trying to send an empty card to work.
# One for all entry points (drag, the "Start" button, "Redo"): the wording must be
# the same wherever the request comes from.
EMPTY_DESCRIPTION_ERROR = (
    "the task description is empty, and the description is exactly what the agent receives: the title "
    "alone is not a task. Write the description and send the card again"
)


def _check_description_for_work(description: str | None) -> None:
    """The worker prompt gets the task description (see prompt.DEFAULT_TEMPLATE): an empty one
    means a session without a task statement, which would burn the limits and invent work on its own.
    So an empty card is not let into work, neither by hand nor by retry."""
    if not (description or "").strip():
        raise HTTPException(400, EMPTY_DESCRIPTION_ERROR)


def _check_window_open(start_before: str | None) -> None:
    """A card with an expired window is not let into todo: on the nearest tick the dispatcher would quietly return
    it to the backlog, and the move would look like a board failure."""
    if schedule.window_closed(start_before, utc_now()):
        raise HTTPException(400, WINDOW_CLOSED_ERROR)


def _branch_op(action) -> dict:
    """Common wrapper for branch operations: a prohibition is 400, "confirm" is 409."""
    try:
        view, note = action()
    except branches.BranchNeedsConfirm as e:
        raise HTTPException(409, str(e))
    except branches.BranchError as e:
        raise HTTPException(400, str(e))
    except git_ops.GitError as e:
        raise HTTPException(400, str(e))
    return {**view, "note": note}


def _check_deps(repo, depends_on: list[int], task_id: int | None = None) -> None:
    """Dependencies exist and do not close into a ring. task_id=None means the task is still being created.

    A cycle in dependencies is not broken by the dispatcher but honestly executed: no task of the ring
    will ever become done, so none will become ready. For the owner this is a board
    frozen dead without a single message, so we do not let a ring be built at all.
    """
    # task_deps.depends_on_id is a foreign key to tasks(id) with PRAGMA foreign_keys on:
    # without this check, inserting a nonexistent id throws sqlite3.IntegrityError out as a 500.
    for dep_id in depends_on:
        if repo.get_task(dep_id) is None:
            raise HTTPException(400, f"dependency: task #{dep_id} does not exist")
    if task_id is None:  # a new task has no id yet, so nothing can refer to it: no ring is possible
        return
    if task_id in depends_on:
        raise HTTPException(400, "dependency: a task cannot depend on itself")
    # Walk up the future graph: if there is a path from the blockers back to the task, it is a ring
    deps = {**repo.all_deps(), task_id: depends_on}
    seen: set[int] = set()
    stack = list(depends_on)
    while stack:
        current = stack.pop()
        if current == task_id:
            raise HTTPException(400, f"dependency: this would create a cycle: task #{task_id} already "
                                     f"blocks one of the chosen blockers")
        if current in seen:
            continue
        seen.add(current)
        stack.extend(deps.get(current, []))


# How to return the archive in the project list. The default is hide, as with tasks: a client that knows
# nothing about the archive keeps getting only active projects. The dashboard asks for all and
# sorts it out itself, otherwise the "Archive" toggle would cost a second poll.
PROJECT_ARCHIVED_FILTERS = {"hide": False, "only": True, "all": None}


def _project_out(project) -> dict:
    """A project card plus the availability of its folder.

    path_ok comes in the same response as the project itself, on purpose: the "project folder
    is missing" banner must be shown by the dashboard right on the list poll, without requesting anything else.
    The check is file-based (see orc/projects.py), so there is no extra git process here.
    """
    return {**asdict(project), "hidden_models": _hidden_models_out(project.hidden_models),
            **projects.path_status(project.path)}


def _project_or_404(request: Request, project_id: int):
    project = _repo(request).get_project(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    return project


def _working_project(request: Request, project_id: int):
    """A project whose repository can be worked with right now.

    Project folders get moved and renamed behind the dashboard's back. Without this check a git
    error about a nonexistent directory would fly out, and it gives no clue
    what to fix. Here it says right away: specify a new path or archive the project.
    """
    project = _project_or_404(request, project_id)
    try:
        projects.check_available(project)
    except projects.ProjectPathError as e:
        raise HTTPException(409, str(e))
    return project


def _check_hook_secret(request: Request, task_id: int) -> None:
    """A hook presents the secret of its task.

    The secret is issued together with the session. A task without a secret (NULL: not yet issued or reset)
    is unavailable to the hook: the permission channel is open only to the session the secret was issued to.
    """
    task = _repo(request).get_task(task_id)
    if task is None:
        return  # the endpoint will answer 409/404 itself: the hook yields to the Claude Code dialog
    expected = task.hook_secret
    if not expected:
        raise HTTPException(403, "the task has no hook secret: it is issued together with the session")
    got = request.headers.get("x-orc-hook") or ""
    # compare_digest, not ==: comparing secrets must not depend on timing
    if not secrets.compare_digest(got.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(403, "wrong hook secret: the request did not come from this task's session")


# Task fields that must not go outwards. A list, not "delete hook_secret":
# the next such field must land here too, rather than slip in around it.
PRIVATE_TASK_FIELDS = {"hook_secret"}


def _task_out(task) -> dict:
    return {k: v for k, v in asdict(task).items() if k not in PRIVATE_TASK_FIELDS}


def _input_request_view(row: dict | None) -> dict | None:
    """An input request outwards: tool_input and decision as parsed objects, not JSON strings."""
    if row is None:
        return None
    view = dict(row)
    for key in ("tool_input", "decision"):
        try:
            view[key] = json.loads(row[key]) if row.get(key) else None
        except ValueError:
            view[key] = None
    return view


def _task_detail(repo, task) -> dict:
    return {**_task_out(task), "depends_on": repo.deps_of(task.id), "started_at": repo.first_session_time(task.id),
            "comments": repo.list_comments(task.id),
            "outbox": repo.pending_messages(task.id),
            "input_request": _input_request_view(repo.open_input_request(task.id))}


# How to return the archive in the task list. The default is hide: an old client that knows nothing
# about the archive keeps getting exactly the board. The dashboard requests all and sorts it out itself,
# otherwise the "Archive" toggle would cost a second server poll.
ARCHIVED_FILTERS = {"hide": False, "only": True, "all": None}
