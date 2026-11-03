#!/usr/bin/env python3
"""Hook that delivers messages from a task inbox into a running Claude session.

Launched by Claude Code itself on every tool call (`PostToolUse`) and before the session
finishes (`Stop`); receives the event as JSON on stdin. Stdlib only and no imports from orc:
the script starts hundreds of times per session and must work in any environment where python was found.

The contract on the orchestrator side is described in orc/inbox.py.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

INBOX_REL = ".orchestrator/inbox"
PREFIX = "Message from the task owner (delivered by the orchestrator):"


def _collect(inbox: Path) -> list[str]:
    """Collect all undelivered messages and mark them as delivered."""
    delivered = inbox / "delivered"
    bodies = []
    for path in sorted(inbox.glob("msg-*.json"), key=lambda p: (len(p.stem), p.stem)):
        try:
            body = json.loads(path.read_text(encoding="utf-8")).get("body", "")
        except (OSError, ValueError):
            continue
        try:
            delivered.mkdir(parents=True, exist_ok=True)
            path.rename(delivered / path.name)
        except OSError:
            # Rename failed: we do not hand the message out: better to deliver it later
            # than to give it to the session in a loop on every tool call.
            continue
        if body:
            bodies.append(body)
    return bodies


def main() -> int:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    if not isinstance(data, dict):
        return 0
    inbox = Path(data.get("cwd") or ".") / INBOX_REL
    if not inbox.is_dir():
        return 0
    bodies = _collect(inbox)
    if not bodies:
        return 0
    text = PREFIX + "\n" + "\n\n".join(bodies)
    if data.get("hook_event_name") == "Stop":
        # We do not let the session finish: the message arrived while it was finishing its last step.
        # The files are already marked delivered, so the next Stop will pass freely.
        print(json.dumps({"decision": "block", "reason": text}, ensure_ascii=False))
        return 0
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": data.get("hook_event_name") or "PostToolUse",
        "additionalContext": text,
    }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # The hook has no right to crash the session because of its own error.
        sys.exit(0)
