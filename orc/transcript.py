"""The last turn of a session from its transcript: when it started and how the agent ended it.

Why: the daemon sets `state=blocked` in state.json BASED ON THE TEXT at the end of a turn, and the
`needs` field is its own one-line English paraphrase of that text. The daemon takes the agent's
final report with a list of "what I need from you" for a question, and a cryptic
"coordinate with backend on: …" hangs on the card even though the session finished its work long ago.
The transcript is the source of truth: it shows when this turn began, so whether the work was handed in
during it (orc/handoff.py), and what text the agent actually left for the human.

Transcript format (Claude Code 2.1.x, see also orc/token_usage.py):
- a human message (task prompt, reply, resume) is a `type: "user"` line with text and no
  `isMeta`; tool results are also `type: "user"`, but with `tool_result` blocks;
- a model message is written as several `type: "assistant"` lines, one block per line;
- subagent lines are marked `isSidechain`;
- the `turnOrigin` field says who opened the turn: `human`, `scheduled` (the agent's alarm),
  `task_notification` (a background task of the agent finished: Monitor, a background command, a subagent).
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class LastTurn:
    # Time of the human message that started the turn (unix time). None means not found.
    started_at: float | None
    # The text the agent ended the turn with: text blocks after the last tool call.
    final_text: str
    # The transcript ends on the agent's own text, not on a tool call, a tool result or a human message: the turn
    # is over as far as the file can tell. False when unsure.
    ended: bool = False


# The transcript is re-read only when its fingerprint (mtime, size) changed: the dispatcher
# asks about a waiting session every tick, and the file can be megabytes.
_cache: dict[str, tuple[tuple[int, int], LastTurn]] = {}

# Messages the agent triggered for itself: an alarm (ScheduleWakeup/cron) and a notification that
# its background task finished. They do not open a new turn: a handoff made before them stays
# the handoff of "this turn". Otherwise a reply to a notification in words ("Monitor is no longer
# needed, all done") hung on the card as a question, and the owner's "ok" did not help: each
# message made the handoff stale again. The daemon currently writes an alarm with isMeta as well,
# but the marker is turnOrigin.
AGENT_TURN_ORIGINS = {"scheduled", "task_notification"}


def read_last_turn(path: str | None) -> LastTurn | None:
    """The last turn of a session. None means there is no transcript or it cannot be read."""
    if not path:
        return None
    try:
        stat = os.stat(path)
    except OSError:
        return None
    fingerprint = (stat.st_mtime_ns, stat.st_size)
    cached = _cache.get(path)
    if cached and cached[0] == fingerprint:
        return cached[1]
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            turn = parse_last_turn(f)
    except OSError:
        return None
    _cache[path] = (fingerprint, turn)
    return turn


def parse_last_turn(lines) -> LastTurn:
    started_at: float | None = None
    final: list[str] = []
    ended = False
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("isSidechain"):
            continue
        kind = entry.get("type")
        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if kind == "user" and _is_human_prompt(entry, content):
            if entry.get("turnOrigin") not in AGENT_TURN_ORIGINS:
                started_at = _timestamp(entry.get("timestamp")) or started_at
            final = []  # the turn result is the agent's words after the last message, whoever sent it
            ended = False
        elif kind == "user":
            ended = False  # a tool result: the agent is about to continue
        elif kind == "assistant" and isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    final = []  # text before a tool call is intermediate, not the turn result
                    ended = False
                elif block.get("type") == "text" and str(block.get("text", "")).strip():
                    final.append(str(block["text"]).strip())
                    ended = True
    return LastTurn(started_at=started_at, final_text="\n\n".join(final), ended=ended)


def _is_human_prompt(entry: dict, content) -> bool:
    """A message the agent started talking again after: not a service insert (skill, compact
    summary) and not a tool result. Whether it starts a turn is decided by `AGENT_TURN_ORIGINS`."""
    if entry.get("isMeta") or entry.get("isCompactSummary"):
        return False
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        types = {b.get("type") for b in content if isinstance(b, dict)}
        return "text" in types and "tool_result" not in types
    return False


def _timestamp(raw) -> float | None:
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# A message that has just been typed is near the end of the file, and transcripts run to many megabytes.
_RECEIPT_TAIL_BYTES = 8_000_000
# The input box wraps a long paste in this. We type rather than paste, so it is only a precaution: a message that
# did arrive must not be typed again.
_PASTE_WRAPPER = re.compile(r'^<pasted_content id="[^"]*">(.*)</pasted_content id="[^"]*">$', re.DOTALL)


def session_received(path: str | None, text: str, since: float) -> bool:
    """Whether the session has taken exactly this text as input since a moment in time: it either started a turn
    with it (`type: "user"`) or put it in its own queue while busy (`queue-operation` enqueue).

    The whole text has to match. A short reply like "ok" is a substring of nearly any line, and agent notifications
    are text rows as well: a loose match would declare a message delivered that was never typed. Spacing and
    punctuation do not count, though: if the input box adjusts them, a message that did arrive must not be typed again.
    """
    wanted = _fingerprint(text)
    if not path or not wanted:
        return False
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            start = max(0, f.tell() - _RECEIPT_TAIL_BYTES)
            f.seek(start)
            tail = f.read()
    except OSError:
        return False
    if start:
        tail = tail.partition(b"\n")[2]  # the first line is cut in half
    for line in tail.decode("utf-8", "replace").splitlines():
        if '"queue-operation"' not in line and '"user"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("isSidechain"):
            continue
        at = _timestamp(entry.get("timestamp"))
        if at is None or at < since:
            continue
        if _fingerprint(_input_text(entry)) == wanted:
            return True
    return False


def _fingerprint(text: str) -> str:
    """Letters and digits of the text. A message of nothing but punctuation is compared as it is."""
    return "".join(c for c in text if c.isalnum()) or "".join(text.split())


def _input_text(entry: dict) -> str:
    if entry.get("type") == "queue-operation":
        content = entry.get("content") if entry.get("operation") == "enqueue" else None
        return content if isinstance(content, str) else ""
    if entry.get("type") != "user":
        return ""
    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not _is_human_prompt(entry, content):
        return ""
    text = content if isinstance(content, str) else " ".join(
        str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") == "text")
    wrapped = _PASTE_WRAPPER.match(text.strip())
    return wrapped.group(1) if wrapped else text
