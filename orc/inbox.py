"""Task inbox: a file channel for delivering messages into a LIVE Claude session.

The CLI has no direct way to push text into a running background session: `--resume` on a live
session is treated by the daemon as launching a copy. But a session has hooks, and `PostToolUse` can return
`additionalContext`: text the model sees and reacts to without being interrupted.

Hence the scheme: the dispatcher puts a message as a file into the task worktree, the hook on the nearest tool call
hands it to the session and moves the file to `delivered/`. That same move serves as
the delivery acknowledgement: the dispatcher sees it on the next tick, no IPC needed.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

INBOX_REL = ".orchestrator/inbox"
DELIVERED_DIR = "delivered"
HOOK_SCRIPT = Path(__file__).parent / "hooks" / "inbox_hook.py"
# The hook hangs on EVERY tool call, so the ceiling is low: message delivery is not worth
# more than a couple of seconds, and the session must not wait for it.
HOOK_TIMEOUT_SEC = 10


def _inbox(worktree: Path) -> Path:
    return worktree / INBOX_REL


def _name(message_id: int) -> str:
    return f"msg-{message_id}.json"


def put(worktree: Path, message_id: int, body: str) -> None:
    """Put a message into the inbox. A repeated call with the same id duplicates nothing."""
    box = _inbox(worktree)
    box.mkdir(parents=True, exist_ok=True)
    (box / _name(message_id)).write_text(
        json.dumps({"id": message_id, "body": body}, ensure_ascii=False), encoding="utf-8"
    )


def _ids(directory: Path) -> set[int]:
    if not directory.is_dir():
        return set()
    ids = set()
    for path in directory.glob("msg-*.json"):
        try:
            ids.add(int(path.stem.removeprefix("msg-")))
        except ValueError:
            continue
    return ids


def pending_ids(worktree: Path) -> set[int]:
    """Messages the session has not picked up yet."""
    return _ids(_inbox(worktree))


def delivered_ids(worktree: Path) -> set[int]:
    """Messages the hook handed to the session: delivery acknowledgement."""
    return _ids(_inbox(worktree) / DELIVERED_DIR)


def clear(worktree: Path) -> None:
    """Remove undelivered messages without touching the history of delivered ones.

    Needed before a resume: the text goes straight into the prompt, and a leftover file would be picked up by the session
    as a second copy of the same message.
    """
    for path in _inbox(worktree).glob("msg-*.json"):
        path.unlink(missing_ok=True)


def hook_settings_json(python: str | None = None, extra: dict | None = None,
                       hooks: dict | None = None) -> str:
    """JSON for `claude --settings`: delivery hooks for one session (plus `extra`, if given).

    The settings travel as a string in an argument, not as a file in the user's repository, and end up
    in the session's saved options, verified by a spike: after `claude stop` + `--resume` the daemon
    writes "woke session ... with its saved options (--name, --permission-mode, --settings, --model)".

    `extra` is a place for session settings unrelated to the inbox: currently the
    limits-collecting statusline goes there (orc/usage.py). The `hooks` key from `extra` is ignored:
    there is nothing to replace message delivery with.

    `hooks` are entries for OTHER hook events (currently input requests, orc/inputs.py). They are
    added to the inbox ones as is; we do not take PostToolUse and Stop from them for the same reason.
    """
    command = f"{python or sys.executable} {HOOK_SCRIPT}"
    entry = [{"matcher": "*", "hooks": [{"type": "command", "command": command, "timeout": HOOK_TIMEOUT_SEC}]}]
    stop_entry = [{"hooks": [{"type": "command", "command": command, "timeout": HOOK_TIMEOUT_SEC}]}]
    settings = {k: v for k, v in (extra or {}).items() if k != "hooks"}
    settings["hooks"] = {
        **{k: v for k, v in (hooks or {}).items() if k not in ("PostToolUse", "Stop")},
        "PostToolUse": entry,
        "Stop": stop_entry,
    }
    return json.dumps(settings, ensure_ascii=False)
