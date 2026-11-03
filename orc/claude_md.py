"""Project memory files: the repository's CLAUDE.md.

Claude Code picks up memory along the parent directories and reads it from two places at once:
`CLAUDE.md` in the repository root and `.claude/CLAUDE.md` next to the other Claude Code
settings. Both variants are in use, repositories come with one or the other, so
the dashboard shows both locations and lets you edit the one that the project actually uses.

Memory is read by every Claude Code session launched in this repository: both in the main
copy and in task worktrees (they live inside the repository). So editing these files
is editing the instructions of all of the project's agents at once, and doing it through the UI is more convenient
than through an editor behind the orchestrator's back.

Writing is always "read, then write": the client sends the fingerprint of the content
it edited, and someone else's edit (an agent's or a human's in an editor) is not silently
overwritten but turned into a conflict.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

# The order matters: this is the order the locations are shown in the UI, the root first.
LOCATIONS: dict[str, str] = {
    "root": "CLAUDE.md",
    "claude-dir": ".claude/CLAUDE.md",
}
DEFAULT_LOCATION = "root"
# Size ceiling: CLAUDE.md is a short memory file, not a dump of logs. Anything larger
# will not fit into the settings window anyway, but it can eat the server's memory.
MAX_BYTES = 256 * 1024


class ClaudeMdError(RuntimeError):
    """The file cannot be read or written: no repository, not text, too large."""


class ClaudeMdConflict(ClaudeMdError):
    """The file on disk changed since it was read: it must not be overwritten blindly."""


def rel_for(location: str) -> str:
    rel = LOCATIONS.get(location)
    if rel is None:
        raise ClaudeMdError(f"unknown location for CLAUDE.md: {location!r}")
    return rel


def path_for(repo_path: Path, location: str = DEFAULT_LOCATION) -> Path:
    return repo_path / rel_for(location)


def _sha(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _view(location: str, file: Path, content: str | None, error: str | None = None) -> dict:
    """A uniform view of one file: where it lives, whether it exists, the fingerprint and the reason if it cannot be read.

    The error lives inside the file view instead of being thrown out: a broken `.claude/CLAUDE.md`
    must not take down the whole memory section, the second location has to stay editable.
    """
    return {
        "location": location,
        "rel": rel_for(location),
        "path": str(file),
        "exists": content is not None,
        "content": content or "",
        "sha": _sha(content) if content is not None else None,
        "error": error,
    }


def _require_repo(repo_path: Path) -> None:
    if not repo_path.is_dir():
        raise ClaudeMdError(f"the project directory {repo_path} does not exist on disk")


def read_one(repo_path: Path, location: str = DEFAULT_LOCATION) -> dict:
    """One memory file. No file gives a view with exists=false, a broken file gives a view with error."""
    _require_repo(repo_path)
    file = path_for(repo_path, location)
    if not file.exists():
        return _view(location, file, None)
    if not file.is_file():
        return _view(location, file, None, f"{file} is not a file")
    if file.stat().st_size > MAX_BYTES:
        return _view(location, file, None, f"{file} is larger than {MAX_BYTES // 1024} KB, edit it in an editor")
    try:
        return _view(location, file, file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError) as e:
        return _view(location, file, None, f"{file} cannot be read: {e}")


def read(repo_path: Path) -> dict:
    """All of a project's known memory locations at once: the UI needs to show both."""
    return {"files": [read_one(repo_path, location) for location in LOCATIONS]}


def normalize(content: str) -> str:
    """Line endings as in a text file, and a trailing newline for non-empty text."""
    text = content.replace("\r\n", "\n").replace("\r", "\n")
    if text.strip() == "":
        return ""
    return text if text.endswith("\n") else text + "\n"


def write(repo_path: Path, content: str, prev_sha: str | None,
          location: str = DEFAULT_LOCATION) -> dict:
    """Write the file. prev_sha is the fingerprint of what the client read (None means the file did not exist).

    Empty text means "the file is not needed": it is deleted rather than left as an empty stub
    in the repository. The UI warns about this with a caption under the field.
    """
    current = read_one(repo_path, location)
    if current["error"]:
        raise ClaudeMdError(current["error"])
    if current["sha"] != prev_sha:
        raise ClaudeMdConflict(
            f"{current['rel']} changed on disk after it was opened: "
            f"close the window, open it again and carry over your edits")
    text = normalize(content)
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ClaudeMdError(f"{current['rel']} is longer than {MAX_BYTES // 1024} KB: an agent does not need that much memory")
    file = path_for(repo_path, location)
    try:
        if text == "":
            file.unlink(missing_ok=True)
            return _view(location, file, None)
        # For `.claude/CLAUDE.md` the directory may not exist yet: creating the file must not
        # run into a missing folder.
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")
    except OSError as e:
        raise ClaudeMdError(f"{file} cannot be written: {e}")
    return _view(location, file, text)
