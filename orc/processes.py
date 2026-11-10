"""Real OS processes of a session: what it has running right now, including foreground commands.

`fan` in state.json lists only background work. A long `npm test` run by a foreground Bash call is
visible only here. The pid comes from ~/.claude/sessions/<pid>.json, which Claude Code keeps for
every live session, so no `claude` subprocess is needed; `ps` is the same on macOS and Linux.
"""
from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Callable

log = logging.getLogger("orc.processes")

PS_TIMEOUT_SEC = 5
COMMAND_LIMIT = 400
PS_ARGS = ["ps", "-axo", "pid=,ppid=,etime=,pcpu=,rss=,command="]


def session_pid(claude_dir: Path, session_id: str | None) -> int | None:
    """The pid of a live session by its id. A file may outlive its process: the caller checks the pid against ps."""
    if not session_id:
        return None
    try:
        files = list((Path(claude_dir) / "sessions").glob("*.json"))
    except OSError:
        return None
    for path in files:
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("sessionId") == session_id and isinstance(data.get("pid"), int):
            return data["pid"]
    return None


def etime_seconds(raw: str) -> int | None:
    """`[[dd-]hh:]mm:ss` from ps."""
    days, _, clock = raw.strip().rpartition("-")
    try:
        total = 0
        for part in clock.split(":"):
            total = total * 60 + int(part)
        return total + (int(days) * 86400 if days else 0)
    except ValueError:
        return None


def parse_ps(output: str) -> list[dict]:
    rows = []
    for line in output.splitlines():
        fields = line.split(None, 5)
        if len(fields) < 6:
            continue
        try:
            rows.append({"pid": int(fields[0]), "ppid": int(fields[1]), "elapsed_sec": etime_seconds(fields[2]),
                         "cpu_pct": float(fields[3].replace(",", ".")), "rss_kb": int(fields[4]),
                         "command": fields[5][:COMMAND_LIMIT]})
        except ValueError:
            continue
    return rows


def _run_ps() -> str:
    return subprocess.run(PS_ARGS, capture_output=True, text=True, timeout=PS_TIMEOUT_SEC, check=True).stdout


def process_tree(root_pid: int, run_ps: Callable[[], str] = _run_ps) -> list[dict]:
    """The session process and its descendants, depth-first, each with its `depth`.

    Empty when the pid is gone. A reused pid is not a session: the root's command must mention claude.
    """
    try:
        rows = parse_ps(run_ps())
    except (OSError, subprocess.SubprocessError):
        log.warning("ps failed", exc_info=True)
        return []
    root = next((r for r in rows if r["pid"] == root_pid), None)
    if root is None or "claude" not in root["command"].lower():
        return []
    children: dict[int, list[dict]] = {}
    for row in rows:
        children.setdefault(row["ppid"], []).append(row)
    result: list[dict] = []
    seen: set[int] = set()
    stack = [(root, 0)]
    while stack:
        row, depth = stack.pop()
        if row["pid"] in seen:
            continue
        seen.add(row["pid"])
        result.append({**row, "depth": depth})
        stack.extend((child, depth + 1) for child in reversed(children.get(row["pid"], [])))
    return result
