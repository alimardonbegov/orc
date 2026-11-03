"""Process settings that are not stored in the DB: paths and intervals."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# The SPA build inside the wheel (placed there by hatch_build.py). In a repository clone this directory
# never exists, so its presence unambiguously means "running from an installed package".
PACKAGED_STATIC = Path(__file__).resolve().parent / "_web"


def running_from_source() -> bool:
    """Running from a repository clone, not from an installed package.

    We check pyproject.toml, not .git: in a worktree .git is a file, and a Docker image has no .git
    at all, but pyproject.toml is copied into it. An installed wheel never has the project's pyproject.toml
    next to the package (site-packages)."""
    return (REPO_ROOT / "pyproject.toml").is_file()


def default_data_dir() -> Path:
    """A clone keeps its data in <repo>/data, as before; an installed package keeps it in ~/.orc:
    the site-packages directory is no place for the database, any reinstall wipes it."""
    return REPO_ROOT / "data" if running_from_source() else Path.home() / ".orc"


def default_static_dir() -> Path:
    """The built SPA: from the wheel if it is there, otherwise the clone's web/dist (make build)."""
    return PACKAGED_STATIC if PACKAGED_STATIC.is_dir() else REPO_ROOT / "web" / "dist"


@dataclass
class Settings:
    data_dir: Path
    jobs_dir: Path = field(default_factory=lambda: Path.home() / ".claude" / "jobs")
    claude_bin: str = "claude"
    poll_interval_sec: int = 30
    # The limits cache (5h/week) is the orchestrator's OWN file, not the shared ~/.claude/usage-cache.json:
    # the user's terminal statusline writes to that one too, and its empty renders reset
    # the numbers on the board. Only Claude's own poll and the statusline of OUR sessions write here
    # (orc/usage.py). None in the constructor means "default, inside data_dir".
    usage_cache_path: Path | None = None
    # A fallback source of the same limits: a snapshot that Claude Code keeps itself.
    claude_json_path: Path = field(default_factory=lambda: Path.home() / ".claude.json")
    # Polling Claude for limits with a probe request (orc/usage.py, Prober). Disabled in tests:
    # otherwise the test suite would hit the real `claude` and spend the developer's limits.
    usage_probe_enabled: bool = True
    # The address of this same server for session hooks: the input-request hook (orc/hooks/input_hook.py)
    # goes here for the owner's decision. `orc serve` fills in its own host/port.
    api_base: str = "http://127.0.0.1:8765"
    # Perimeter (orc/security.py): the names under which the dashboard may be opened, and the addresses
    # of clients that count as this machine. Not user settings: only tests change them,
    # where TestClient sends Host: testserver from the testclient address.
    allowed_hosts: tuple[str, ...] = ("127.0.0.1", "localhost", "::1")
    allowed_clients: tuple[str, ...] = ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def __post_init__(self) -> None:
        if self.usage_cache_path is None:
            self.usage_cache_path = self.data_dir / "usage-cache.json"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "orc.db"


def load_settings() -> Settings:
    # ORC_DATA_DIR lets you move the data anywhere and takes precedence over any default
    data_dir = Path(os.environ.get("ORC_DATA_DIR") or default_data_dir())
    # 0700: the directory holds task statements, repository paths and the dashboard token.
    # chmod is separate from mkdir: for an already existing directory the mode does not fix itself.
    data_dir.mkdir(parents=True, exist_ok=True)
    data_dir.chmod(0o700)
    return Settings(data_dir=data_dir)
