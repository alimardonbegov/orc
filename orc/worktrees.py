"""Working copies in a project's .claude/worktrees: an overview for the UI, deletion and auto-cleanup.

A task worktree is deliberately not deleted after the merge: "Rework" relies on it, resuming
the same session in the same folder (Dispatcher.rework). The price is a repository copy (often
with node_modules and builds) for every task ever started, gigabytes per month.
Everything is gathered here to see this price and pay it consciously: what the copy is, whose it is,
how much it weighs, whether its work is merged, whether anything is uncommitted and whether someone is working in it right now.

The rules are the same as for branches (orc/branches.py):
  * a prohibition (WorktreeError): the deletion would interrupt work in progress, and confirmation does not override it;
  * a warning (WorktreeNeedsConfirm): something can be lost, but the human decides.

Folders in .claude/worktrees are created not only by the orchestrator: worktrees of Claude Code
sessions opened by hand live there too. So foreign copies are shown as well, but with a warning.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from orc import branches, git_ops, trust
from orc.models import Project, Task, TaskStatus

log = logging.getLogger("orc.worktrees")

WORKTREES_REL = Path(".claude") / "worktrees"
TASK_DIR_RE = re.compile(r"^orc-task-(\d+)$")
MERGE_DIR_RE = re.compile(r"^orc-merge-(\d+)$")

# du takes seconds to size a gigabyte-scale folder with node_modules; more than a minute is no longer
# a slow disk but a hung network filesystem, and the overview must not be held up by it.
SIZE_TIMEOUT_SEC = 60
# lsof walks all of the user's processes; on a Mac that takes a fraction of a second, the ceiling is just in case.
LSOF_TIMEOUT_SEC = 10
# Per-copy checks (du, git status, merge-base) are independent, so we run them in parallel,
# but without fanaticism: the disk is shared, and ten du runs at once only get in each other's way.
PROBE_WORKERS = 4


class WorktreeError(RuntimeError):
    """Not allowed: the deletion would interrupt work in progress."""


class WorktreeNeedsConfirm(RuntimeError):
    """Allowed, but something will be lost: an explicit force from the human is required."""


def root(project: Project) -> Path:
    return Path(project.path) / WORKTREES_REL


def _enum(ids: list[int]) -> str:
    return ", ".join(f"#{i}" for i in ids)


# ---------- measurements ----------

def dir_size(path: Path) -> int | None:
    """How much disk space the folder takes, in bytes. None means it could not be computed.

    du rather than a Python walk: a copy with node_modules has hundreds of thousands of files, and du
    handles them several times faster. -k is the same in BSD (Mac) and GNU (container) du.
    """
    try:
        proc = subprocess.run(["du", "-sk", str(path)], capture_output=True, text=True,
                              timeout=SIZE_TIMEOUT_SEC)
        # du exits with code 1 on partial success too (no permissions on a couple of subfolders): the number
        # is still in the output and almost exact, so showing it is better than nothing.
        first = proc.stdout.split()
        if first:
            return int(first[0]) * 1024
    except (OSError, ValueError, subprocess.TimeoutExpired):
        log.warning("du %s failed", path, exc_info=True)
    return _walk_size(path)


def _walk_size(path: Path) -> int | None:
    """Fallback size count if du is missing (a stripped-down container) or failed."""
    total = 0
    try:
        for dirpath, _dirs, files in os.walk(path):
            for name in files:
                try:
                    st = os.lstat(os.path.join(dirpath, name))
                except OSError:
                    continue
                total += getattr(st, "st_blocks", 0) * 512 or st.st_size
    except OSError:
        return None
    return total


def cwd_processes() -> dict[Path, list[dict]] | None:
    """Processes and their working folders: they show that someone is using a copy right now.

    A Claude Code session running in a worktree, a terminal open in it or a dev server are
    all processes with cwd inside the folder. None means there is no way to find out (no lsof, for example in a
    container): then the UI honestly says "unknown" rather than "not in use".
    """
    try:
        proc = subprocess.Popen(["lsof", "-w", "-d", "cwd", "-F", "pcn"], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True)
    except OSError:
        return None
    try:
        out, _ = proc.communicate(timeout=LSOF_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        return None
    if proc.returncode not in (0, 1) or not out:
        return None
    # The server itself and the just-started lsof are not "users" of the copy
    skip = {os.getpid(), proc.pid}
    result: dict[Path, list[dict]] = {}
    pid, name = None, ""
    for line in out.splitlines():
        tag, value = line[:1], line[1:]
        if tag == "p":
            pid, name = int(value) if value.isdigit() else None, ""
        elif tag == "c":
            name = _process_name(value)
        elif tag == "n" and pid is not None and pid not in skip:
            result.setdefault(Path(value), []).append({"pid": pid, "name": name})
    return result


# Native Claude Code lives in a file named after its version (~/.local/share/claude/versions/2.1.x),
# and lsof shows the process as "2.1.285". That means nothing to a human.
VERSION_NAME_RE = re.compile(r"^\d+\.\d+\.\d+$")


def _process_name(raw: str) -> str:
    return "claude" if VERSION_NAME_RE.match(raw) else raw


def processes_in(path: Path, table: dict[Path, list[dict]] | None) -> list[dict] | None:
    """Processes whose working folder is this copy or something inside it."""
    if table is None:
        return None
    found: list[dict] = []
    for cwd, procs in table.items():
        if cwd == path or path in cwd.parents:
            found.extend(procs)
    return sorted(found, key=lambda p: p["pid"])


def _last_activity(path: Path) -> str | None:
    """When git last did something in the copy: the index is rewritten by any add/commit/checkout.

    The service directory of a linked worktree lives in the main repository, and in the copy itself
    there is a .git file with a "gitdir: ..." link to it.
    """
    candidates: list[Path] = []
    dotgit = path / ".git"
    try:
        if dotgit.is_file():
            text = dotgit.read_text().strip()
            if text.startswith("gitdir:"):
                gitdir = Path(text[len("gitdir:"):].strip())
                candidates += [gitdir / "index", gitdir / "HEAD", gitdir / "logs" / "HEAD"]
        candidates.append(path)
        stamps = [p.stat().st_mtime for p in candidates if p.exists()]
    except OSError:
        return None
    if not stamps:
        return None
    return datetime.fromtimestamp(max(stamps), tz=timezone.utc).replace(microsecond=0).isoformat()


# ---------- overview ----------

@dataclass
class _Entry:
    """Raw data about one copy before measurements: what the folder is and whose it is."""
    name: str
    path: Path
    git: dict | None  # entry from `git worktree list`; None means git does not know the folder
    kind: str  # task | merge | foreign
    task_id: int | None
    task: Task | None


def _entries(project: Project, tasks: list[Task]) -> list[_Entry]:
    base = root(project).resolve()
    by_id = {t.id: t for t in tasks}
    registered = {}
    for wt in git_ops.list_worktrees(Path(project.path)):
        if wt["path"].parent == base:
            registered[wt["path"].name] = wt
    names = set(registered)
    if base.is_dir():
        names |= {p.name for p in base.iterdir() if p.is_dir()}
    entries: list[_Entry] = []
    for name in sorted(names):
        task_match, merge_match = TASK_DIR_RE.match(name), MERGE_DIR_RE.match(name)
        task_id = int((task_match or merge_match).group(1)) if (task_match or merge_match) else None
        kind = "task" if task_match else "merge" if merge_match else "foreign"
        entries.append(_Entry(name=name, path=base / name, git=registered.get(name), kind=kind,
                              task_id=task_id, task=by_id.get(task_id) if task_id is not None else None))
    return entries


def _merged(project_path: Path, entry: _Entry, base: str) -> tuple[bool | None, str | None]:
    """Whether the copy's work is merged and what it was compared against. None means unknown or nothing to compare."""
    wt = entry.git
    if wt is None or entry.kind == "merge":
        return None, None  # a temporary merge copy sits on the target branch itself: the question is moot
    target = (entry.task.target_branch if entry.task and entry.task.target_branch else None) or base
    ref = wt["branch"] or wt["head"]
    if not ref:
        return None, target
    if ref == target:
        return True, target
    try:
        return git_ops.is_merged(project_path, ref, target), target
    except git_ops.GitError:
        return None, target  # the target branch is missing or ref is broken: do not scare with an imaginary loss


def _probe(project_path: Path, entry: _Entry, base: str, sizes: bool) -> dict:
    exists = entry.path.is_dir()
    merged, target = _merged(project_path, entry, base) if exists else (None, None)
    dirty: int | None = None
    if exists and entry.git is not None:
        try:
            dirty = git_ops.changed_files_count(entry.path)
        except git_ops.GitError:
            dirty = None
    return {
        "exists": exists,
        "merged": merged,
        "target": target,
        "dirty": dirty,
        "size_bytes": (dir_size(entry.path) if sizes else None) if exists else 0,
        "last_activity": _last_activity(entry.path) if exists else None,
    }


def _describe(entry: _Entry, probe: dict, procs: list[dict] | None) -> dict:
    """One copy with everything the UI needs to know about it, including prohibitions and warnings."""
    task, wt = entry.task, entry.git
    branch = wt["branch"] if wt else None

    # The reasons go from the most insurmountable to the most specific: the human reads the first one.
    # busy means the orchestrator itself is using the copy: the task's work is running or about to resume.
    block: str | None = None
    busy = True
    if entry.kind == "task" and task is not None and task.status in branches.BUSY_STATUSES:
        block = f"a task is working in it right now: #{task.id} ({task.status})"
    elif entry.kind == "task" and task is not None and task.status == TaskStatus.TODO and task.resume_with:
        block = f"task #{task.id} is waiting in the rework queue: the session will continue in exactly this folder"
    elif entry.kind == "merge" and task is not None and task.status == TaskStatus.MERGING:
        block = f"it is in use by the merge of task #{task.id}"
    else:
        busy = False
    if block is None and wt is not None and wt["locked"] is not None:
        reason = f" ({wt['locked']})" if wt["locked"] else ""
        block = f"the copy is locked by git worktree lock{reason}: remove the lock manually"

    warnings: list[str] = []
    if procs:
        names = ", ".join(f"{p['name'] or '?'} ({p['pid']})" for p in procs[:5])
        more = f", other processes: {len(procs) - 5}" if len(procs) > 5 else ""
        warnings.append(f"processes are running in the folder: {names}{more}")
    if probe["dirty"]:
        warnings.append(f"uncommitted changes: {probe['dirty']} (they will be lost)")
    if probe["merged"] is False:
        if branch:
            warnings.append(f"branch {branch} is not merged into {probe['target']} (the branch will be kept, "
                            f"only the folder will be deleted)")
        else:
            warnings.append(f"commits without a branch (detached HEAD) are not merged into {probe['target']} and will be lost")
    if entry.kind == "foreign":
        warnings.append("this is not an orchestrator task: the copy may have been opened by you or by a Claude Code session")
    if entry.kind == "task" and task is not None and task.session_id:
        if task.status == TaskStatus.DONE:
            warnings.append(f"\"Rework\" for #{task.id} will become unavailable: there will be nowhere to continue the session")
        elif task.status == TaskStatus.FAILED:
            warnings.append(f"\"Resume session\" for #{task.id} will become unavailable, only \"Retry\" from scratch will remain")
    if probe["exists"] and wt is None:
        warnings.append("git does not know this folder: it will be deleted as a plain directory")

    in_use = busy or bool(procs)
    # "Safe" is what the "Remove merged" button will remove: the work is entirely in the base, nothing
    # is uncommitted, nobody is in the folder, and it is an orchestrator copy, not someone else's.
    safe = (block is None and entry.kind in ("task", "merge") and not procs and not probe["dirty"]
            and (probe["merged"] is True or entry.kind == "merge" or not probe["exists"]))
    return {
        "name": entry.name,
        "path": str(entry.path),
        "kind": entry.kind,
        "branch": branch,
        "head": (wt["head"][:7] if wt and wt["head"] else None),
        "registered": wt is not None,
        "exists": probe["exists"],
        "locked": wt["locked"] is not None if wt else False,
        "task_id": entry.task_id,
        "task_title": task.title if task else None,
        "task_status": task.status if task else None,
        "task_archived": bool(task and task.archived_at),
        "task_done_at": task.done_at if task else None,
        "size_bytes": probe["size_bytes"],
        "merged": probe["merged"],
        "target": probe["target"],
        "dirty": probe["dirty"],
        "processes": procs,
        "last_activity": probe["last_activity"],
        "busy": busy,
        "in_use": in_use,
        "safe": safe,
        "delete_block": block,
        "delete_warnings": warnings,
    }


def overview(store, project: Project, sizes: bool = True) -> dict:
    """All copies of a project in one response. sizes=False skips du: deletion does not need the weight."""
    path = Path(project.path)
    base = branches.base_branch(project, git_ops.current_branch(path))
    # archived=None: an archived card is not visible on the board, but its copy takes up disk space
    tasks = store.list_tasks(project.id, archived=None)
    entries = _entries(project, tasks)
    procs = cwd_processes() if entries else None
    with ThreadPoolExecutor(max_workers=PROBE_WORKERS) as pool:
        probes = list(pool.map(lambda e: _probe(path, e, base, sizes), entries))
    items = [_describe(e, p, processes_in(e.path, procs)) for e, p in zip(entries, probes)]
    return {
        "root": str(root(project)),
        "base": base,
        "processes_known": procs is not None,
        "total_bytes": sum(i["size_bytes"] or 0 for i in items),
        "items": items,
    }


# ---------- deletion ----------

def _remove(project: Project, item: dict, claude_json_path: Path | None) -> str | None:
    """Remove one copy. Returns the name of the deleted task branch if it was removed too."""
    repo_path, path = Path(project.path), Path(item["path"])
    if item["registered"] and item["exists"]:
        try:
            git_ops.remove_worktree(repo_path, path)
        except git_ops.GitError:
            # git refused (a broken .git inside, foreign permissions on a subfolder): we remove the folder
            # anyway, and git will forget the orphaned entry about it in the prune below.
            log.warning("git worktree remove %s failed, deleting as a directory", path, exc_info=True)
            shutil.rmtree(path)
    elif item["exists"]:
        shutil.rmtree(path)
    if item["registered"]:
        git_ops.prune_worktrees(repo_path)
    if claude_json_path is not None:
        try:
            # A trust entry for a removed folder is garbage in ~/.claude.json (orc/trust.py)
            trust.revoke(claude_json_path, path)
        except Exception:
            log.warning("could not remove trust for %s", path, exc_info=True)
    # We delete the task branch only if its work is entirely in the base: then it is an empty label.
    # An unmerged one is kept: it holds commits that exist nowhere else.
    branch = item["branch"]
    if (item["kind"] == "task" and item["task_id"] is not None and branch == f"orc/task-{item['task_id']}"
            and item["merged"] is True):
        try:
            git_ops.delete_branch(repo_path, branch)
            return branch
        except git_ops.GitError:
            log.warning("could not delete branch %s", branch, exc_info=True)
    return None


def delete(store, project: Project, names: list[str], force: bool = False,
           claude_json_path: Path | None = None) -> str:
    """Delete copies by name and return the outcome as text. Prohibitions are not bypassed; warnings
    are lifted by force=True.

    In a batch, blocked copies are skipped with an explanation rather than failing the whole operation:
    "delete all" must not get stuck on a single running task.
    """
    names = list(dict.fromkeys(n for n in names if n))
    if not names:
        raise WorktreeError("no worktrees selected")
    view = overview(store, project, sizes=False)
    by_name = {i["name"]: i for i in view["items"]}
    missing = [n for n in names if n not in by_name]
    if missing:
        raise WorktreeError(f"worktrees {', '.join(missing)} not found in {view['root']}.")
    chosen = [by_name[n] for n in names]
    blocked = [i for i in chosen if i["delete_block"]]
    allowed = [i for i in chosen if not i["delete_block"]]
    if not allowed:
        raise WorktreeError("; ".join(f"{i['name']}: {i['delete_block']}" for i in blocked))
    warned = [i for i in allowed if i["delete_warnings"]]
    if warned and not force:
        raise WorktreeNeedsConfirm("; ".join(f"{i['name']}: {', '.join(i['delete_warnings'])}" for i in warned))

    removed: list[str] = []
    dropped_branches: list[str] = []
    failed: list[str] = []
    for item in allowed:
        try:
            branch = _remove(project, item, claude_json_path)
        except Exception as e:
            log.exception("deleting worktree %s", item["path"])
            failed.append(f"{item['name']}: {e}")
            continue
        removed.append(item["name"])
        if branch:
            dropped_branches.append(branch)

    notes: list[str] = []
    if removed:
        notes.append(f"deleted: {', '.join(removed)}")
    if dropped_branches:
        notes.append(f"branches of merged tasks removed: {', '.join(dropped_branches)}")
    if blocked:
        notes.append("skipped: " + "; ".join(f"{i['name']} — {i['delete_block']}" for i in blocked))
    if failed:
        notes.append("failed: " + "; ".join(failed))
    if not removed:
        raise WorktreeError("; ".join(notes))
    return "; ".join(notes)


# ---------- auto-cleanup ----------

def _parse_iso(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        at = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def autoclean(store, project: Project, now: datetime, days: int,
              claude_json_path: Path | None = None) -> list[dict]:
    """Remove copies of tasks merged more than `days` days ago. Returns the removed ones.

    It takes only what loses nothing: the task is done, its branch is fully merged into the target,
    the copy has nothing uncommitted and nobody is in the folder. Everything else is left for a manual
    decision in the "Worktrees" dialog, where you can see what you risk.
    """
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    cutoff = now - timedelta(days=days)
    due = set()
    for task in store.list_tasks(project.id, archived=None):
        done_at = _parse_iso(task.done_at)
        if task.status != TaskStatus.DONE or done_at is None or done_at > cutoff:
            continue
        if task.worktree_path and Path(task.worktree_path).is_dir():
            due.add(Path(task.worktree_path).name)
    if not due:
        return []
    view = overview(store, project, sizes=False)
    removed: list[dict] = []
    for item in view["items"]:
        if item["name"] not in due or item["kind"] != "task" or not item["safe"]:
            continue
        # An unknown process list (no lsof) is no reason to hoard gigabytes forever: the task
        # was merged long ago, it is clean, and there is no orchestrator session in it (otherwise there would be a block).
        try:
            branch = _remove(project, item, claude_json_path)
        except Exception:
            log.exception("auto-cleanup of worktree %s", item["path"])
            continue
        removed.append({**item, "dropped_branch": branch})
    return removed
