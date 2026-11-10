"""Thin wrappers over git. No orchestration logic, only commands and output parsing."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

# Local git operations (merge, worktree, status) finish in seconds; 60 s is a ceiling
# for a large repository, not a working budget.
GIT_TIMEOUT_SEC = 60
# push goes over the network, so its ceiling is higher. No point hanging longer: with no answer in two
# minutes this is not a slow network but a wait we will never see the end of.
GIT_NETWORK_TIMEOUT_SEC = 120

# An interactive password prompt in a background process is an eternal wait with no sign of
# life. Better for git to fail honestly. GIT_TERMINAL_PROMPT closes the HTTPS login,
# GIT_ASKPASS/SSH_ASKPASS cover graphical prompts, and ssh BatchMode covers the key passphrase and the
# unknown-host question: ssh asks those on the terminal directly, bypassing all git variables,
# as long as the process has a tty (make start from a terminal).
GIT_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ASKPASS": "/usr/bin/true",
    "SSH_ASKPASS": "/usr/bin/true",
}
DEFAULT_SSH_COMMAND = "ssh -o BatchMode=yes"


class GitError(RuntimeError):
    pass


def _env() -> dict[str, str]:
    # Inherit the whole environment: without PATH git itself will not be found, without HOME the author config will not be.
    # The owner may have set their own ssh command (key, config): we do not overwrite it.
    env = {**os.environ, **GIT_ENV}
    env.setdefault("GIT_SSH_COMMAND", DEFAULT_SSH_COMMAND)
    return env


def _run(args: list[str], cwd: Path, timeout: float = GIT_TIMEOUT_SEC) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True,
                              timeout=timeout, env=_env())
    except subprocess.TimeoutExpired:
        raise GitError(f"git {' '.join(args)} in {cwd}: timed out after {timeout:.0f} s "
                       f"(possibly waiting for a password or hanging on the network)")


def git(args: list[str], cwd: Path, timeout: float = GIT_TIMEOUT_SEC) -> str:
    proc = _run(args, cwd, timeout)
    if proc.returncode != 0:
        raise GitError(f"git {' '.join(args)} in {cwd}: {proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout.rstrip("\n")


def main_repo_path(path: Path) -> Path | None:
    """The main working copy of the repository `path` belongs to, from any of its worktrees.
    None if this is not a repository, or a bare one."""
    try:
        proc = _run(["rev-parse", "--path-format=absolute", "--git-common-dir"], path)
    except (GitError, OSError):
        return None  # a folder that does not exist makes subprocess raise before git even runs
    common = proc.stdout.strip()
    if proc.returncode != 0 or not common.endswith("/.git"):
        return None
    return Path(common).parent


# Default branch for repositories that orc creates itself. The name is set explicitly: otherwise
# it depends on init.defaultBranch on the owner's machine, while the board shows this branch
# in task cards and merges results into it.
DEFAULT_INIT_BRANCH = "main"


def init_repo(path: Path, branch: str = DEFAULT_INIT_BRANCH) -> None:
    """Create a repository from scratch: folder, `git init` and an empty first commit.

    The commit is mandatory. In a repository without commits HEAD does not exist, and everything the
    orchestrator stands on (current branch, task worktree, merge) fails there with a cryptic error about
    "ambiguous argument HEAD": the project would look added, but the very first task in it
    would not start.
    """
    path.mkdir(parents=True, exist_ok=True)
    git(["init", "-b", branch], path)
    # The author identity may not be configured globally, and then git refuses to commit.
    # We set a fallback only in this repository and only if there is none of its own.
    if not _run(["config", "user.email"], path).stdout.strip():
        git(["config", "user.email", "orc@localhost"], path)
    if not _run(["config", "user.name"], path).stdout.strip():
        git(["config", "user.name", "orc"], path)
    git(["commit", "--allow-empty", "-m", "initial commit"], path)


def current_branch(repo: Path) -> str:
    return git(["rev-parse", "--abbrev-ref", "HEAD"], repo)


def list_branches(repo: Path) -> list[str]:
    out = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], repo)
    return [line for line in out.splitlines() if line]


# Field separator in for-each-ref: tab. It cannot occur in a branch name (git forbids
# whitespace characters in a ref), so splitting on it is safe, unlike a space.
BRANCH_FORMAT = "%(refname:short)\t%(objectname:short)\t%(committerdate:iso-strict)\t%(contents:subject)"


def list_branches_detailed(repo: Path) -> list[dict[str, str]]:
    """Branches together with the last commit: the UI uses it to show what the branch is."""
    out = git(["for-each-ref", f"--format={BRANCH_FORMAT}", "refs/heads/"], repo)
    rows: list[dict[str, str]] = []
    for line in out.splitlines():
        if not line:
            continue
        name, commit, date, subject = (line.split("\t", 3) + ["", "", ""])[:4]
        rows.append({"name": name, "commit": commit, "committed_at": date, "subject": subject})
    return rows


def create_branch(repo: Path, name: str, base: str) -> None:
    git(["branch", name, base], repo)


def rename_branch(repo: Path, old: str, new: str) -> None:
    # -m, not -M: a rename must not silently overwrite an already existing branch
    git(["branch", "-m", old, new], repo)


def is_valid_branch_name(repo: Path, name: str) -> bool:
    """Whether git will accept such a branch name. The rules are non-trivial (.., @{, ~, ^, :, spaces,
    a dot at the start of a segment), so we ask git itself instead of rewriting them as a regex."""
    if not name or name.startswith("-"):  # otherwise the name would reach git as a flag
        return False
    return _run(["check-ref-format", "--branch", name], repo).returncode == 0


def is_merged(repo: Path, branch: str, into: str) -> bool:
    """Whether all commits of branch are already in into. Exit code 1 means no, which is not a call error."""
    proc = _run(["merge-base", "--is-ancestor", branch, into], repo)
    if proc.returncode in (0, 1):
        return proc.returncode == 0
    raise GitError(f"git merge-base --is-ancestor {branch} {into}: {proc.stderr.strip()}")


def head_commit(path: Path) -> str:
    return git(["rev-parse", "HEAD"], path)


def worktrees_by_branch(repo: Path) -> dict[str, Path]:
    """Which branch is open in which working copy. Parses `git worktree list --porcelain`."""
    out = git(["worktree", "list", "--porcelain"], repo)
    result: dict[str, Path] = {}
    current: Path | None = None
    for line in out.splitlines():
        if line.startswith("worktree "):
            current = Path(line[len("worktree "):]).resolve()
        elif line.startswith("branch ") and current is not None:
            ref = line[len("branch "):]
            if ref.startswith("refs/heads/"):
                result[ref[len("refs/heads/"):]] = current
    return result


def list_worktrees(repo: Path) -> list[dict]:
    """All working copies of the repository from `git worktree list --porcelain`, including the main one.

    Porcelain entries are separated by an empty line; each has a path, HEAD and either a branch or
    detached. locked/prunable come as a flag with an optional reason after a space.
    """
    out = git(["worktree", "list", "--porcelain"], repo)
    items: list[dict] = []
    current: dict | None = None
    for line in out.splitlines():
        if line.startswith("worktree "):
            current = {"path": Path(line[len("worktree "):]).resolve(), "head": "", "branch": None,
                       "detached": False, "locked": None, "prunable": None}
            items.append(current)
        elif current is None:
            continue
        elif line.startswith("HEAD "):
            current["head"] = line[len("HEAD "):]
        elif line.startswith("branch "):
            ref = line[len("branch "):]
            current["branch"] = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
        elif line == "detached":
            current["detached"] = True
        elif line == "locked" or line.startswith("locked "):
            current["locked"] = line[len("locked "):] if line.startswith("locked ") else ""
        elif line == "prunable" or line.startswith("prunable "):
            current["prunable"] = line[len("prunable "):] if line.startswith("prunable ") else ""
    return items


def changed_files_count(path: Path) -> int:
    """How many changes are uncommitted in the working copy, including new non-ignored files."""
    out = git(["status", "--porcelain"], path)
    return len([line for line in out.splitlines() if line])


def prune_worktrees(repo: Path) -> None:
    """Forget records of working copies whose folders no longer exist on disk."""
    git(["worktree", "prune"], repo)


def worktree_for_branch(repo: Path, branch: str) -> Path | None:
    """Where the branch is currently checked out. None means nowhere."""
    return worktrees_by_branch(repo).get(branch)


def add_worktree(repo: Path, path: Path, branch: str, base: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    git(["worktree", "add", "-b", branch, str(path), base], repo)


def add_temp_worktree(repo: Path, path: Path, branch: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    git(["worktree", "add", str(path), branch], repo)


def repair_worktrees(repo: Path, paths: list[Path] | tuple[Path, ...] = ()) -> None:
    """Repair the link between a repository and its worktrees after a folder move.

    A linked worktree contains a .git file with an ABSOLUTE path to the repository's internal directory,
    and the repository itself holds a back-reference to the worktree path. After a folder move both
    links point nowhere, and git in such a copy answers "not a git repository".
    `git worktree repair` rewrites them; we pass worktree paths explicitly, otherwise
    git only fixes the back-references and does not touch .git inside the moved copies.
    """
    git(["worktree", "repair", *[str(p) for p in paths]], repo)


def remove_worktree(repo: Path, path: Path) -> None:
    git(["worktree", "remove", "--force", str(path)], repo)


def delete_branch(repo: Path, branch: str, force: bool = True) -> None:
    """force=True (the default) removes the branch together with unmerged commits: this is how
    task branches that the orchestrator created itself get cleaned up. force=False keeps git's protection."""
    git(["branch", "-D" if force else "-d", branch], repo)


def is_dirty_tracked(path: Path) -> bool:
    # Tracked files only: the user's new files do not interfere with a merge and do not go into the auto-commit
    return bool(git(["status", "--porcelain", "--untracked-files=no"], path))


def uncommitted_files(path: Path) -> tuple[list[str], list[str]]:
    """What a commit would not carry yet: changed tracked files, and untracked ones (ignored files do not count)."""
    proc = _run(["status", "--porcelain", "-z"], path)  # not git(): the status column can start with a space
    if proc.returncode != 0:
        raise GitError(f"git status in {path}: {proc.stderr.strip() or proc.stdout.strip()}")
    tracked: list[str] = []
    untracked: list[str] = []
    entries = iter(proc.stdout.split("\0"))
    for entry in entries:
        if not entry:
            continue
        code, name = entry[:2], entry[3:]
        if code == "??":
            untracked.append(name)
            continue
        tracked.append(name)
        if "R" in code or "C" in code:
            next(entries, None)  # a rename carries its old name as one more entry
    return tracked, untracked


def autocommit_tracked(path: Path, message: str) -> bool:
    if not is_dirty_tracked(path):
        return False
    git(["commit", "-am", message], path)
    return True


def has_conflict(repo: Path, target: str, branch: str) -> bool:
    """Dry-run merge check without touching the working copy. merge-tree: exit code 0 = clean, 1 = conflict."""
    proc = _run(["merge-tree", "--write-tree", target, branch], repo)
    if proc.returncode == 0:
        return False
    if proc.returncode == 1:
        return True
    raise GitError(f"git merge-tree: {proc.stderr.strip()}")


def conflict_files(repo: Path, target: str, branch: str) -> list[str]:
    """Which files conflict when merging branch into target. The working copy is not touched.

    Output format of `merge-tree --write-tree --name-only` on conflict: the first line is the oid
    of the resulting tree, then the names of conflicting files, then an empty line and
    informational messages ("CONFLICT (content): ...") that we do not need.
    """
    proc = _run(["merge-tree", "--write-tree", "--name-only", target, branch], repo)
    if proc.returncode == 0:
        return []
    if proc.returncode != 1:
        raise GitError(f"git merge-tree --name-only: {proc.stderr.strip()}")
    files: list[str] = []
    for line in proc.stdout.splitlines()[1:]:
        if not line.strip():
            break
        files.append(line)
    return files


def incoming_commits(repo: Path, target: str, branch: str, limit: int = 30) -> list[str]:
    """Commits that arrived in target after branch was forked from it."""
    out = git(["log", f"--max-count={limit}", "--format=%h %s", f"{branch}..{target}"], repo)
    return [line for line in out.splitlines() if line]


def merge_no_ff(cwd: Path, branch: str, message: str) -> None:
    git(["merge", "--no-ff", "-m", message, branch], cwd)


# Marker files of unfinished operations in the git directory of a working copy. While any of them
# is present, the copy is in the middle of a merge/rebase/cherry-pick: committing and merging in it is not allowed.
IN_PROGRESS_MARKERS = ("MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD")


def git_dir(path: Path) -> Path:
    """The git directory of THIS very working copy (a linked worktree has its own, .git/worktrees/<name>)."""
    return Path(git(["rev-parse", "--absolute-git-dir"], path))


def is_merge_in_progress(path: Path) -> bool:
    """Whether this working copy has an unfinished merge, rebase or cherry-pick."""
    gd = git_dir(path)
    return any((gd / marker).exists() for marker in IN_PROGRESS_MARKERS)


def merge_abort(path: Path) -> None:
    """Abort an unfinished merge. Safe: touches only what the merge itself brought in."""
    git(["merge", "--abort"], path)


def push(cwd: Path, branch: str) -> None:
    git(["push", "origin", branch], cwd, timeout=GIT_NETWORK_TIMEOUT_SEC)


def ensure_exclude(repo: Path, pattern: str) -> None:
    common = Path(git(["rev-parse", "--git-common-dir"], repo))
    if not common.is_absolute():
        common = (repo / common).resolve()
    exclude = common / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude.read_text().splitlines() if exclude.exists() else []
    if pattern not in existing:
        with exclude.open("a") as f:
            f.write(pattern + "\n")
