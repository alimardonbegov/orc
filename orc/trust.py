"""Claude Code trust in working folders (`hasTrustDialogAccepted` in ~/.claude.json).

Since version 2.1.281 `claude --bg` looks for trust only up to the git root: from cwd upward, but
not above the folder that contains `.git`. In a task worktree `.git` is a file, so the root is the
worktree itself, and trust in the project folder or its parent no longer reaches it: the start
fails with "Workspace not trusted. Run `claude` in … once and accept the trust prompt".

So the orchestrator trusts the worktrees of its tasks itself, but only if the owner has already
trusted the project under the previous rules (the project folder itself or any parent). Nobody
but the owner can trust an untrusted project: the dashboard has an explicit button for that.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

TRUST_KEY = "hasTrustDialogAccepted"
# This is how the CLI reports an untrusted folder (claude --bg, 2.1.281)
CLI_UNTRUSTED_MARKER = "Workspace not trusted"
# Claude Code rewrites the file entirely: JSON caught half-written is a reason to re-read
READ_ATTEMPTS = 5
READ_RETRY_SEC = 0.05


class WorkspaceUntrusted(RuntimeError):
    """Claude Code does not trust the project folder: a session cannot be started in it without the owner."""

    def __init__(self, path: Path | str):
        self.path = str(path)
        super().__init__(
            f"Claude Code does not trust the project folder {self.path}. "
            f"Open the task and press \"Trust folder and start\"."
        )


def canonical(path: Path | str) -> str:
    """The entry key as Claude Code writes it: an absolute path without symlinks."""
    return os.path.realpath(os.path.expanduser(str(path)))


def _read(config_path: Path) -> dict:
    if not config_path.exists():
        return {}
    last: Exception | None = None
    for attempt in range(READ_ATTEMPTS):
        try:
            data = json.loads(config_path.read_text())
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError as e:
            last = e
            time.sleep(READ_RETRY_SEC * (attempt + 1))
    raise RuntimeError(f"{config_path} cannot be read as JSON: {last}")


def _write(config_path: Path, data: dict) -> None:
    """Atomic write: a temporary file next to it, then rename. Permissions are the same as the original (0600)."""
    mode = config_path.stat().st_mode & 0o777 if config_path.exists() else 0o600
    fd, tmp = tempfile.mkstemp(prefix=config_path.name + ".orc-", dir=str(config_path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.chmod(tmp, mode)
        os.replace(tmp, config_path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _accepted(projects: dict, key: str) -> bool:
    entry = projects.get(key)
    return isinstance(entry, dict) and entry.get(TRUST_KEY) is True


def is_trusted(config_path: Path, path: Path | str) -> bool:
    """Whether the folder is trusted under the previous rules: itself or any parent.

    The home directory and the disk root do not count: the new CLI keeps trust in them for a
    single session only, and extending it to all projects would be more generous than Claude Code itself.
    """
    projects = _read(config_path).get("projects") or {}
    home, current = canonical(Path.home()), Path(canonical(path))
    for candidate in (current, *current.parents):
        key = str(candidate)
        if key in (home, "/"):
            break
        if _accepted(projects, key):
            return True
    return False


def is_trusted_exactly(config_path: Path, path: Path | str) -> bool:
    """Whether there is a trust entry for exactly this folder, which is what `claude --bg` checks."""
    return _accepted(_read(config_path).get("projects") or {}, canonical(path))


def grant(config_path: Path, path: Path | str) -> None:
    """Record trust in the folder. Other fields of the entry and the file are left untouched."""
    key = canonical(path)
    data = _read(config_path)
    projects = data.get("projects")
    if not isinstance(projects, dict):
        projects = data["projects"] = {}
    if _accepted(projects, key):
        return
    entry = projects.get(key)
    projects[key] = {**(entry if isinstance(entry, dict) else {}), TRUST_KEY: True}
    _write(config_path, data)


def revoke(config_path: Path, path: Path | str) -> None:
    """Remove the folder entry entirely: the worktree is gone, and its entry is just garbage in the config."""
    key = canonical(path)
    data = _read(config_path)
    projects = data.get("projects")
    if not isinstance(projects, dict) or key not in projects:
        return
    del projects[key]
    _write(config_path, data)


def is_untrusted_error(error: BaseException) -> bool:
    return CLI_UNTRUSTED_MARKER in str(error)
