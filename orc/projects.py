"""A project and its folder: checking that the repository is in place, and moving to a new path.

The project path is the only thread by which the board holds on to the real code: branches
are computed from it, task worktrees are created in it, merging happens in it. The folder
gets moved and renamed behind the dashboard's back, and from that moment all of the above silently
breaks: git in a nonexistent directory answers with a cryptic error at every step.

Here are three answers to that:
  * `path_status`: a cheap (no git launch) check that "the folder is in place and it is a repository",
    which the dashboard asks on every poll and shows as a banner;
  * `new_path_status` / `prepare_new_path`: analysis of a path BEFORE a project is created: what exactly
    is missing (folder, git, path taken) and whether it can be set up in place;
  * `move`: switching a project to a new path together with all its data: task worktrees
    are fixed via `git worktree repair`, paths in cards are rewritten to the new root.
"""
from __future__ import annotations

from pathlib import Path

from orc import git_ops
from orc.models import Project, Task, TaskStatus
from orc.repo import Repo
from orc.util import now_iso

# The task is really running: a live session stands behind it with a working directory inside a worktree.
# Moving under such a session would leave it working in a folder that no longer exists for the dashboard.
WORKING_STATUSES = {TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING, TaskStatus.MERGING}


class ProjectPathError(RuntimeError):
    """Not allowed: the new path is unsuitable or the move would break running work."""


def path_status(path: str | Path) -> dict:
    """Whether the project folder is available. File checks only, no git launch.

    Asked on every poll of the project list, so it must be cheap:
    a couple of stat calls per project instead of a git process.
    """
    p = Path(path)
    if not p.exists():
        return {"path_ok": False, "path_error": "folder does not exist"}
    if not p.is_dir():
        return {"path_ok": False, "path_error": "not a folder"}
    if not (p / ".git").exists():
        return {"path_ok": False, "path_error": "no .git in the folder"}
    return {"path_ok": True, "path_error": None}


# What awaits a new project at the given path. The statuses are a contract with the dashboard
# (web/src/components/ProjectDialog.tsx): it uses them to decide whether to show a refusal or a fork
# "cancel / create and initialize git".
NEW_PATH_OK = "ok"              # the folder is in place and it is a git repository: add as is
NEW_PATH_MISSING = "missing"    # no folder: it can be created together with a repository
NEW_PATH_NO_GIT = "no_git"      # the folder exists, but git is not set up in it
NEW_PATH_NOT_DIR = "not_dir"    # a file lies at the path: nothing to fix
NEW_PATH_INVALID = "invalid"    # the path is not absolute
NEW_PATH_OCCUPIED = "occupied"  # another project already owns this folder


def new_path_status(raw: str, repo: Repo | None = None) -> dict:
    """Parse the path of a future project: what is there and whether it can be set up.

    Asked by the dashboard before a project is created. The point is exactly to separate
    "not allowed" (path taken, a file at the path) from "nothing yet, but we will set it up" (no folder,
    git not initialized): in the second case the person is shown a fork, not a refusal.

    Returns: path is the resolved absolute path, status is one of NEW_PATH_*,
    can_init says whether a repository can be created in this place, message is an explanation.
    """
    try:
        path = _resolved(raw)
    except ProjectPathError as e:
        return {"path": raw, "status": NEW_PATH_INVALID, "can_init": False, "message": str(e)}
    result = {"path": str(path), "status": NEW_PATH_OK, "can_init": False, "message": None}
    if repo is not None:
        occupied = repo.project_by_path(str(path))
        if occupied is not None:
            return {**result, "status": NEW_PATH_OCCUPIED, "can_init": False,
                    "message": f"this folder is already used by project «{occupied.name}»"}
    if not path.exists():
        return {**result, "status": NEW_PATH_MISSING, "can_init": True,
                "message": f"folder {path} does not exist"}
    if not path.is_dir():
        return {**result, "status": NEW_PATH_NOT_DIR, "can_init": False,
                "message": f"{path} is not a folder"}
    if not (path / ".git").exists():
        return {**result, "status": NEW_PATH_NO_GIT, "can_init": True,
                "message": f"folder {path} has no git repository"}
    return result


def prepare_new_path(raw: str, *, init_git: bool = False) -> Path:
    """Path for a new project: check it and, if allowed, set up a repository in place.

    init_git=False (the default) is the previous behavior: something is missing, so it is a refusal.
    init_git=True is a deliberate "continue" from the dashboard dialog: the missing folder is created,
    and `git init` with an empty first commit is run in it. It does not fix what cannot be fixed:
    a taken path and a file instead of a folder remain a refusal with any flag.
    """
    status = new_path_status(raw)
    path = Path(status["path"])
    if status["status"] == NEW_PATH_OK:
        return path
    if not (init_git and status["can_init"]):
        raise ProjectPathError(status["message"])
    try:
        git_ops.init_repo(path)
    except OSError as e:
        raise ProjectPathError(f"failed to create folder {path}: {e}")
    except git_ops.GitError as e:
        raise ProjectPathError(f"failed to set up a repository in {path}: {e}")
    return path


def check_available(project: Project) -> None:
    """Raise a clear error if the project cannot be worked with right now.

    Called before everything that depends on the repository (creating a task, reading branches):
    without it a git error about a nonexistent directory flies out, from which one cannot guess
    that the folder was simply moved.
    """
    if project.archived_at:
        raise ProjectPathError(f"project «{project.name}» is archived: restore it from the archive to work with it")
    status = path_status(project.path)
    if not status["path_ok"]:
        raise ProjectPathError(
            f"project folder «{project.name}» is unavailable ({status['path_error']}): {project.path}. "
            f"If the project was moved, set the new path in its settings, otherwise archive the project"
        )


def _resolved(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ProjectPathError(f"the path must be absolute, got {raw!r}")
    return path.resolve()


def _relinked(task: Task, old_root: Path, new_root: Path) -> str | None:
    """New worktree_path of a task after the root moved. None means the path is not inside the old root."""
    if not task.worktree_path:
        return None
    try:
        rel = Path(task.worktree_path).relative_to(old_root)
    except ValueError:
        return None
    return str(new_root / rel)


def move(repo: Repo, project: Project, raw_path: str) -> dict:
    """Switch the project to a new path together with all its data.

    What happens step by step:
      1. the new path is checked: absolute, exists, is a git repository, not taken
         by another project;
      2. `git worktree repair` fixes the mutual links between the repository and task worktrees; without
         this git answers "not a git repository" in a moved working copy;
      3. the worktree_path of cards is rewritten from the old root to the new one;
      4. it is checked that the branches the cards point to exist in the new repository.

    Step 4 forbids nothing: the repository may have moved with the full set of branches,
    or it may have been replaced with a fresh clone. The latter is not a reason to refuse the path change, but it is a reason
    to say honestly which cards were left without their branch.
    """
    new_root = _resolved(raw_path)
    old_root = Path(project.path)
    if new_root == old_root:
        return {"project": project, "relinked": 0, "warnings": []}
    if not new_root.exists():
        raise ProjectPathError(f"{new_root}: no such folder")
    if not (new_root / ".git").exists():
        raise ProjectPathError(f"{new_root} is not a git repository")
    occupied = repo.project_by_path(str(new_root))
    if occupied is not None and occupied.id != project.id:
        raise ProjectPathError(f"this folder is already used by project «{occupied.name}»")

    tasks = repo.list_tasks(project.id, archived=None)
    # A live session works in a worktree of the OLD root. While the old folder is in place, the session
    # is intact, and the project must not be pulled out from under it. If the old folder is already gone, there is nothing to forbid:
    # nothing can work there anyway, and the move is the only way to bring the tasks back to life.
    busy = [t for t in tasks if t.status in WORKING_STATUSES]
    if busy and old_root.exists():
        raise ProjectPathError(
            "first stop the tasks that are currently running in the old folder: "
            + ", ".join(f"#{t.id}" for t in busy)
        )

    warnings: list[str] = []
    # We fix worktrees before writing the path to the database: if git refuses, the project stays in its previous
    # (even if broken) state, not in an intermediate one.
    expected = [Path(p) for p in (_relinked(t, old_root, new_root) for t in tasks) if p]
    try:
        git_ops.repair_worktrees(new_root, [p for p in expected if p.exists()])
    except git_ops.GitError as e:
        # A repository without worktrees has nothing to fix, and that is no reason to refuse the move.
        warnings.append(f"git worktree repair failed: {e}")

    relinked = 0
    for task in tasks:
        new_wt = _relinked(task, old_root, new_root)
        if new_wt is None:
            continue
        repo.update_task(task.id, worktree_path=new_wt)
        relinked += 1
        if not Path(new_wt).exists():
            warnings.append(f"#{task.id}: working copy {new_wt} is missing at the new location")

    try:
        existing = set(git_ops.list_branches(new_root))
    except git_ops.GitError as e:
        existing = None
        warnings.append(f"branches of the new repository cannot be read: {e}")
    if existing is not None:
        if project.default_branch and project.default_branch not in existing:
            warnings.append(f"the project base branch {project.default_branch} is missing from the new repository")
        missing = sorted({t.target_branch for t in tasks
                          if t.target_branch and t.target_branch not in existing and not t.archived_at})
        if missing:
            warnings.append("target branches are missing from the new repository: " + ", ".join(missing))

    updated = repo.update_project(project.id, path=str(new_root))
    repo.add_event(f"project «{project.name}»: path changed to {new_root} "
                   f"(working copies relinked: {relinked})",
                   level="warn" if warnings else "info", project_id=project.id)
    for warning in warnings:
        repo.add_event(f"project «{project.name}»: {warning}", level="warn", project_id=project.id)
    return {"project": updated, "relinked": relinked, "warnings": warnings}


def archive(repo: Repo, project: Project) -> Project:
    """Remove a project from the dashboard. The data is intact, tasks stay in place, the dispatcher no longer takes them."""
    if project.archived_at:
        return project
    busy = [t for t in repo.list_tasks(project.id, archived=None) if t.status in WORKING_STATUSES]
    if busy:
        raise ProjectPathError(
            "first stop the tasks that are currently running: " + ", ".join(f"#{t.id}" for t in busy)
        )
    updated = repo.update_project(project.id, archived_at=now_iso())
    repo.add_event(f"project «{project.name}» archived", project_id=project.id)
    return updated


def unarchive(repo: Repo, project: Project) -> Project:
    if not project.archived_at:
        return project
    updated = repo.update_project(project.id, archived_at=None)
    repo.add_event(f"project «{project.name}» restored from the archive", project_id=project.id)
    return updated
