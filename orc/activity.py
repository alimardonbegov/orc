"""The live activity of a session: what the agent said, thought and ran, and what it is doing now.

The source is the session transcript (~/.claude/projects/<slug>/<sessionId>.jsonl, see also
orc/transcript.py). Nothing is stored: the parser is stateless, the client keeps a cursor (session,
byte offset), and a poll reads only what was appended after it. A tool result arrives as a separate
event and the client pairs it with its call by `tool_use_id`, so an event once sent never changes.

Why offsets and not a sequence number: they survive a server restart and cost nothing to compute,
and a transcript is append-only.

A subagent writes to its own file (`<session>/subagents/agent-<id>.jsonl`), read here as a feed of its
own: the main feed shows the delegation, and the steps open under it on request.

`api-request*` lines are skipped: they repeat every block of the conversation and are the heaviest ones.

Thinking text is often absent from the transcript: Claude Code writes an empty `thinking` block with
a signature unless the session's display mode returns text. Such a block becomes "thought for N s"
when the duration is known, and nothing otherwise. `showThinkingSummaries` did not change this in a
spike on Claude Code 2.1.319.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from orc.claude_cli import JobState
from orc.hooks.inbox_hook import PREFIX as INBOX_PREFIX
from orc.models import Blocker, Chat, Task, TaskStatus

# How much of a transcript one request reads. A transcript reaches tens of megabytes, most of it
# api-request lines, so the first request of a feed reads only its tail.
WINDOW_BYTES = 2 * 1024 * 1024
DEFAULT_LIMIT = 300
MAX_LIMIT = 1000
# A feed is for reading: long fields are cut here, and the full text is requested separately.
TEXT_LIMIT = 8_000
INPUT_LIMIT = 2_000
RESULT_HEAD = 3_000
RESULT_TAIL = 1_000
SUMMARY_LIMIT = 300
# A full tool result on request. Larger than this does not belong in a browser tab anyway.
FULL_LIMIT = 1024 * 1024
# A thinking block without text is worth a line only when the agent really thought for a while.
THINKING_STUB_MIN_MS = 1000
# The tail read for "what is it doing now": enough for the last few steps of a live session.
CURRENT_TOOL_WINDOW_BYTES = 256 * 1024

_SKIP_PREFIX = b'{"type":"api-request'

# Tools that hand work over to a subagent.
_DELEGATING_TOOLS = ("Agent", "Task")
# An agent id goes into a file name, so it never passes unchecked.
_AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Events the conversation shows in its own way: a delivered message is a receipt on the message itself, and
# what the agent waits for is the request's form or the agent's own question, so a stage would say it twice.
_NOISE_EVENTS = ("message delivered to the session", "answer sent to the session", "is waiting for ")
TASK_EVENTS_LIMIT = 200

# The key holding the essence of a call, per tool. For an unknown tool, the first string value.
_SUMMARY_KEYS = {
    "Bash": "command", "Read": "file_path", "Write": "file_path", "Edit": "file_path",
    "NotebookEdit": "notebook_path", "Grep": "pattern", "Glob": "pattern", "WebFetch": "url",
    "WebSearch": "query", "Agent": "description", "Task": "description", "Skill": "skill",
    "ToolSearch": "query", "Monitor": "description",
}


@dataclass(frozen=True)
class Source:
    """One transcript of a feed. `key` is what the cursor refers to: the task_sessions row id, or 0 for a chat."""
    key: int
    path: str
    # A subagent's own transcript: all of its lines are marked as a side chain.
    sidechain: bool = False


def _shorten(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _cut_result(text: str) -> tuple[str, bool]:
    """The head and the tail: a command's verdict is usually at its very end."""
    if len(text) <= RESULT_HEAD + RESULT_TAIL:
        return text, False
    omitted = len(text) - RESULT_HEAD - RESULT_TAIL
    return f"{text[:RESULT_HEAD]}\n… {omitted} characters omitted …\n{text[-RESULT_TAIL:]}", True


def tool_summary(name: str, tool_input: object) -> str:
    """One line about a call: the command, the path, the query."""
    if not isinstance(tool_input, dict):
        return ""
    value = tool_input.get(_SUMMARY_KEYS.get(name, ""))
    if not isinstance(value, str) or not value.strip():
        value = next((v for v in tool_input.values() if isinstance(v, str) and v.strip()), "")
    line = " ".join(value.split())
    return line[:SUMMARY_LIMIT]


def _result_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            parts.append(str(block.get("text", "")))
        elif block.get("type"):
            parts.append(f"[{block['type']}]")
    return "\n".join(parts)


def _prompt_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def parse_entry(entry: dict) -> list[dict]:
    """Feed events of one transcript line, without position fields (see `_read_range`)."""
    kind = entry.get("type")
    at = entry.get("timestamp")
    if kind == "assistant":
        return _assistant_events(entry, at)
    if kind == "user":
        return _user_events(entry, at)
    if kind == "attachment":
        return _attachment_events(entry, at)
    if kind == "system":
        return _system_events(entry, at)
    return []


def _assistant_events(entry: dict, at: str | None) -> list[dict]:
    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return []
    events = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text" and str(block.get("text", "")).strip():
            text, cut = _shorten(str(block["text"]).strip(), TEXT_LIMIT)
            events.append({"kind": "text", "at": at, "text": text, "truncated": cut})
        elif block_type == "thinking":
            text = str(block.get("thinking") or "").strip()
            duration = entry.get("thinkingDurationMs")
            duration = duration if isinstance(duration, int) else None
            if text or (duration is not None and duration >= THINKING_STUB_MIN_MS):
                short, cut = _shorten(text, TEXT_LIMIT)
                events.append({"kind": "thinking", "at": at, "text": short, "duration_ms": duration, "truncated": cut})
        elif block_type == "tool_use" and isinstance(block.get("id"), str):
            name = str(block.get("name", ""))
            tool_input = block.get("input")
            raw = json.dumps(tool_input, ensure_ascii=False, indent=1) if tool_input is not None else ""
            shown, cut = _shorten(raw, INPUT_LIMIT)
            description = tool_input.get("description") if isinstance(tool_input, dict) else None
            event = {"kind": "tool_use", "at": at, "tool_use_id": block["id"], "name": name,
                     "summary": tool_summary(name, tool_input),
                     "description": description if isinstance(description, str) and name == "Bash" else None,
                     "input": shown, "truncated": cut, "delegate": None}
            if name in _DELEGATING_TOOLS and isinstance(tool_input, dict):
                event["delegate"] = {"agent_type": tool_input.get("subagent_type") or None,
                                     "description": str(description or "")}
            events.append(event)
    return events


def _user_events(entry: dict, at: str | None) -> list[dict]:
    if entry.get("isMeta"):
        return []
    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if entry.get("isCompactSummary"):
        return [{"kind": "notice", "at": at, "notice": "compacted", "text": "", "level": "info"}]
    if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        events = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result" and isinstance(block.get("tool_use_id"), str):
                text, cut = _cut_result(_result_text(block.get("content")))
                events.append({"kind": "tool_result", "at": at, "tool_use_id": block["tool_use_id"], "text": text,
                               "is_error": bool(block.get("is_error")), "truncated": cut})
        return events
    text = _prompt_text(content).strip()
    if not text:
        return []
    short, cut = _shorten(text, TEXT_LIMIT)
    origin = entry.get("turnOrigin")
    return [{"kind": "prompt", "at": at, "text": short, "truncated": cut,
             "origin": origin if isinstance(origin, str) else "human"}]


def _attachment_events(entry: dict, at: str | None) -> list[dict]:
    """A soft message from the owner reaches the session as hook context, not as a user line."""
    attachment = entry.get("attachment")
    if not isinstance(attachment, dict) or attachment.get("type") != "hook_additional_context":
        return []
    content = attachment.get("content")
    text = "\n".join(str(c) for c in content) if isinstance(content, list) else str(content or "")
    if not text.startswith(INBOX_PREFIX):
        return []  # context of someone else's hook, usually a long service insert
    short, cut = _shorten(text[len(INBOX_PREFIX):].strip(), TEXT_LIMIT)
    return [{"kind": "prompt", "at": at, "text": short, "truncated": cut, "origin": "delivered"}]


def _system_events(entry: dict, at: str | None) -> list[dict]:
    subtype = entry.get("subtype")
    if subtype == "turn_duration":
        duration = entry.get("durationMs")
        if isinstance(duration, int):
            return [{"kind": "notice", "at": at, "notice": "turn_end", "text": "", "duration_ms": duration, "level": "info"}]
        return []
    if subtype == "compact_boundary":
        return [{"kind": "notice", "at": at, "notice": "compacted", "text": "", "level": "info"}]
    if subtype == "api_error" or entry.get("level") == "error":
        text = entry.get("error") or entry.get("content") or subtype or ""
        short, _ = _shorten(str(text), SUMMARY_LIMIT)
        return [{"kind": "notice", "at": at, "notice": "error", "text": short, "level": "error"}]
    return []


def _read_range(source: Source, start: int, end: int | None, max_bytes: int | None = None) -> tuple[list[dict], int]:
    """Events of complete lines from `start` up to `end`. Returns them and the offset reached.

    A line still being written is not consumed: the next poll will read it whole.
    """
    events: list[dict] = []
    position = start
    try:
        with open(source.path, "rb") as f:
            f.seek(start)
            while (end is None or position < end) and (max_bytes is None or position - start < max_bytes):
                line = f.readline()
                if not line.endswith(b"\n"):
                    break
                offset = position
                position += len(line)
                events.extend(_line_events(line, source, offset))
    except OSError:
        pass
    return events, position


def _line_events(line: bytes, source: Source, offset: int) -> list[dict]:
    if line.startswith(_SKIP_PREFIX):
        return []
    try:
        entry = json.loads(line)
    except ValueError:
        return []
    if not isinstance(entry, dict) or (entry.get("isSidechain") and not source.sidechain):
        return []
    events = parse_entry(entry)
    # The id is built on the line's uuid: a session copy repeats the history of the original, and the
    # client drops such events by id.
    stem = entry.get("uuid") or f"{source.key}:{offset}"
    for index, event in enumerate(events):
        event.update(id=f"{stem}:{index}", session=source.key, offset=offset)
    return events


def _size(path: str) -> int:
    try:
        return os.stat(path).st_size
    except OSError:
        return 0


def _line_start(path: str, offset: int) -> int:
    """The start of the first whole line at or after `offset`."""
    if offset <= 0:
        return 0
    try:
        with open(path, "rb") as f:
            f.seek(offset - 1)
            return offset - 1 + len(f.readline())
    except OSError:
        return offset


def parse_cursor(raw: str | None) -> tuple[int, int] | None:
    """`<session>:<offset>`. Garbage is the same as no cursor: the feed starts over from the tail."""
    if not raw:
        return None
    key, _, offset = raw.partition(":")
    try:
        parsed = int(key), int(offset)
    except ValueError:
        return None
    return parsed if parsed[1] >= 0 else None


def _cursor(key: int, offset: int) -> str:
    return f"{key}:{offset}"


def _unique(sources: Iterable[Source]) -> list[Source]:
    """A resume of a session continues the same file: several journal rows, one transcript."""
    seen: set[str] = set()
    result = []
    for source in sources:
        if source.path and source.path not in seen:
            seen.add(source.path)
            result.append(source)
    return result


def _index_of(sources: list[Source], key: int) -> int | None:
    return next((i for i, s in enumerate(sources) if s.key == key), None)


def read_feed(sources: Iterable[Source], cursor: tuple[int, int] | None = None,
              before: tuple[int, int] | None = None, limit: int = DEFAULT_LIMIT) -> dict:
    """A page of a feed.

    No cursor: the tail of the latest transcript. `cursor`: everything after it, moving on to the next
    transcripts. `before`: an earlier window, for the "show earlier" button.

    `cursor` in the answer is what to pass on the next poll; `earlier` is what to pass as `before`,
    null when the beginning has been reached.
    """
    items = _unique(sources)
    limit = max(1, min(limit, MAX_LIMIT))
    if not items:
        return {"events": [], "cursor": None, "earlier": None}
    if before is not None:
        return _read_before(items, before, limit)
    index = _index_of(items, cursor[0]) if cursor else None
    if cursor is None or index is None:
        return _read_tail(items, limit)
    return _read_forward(items, index, cursor[1])


def _read_tail(items: list[Source], limit: int) -> dict:
    index = len(items) - 1
    source = items[index]
    start = _line_start(source.path, max(0, _size(source.path) - WINDOW_BYTES))
    events, position = _read_range(source, start, None)
    page, first = _page(events, limit, start)
    return {"events": page, "cursor": _cursor(source.key, position), "earlier": _earlier(items, index, first)}


def _read_forward(items: list[Source], index: int, offset: int) -> dict:
    events: list[dict] = []
    while True:
        source = items[index]
        chunk, position = _read_range(source, offset, None, WINDOW_BYTES)
        events.extend(chunk)
        offset = position
        # The next transcript only when this one has been read to its end and is no longer the latest.
        if index + 1 < len(items) and position >= _size(source.path) and len(events) < MAX_LIMIT:
            index, offset = index + 1, 0
            continue
        return {"events": events, "cursor": _cursor(items[index].key, offset), "earlier": None}


def _read_before(items: list[Source], before: tuple[int, int], limit: int) -> dict:
    index = _index_of(items, before[0])
    if index is None:
        return {"events": [], "cursor": None, "earlier": None}
    offset = before[1]
    if offset <= 0:
        # Crossing into the previous transcript: its end is where the earlier window starts.
        if index == 0:
            return {"events": [], "cursor": None, "earlier": None}
        index -= 1
        offset = _size(items[index].path)
    source = items[index]
    start = _line_start(source.path, max(0, offset - WINDOW_BYTES))
    events, _ = _read_range(source, start, offset)
    page, first = _page(events, limit, start)
    return {"events": page, "cursor": None, "earlier": _earlier(items, index, first)}


def _page(events: list[dict], limit: int, start: int) -> tuple[list[dict], int]:
    """The last `limit` events and where they begin. The cut goes by whole lines: the next window
    ends at a line start, and blocks of a line cut in half would never be shown."""
    if len(events) <= limit:
        return events, start
    first = events[-limit]["offset"]
    return [e for e in events if e["offset"] >= first], first


def _earlier(items: list[Source], index: int, offset: int) -> str | None:
    if offset <= 0 and index == 0:
        return None
    return _cursor(items[index].key, offset)


def read_full_result(source: Source, offset: int, tool_use_id: str) -> str | None:
    """The whole result of one call, for the "show all" button. The line is addressed by its offset."""
    try:
        with open(source.path, "rb") as f:
            f.seek(offset)
            entry = json.loads(f.readline())
    except (OSError, ValueError):
        return None
    message = entry.get("message") if isinstance(entry, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return None
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("tool_use_id") == tool_use_id:
            return _result_text(block.get("content"))[:FULL_LIMIT]
    return None


# ---------- sources ----------


def task_sources(repo, cli, task: Task) -> list[Source]:
    """Transcripts of a task in the order they were born. The journal may not know the path of the
    newest session yet: the daemon writes state.json a moment after the launch."""
    sources = []
    for row in repo.list_task_sessions(task.id):
        path = row.get("transcript_path")
        if not path and row.get("job_id"):
            st = _safe_state(cli, row["job_id"])
            path = st.transcript_path if st else None
        if path:
            sources.append(Source(row["id"], path))
    return sources


def chat_sources(chat: Chat) -> list[Source]:
    return [Source(0, chat.transcript_path)] if chat.transcript_path else []


def _subagents_dir(source: Source) -> Path:
    return Path(source.path).with_suffix("") / "subagents"


def subagent_sources(sources: Iterable[Source], agent_id: str) -> list[Source]:
    """The transcript of one subagent. The file is found on our side: the client names only the id."""
    if not _AGENT_ID_RE.match(agent_id):
        return []
    found = []
    for source in _unique(sources):
        path = _subagents_dir(source) / f"agent-{agent_id}.jsonl"
        if path.exists():
            found.append(Source(source.key, str(path), sidechain=True))
    return found


def delegations(sources: Iterable[Source]) -> list[dict]:
    """Who each delegating call handed its work to, from `agent-<id>.meta.json` next to the transcripts.

    The call's own result does not say when the work is over: a background subagent answers
    "launched" at once. `finished` is written by Claude Code when the subagent ends.
    """
    found = []
    for source in _unique(sources):
        try:
            metas = sorted(_subagents_dir(source).glob("agent-*.meta.json"))
        except OSError:
            continue
        for path in metas:
            try:
                meta = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if isinstance(meta, dict) and isinstance(meta.get("toolUseId"), str):
                found.append({"tool_use_id": meta["toolUseId"],
                              "agent_id": path.name[len("agent-"):-len(".meta.json")],
                              "agent_type": meta.get("agentType"), "finished": bool(meta.get("finished"))})
    return found


def task_conversation(repo, dispatcher, task: Task) -> dict:
    """What a card merges with the session's steps: the owner's comments and the task's stages.

    `sent_text` is what the session received for a message, and `delivery` how far it got; together
    they let the client mark a message as read and not show it a second time as a prompt.
    """
    messages = {m["body"]: m["state"] for m in repo.list_messages(task.id)}
    comments = []
    for comment in repo.list_comments(task.id):
        sent = dispatcher.with_images(comment["body"]) if comment["kind"] in ("answer", "rework") else None
        comments.append({**comment, "sent_text": sent, "delivery": messages.get(sent) if sent else None})
    stages = []
    prefix = re.compile(rf"^#{task.id}:?\s*")
    for event in repo.task_events(task.id, TASK_EVENTS_LIMIT):
        text = prefix.sub("", event["message"])
        if not any(text.startswith(noise) for noise in _NOISE_EVENTS):
            stages.append({"id": event["id"], "at": event["created_at"], "level": event["level"], "text": text})
    return {"comments": comments, "stages": stages}


def _safe_state(cli, job_id: str | None) -> JobState | None:
    if not job_id:
        return None
    try:
        return cli.read_state(job_id)
    except Exception:
        return None


# ---------- what the agent is doing now ----------


def _fan_view(st: JobState | None) -> tuple[list[dict], list[dict]]:
    """Background work and the todo list out of `fan` in state.json.

    Todo entries carry zeros in their time fields: the state is in the presence of the keys
    (`doneAt` means done, `startedAt` means in progress, neither means pending).
    """
    processes, todos = [], []
    for item in (st.fan if st else ()):
        label = str(item.get("label", ""))
        if item.get("kind") == "todo":
            status = "done" if "doneAt" in item else "in_progress" if "startedAt" in item else "pending"
            todos.append({"label": label, "status": status})
            continue
        status = "failed" if item.get("failed") else "done" if item.get("doneAt") else "running"
        processes.append({"id": str(item.get("id", "")), "kind": str(item.get("kind", "")), "label": label,
                          "status": status, "started_at_ms": _ms(item.get("startedAt")),
                          "done_at_ms": _ms(item.get("doneAt"))})
    return processes, todos


def _ms(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


# What was found at the end of each live transcript, by its fingerprint: the page asks every second or so.
_current_tool_cache: dict[str, tuple[tuple[int, int], dict | None]] = {}


def current_tool(path: str | None) -> dict | None:
    """The last call without a result: what the session is busy with. Only the end of the transcript is read.

    The daemon's `detail` is often empty, and this is the fallback that says what is going on. A call
    that started before the window, or a line larger than it, simply gives nothing.
    """
    if not path:
        return None
    try:
        stat = os.stat(path)
    except OSError:
        return None
    fingerprint = (stat.st_mtime_ns, stat.st_size)
    cached = _current_tool_cache.get(path)
    if cached and cached[0] == fingerprint:
        return cached[1]
    start = _line_start(path, max(0, stat.st_size - CURRENT_TOOL_WINDOW_BYTES))
    events, _ = _read_range(Source(0, path), start, None)
    # Calls may run in parallel, and a long one may outlive the ones after it. A new human turn closes
    # the rest: a call interrupted by a stop never gets its result.
    running: dict[str, dict] = {}
    for event in events:
        if event["kind"] == "tool_use":
            running[event["tool_use_id"]] = {"name": event["name"], "summary": event["summary"], "at": event["at"]}
        elif event["kind"] == "tool_result":
            running.pop(event["tool_use_id"], None)
        elif event["kind"] == "prompt" and event["origin"] == "human":
            running.clear()
    pending = list(running.values())[-1] if running else None
    _current_tool_cache[path] = (fingerprint, pending)
    return pending


def _session_view(st: JobState | None) -> dict:
    processes, todos = _fan_view(st)
    idle = st.idle_sec(time.time()) if st else None
    return {"detail": st.detail if st else "", "tempo": st.tempo if st else None,
            "current_tool": current_tool(st.transcript_path) if st else None,
            "silent_sec": round(idle) if idle is not None else None,
            "in_flight": st.in_flight if st else 0, "processes": processes, "todos": todos}


def _live_phase(st: JobState | None) -> str:
    if st is None:
        return "starting"
    if st.state in ("stopped", "failed", "done"):
        return "stopped"
    if st.turn_ended:
        return "background" if st.in_flight > 0 else "idle"
    return "working"


def task_now(repo, cli, task: Task) -> dict:
    """The answer to "what is it doing and what is it stuck on", for a card and for the agents page.

    `phase`: starting | working | background | idle | stopped | waiting_input | waiting_reply | quota | sleeping |
    delivering, and for a task out of work, its status.
    """
    request = repo.open_input_request(task.id) if task.status == TaskStatus.IN_PROGRESS else None
    st = _safe_state(cli, task.job_id) if task.status == TaskStatus.IN_PROGRESS else None
    if task.status != TaskStatus.IN_PROGRESS:
        phase = str(task.status)
    elif request is not None:
        phase = "waiting_input"
    elif task.blocker == Blocker.NEEDS_INPUT:
        phase = "waiting_reply"
    elif task.blocker == Blocker.QUOTA:
        phase = "quota"
    elif task.blocker == Blocker.SLEEPING and task.outbox_state is None:
        phase = "sleeping"  # no session until its wakeup (orc/wakeups.py), so the job's state says nothing
    elif task.outbox_state == "stopping":
        phase = "delivering"
    else:
        phase = _live_phase(st)
    return {"phase": phase, "live": task.status == TaskStatus.IN_PROGRESS, "status": str(task.status),
            "has_session": bool(task.session_id), "agent_id": task.agent_id,
            "waiting_detail": request["summary"] if request else task.blocker_detail if phase == "waiting_reply" else None,
            "failed_detail": task.blocker_detail if task.status == TaskStatus.FAILED else None,
            # What holds the card besides a question: the thread shows it as a one-line notice above the composer
            "blocker": str(task.blocker) if task.blocker else None, "blocker_detail": task.blocker_detail, "detail_code": task.detail_code,
            "outbox_state": task.outbox_state,
            **_session_view(st)}


def chat_now(cli, chat: Chat) -> dict:
    """The same for a direct chat. A chat turn has no permission hook: `waiting` covers all of its waiting."""
    live = chat.status in ("running", "waiting", "queued")
    st = _safe_state(cli, chat.job_id) if live else None
    if chat.status == "waiting":
        phase = "waiting_reply"
    elif chat.status == "queued":
        phase = "starting"
    elif chat.status == "running":
        phase = _live_phase(st)
    else:
        phase = "idle"
    return {"phase": phase, "live": live, "status": chat.status, "has_session": bool(chat.session_id),
            "agent_id": chat.agent_id,
            "waiting_detail": chat.waiting_detail if chat.status == "waiting" else None, "failed_detail": None,
            "blocker": None, "blocker_detail": None, "detail_code": None, "outbox_state": None,
            **_session_view(st)}


def claude_dir(settings) -> Path:
    """`sessions`, `jobs` and `projects` live side by side inside ~/.claude."""
    return Path(settings.jobs_dir).parent
