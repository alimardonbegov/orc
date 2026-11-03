#!/usr/bin/env python3
"""Statusline for orchestrator sessions: stores account limits in a cache file.

Claude Code calls this script on every statusline render and passes JSON on stdin with
the model, context and, most valuable, `rate_limits` (the 5-hour and weekly windows). Background
sessions (`claude --bg`) render the statusline too, so the board gets fresh numbers for free,
just because it works. This is a free addition to Claude's own polling, which
lives in orc/usage.py (`Prober`), not a replacement for it.

The cache is TOPPED UP, not overwritten, and only with NEWS. Rendering happens constantly, while
limits inside it change only together with an Anthropic response: an idle session renders the same
old percentages with the current time for an hour straight. So for each session we
remember what it showed last time (`<cache>.sessions/<session_id>.json`), and put into the cache
only a change of numbers: that is the fresh response, and its time is honestly counted as the time
of measurement. A session's first appearance is not news: its numbers could have arrived long before us (this
happens right after an orchestrator restart), so we only remember them.

The merge rule is the same as in orc/usage.py: the latest measurement wins, in either direction.
A larger percent no longer wins by itself: after a subscription upgrade the same usage
becomes a smaller percent in the same window.

Stdlib only and no imports from orc: the script starts dozens of times per session and must
work in any environment where python was found. The contract on the orchestrator side is in
orc/usage.py.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

BAR_WIDTH = 10
WINDOWS = ("five_hour", "seven_day")
# See orc/usage.py: to the precision of a minute we consider it to be the same window.
WINDOW_GRANULARITY_SEC = 60
# We drop the memory of sessions that have not been heard from in a long time: after this many seconds without
# a render the session is either closed or its numbers are hopelessly stale anyway.
SESSION_MEMORY_TTL_SEC = 2 * 24 * 3600


def _bar(pct: float) -> str:
    filled = max(0, min(BAR_WIDTH, round(pct * BAR_WIDTH / 100)))
    return "▓" * filled + "░" * (BAR_WIDTH - filled)


def _num(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _window(raw: object, measured_at: float) -> dict | None:
    """Window from a statusline event -> a sample in cache format (orc/usage.py, `sample`)."""
    if not isinstance(raw, dict):
        return None
    pct = _num(raw.get("used_percentage"))
    if pct is None:
        return None
    return {
        "used_percentage": max(0.0, min(100.0, pct)),
        "resets_at": _num(raw.get("resets_at")),
        "measured_at": measured_at,
        "source": "statusline",
    }


def _best(samples: list, now: float) -> dict | None:
    """The best sample of a window is the latest measurement (like `best` in orc/usage.py).

    Windows that have already reset are dropped: their percent no longer applies. The "no window" marker
    (`absent`, put there by the orchestrator probe) is respected just like the numbers.
    """
    def alive(s) -> bool:
        if not isinstance(s, dict):
            return False
        if s.get("absent") is True:
            return True
        resets_at = _num(s.get("resets_at"))
        return _num(s.get("used_percentage")) is not None and (resets_at is None or resets_at > now)

    live = [s for s in samples if alive(s)]
    if not live:
        return None

    def key(s):
        resets_at = _num(s.get("resets_at"))
        return (_num(s.get("measured_at")) or 0,
                0.0 if resets_at is None else round(resets_at / WINDOW_GRANULARITY_SEC),
                _num(s.get("used_percentage")) or 0)

    return max(live, key=key)


def _fingerprint(limits: dict) -> dict:
    """What the session shows now: percent and window for each limit. For comparison only."""
    out = {}
    for key in WINDOWS:
        raw = limits.get(key)
        if isinstance(raw, dict) and _num(raw.get("used_percentage")) is not None:
            resets_at = _num(raw.get("resets_at"))
            out[key] = [_num(raw.get("used_percentage")),
                        None if resets_at is None else round(resets_at / WINDOW_GRANULARITY_SEC)]
    return out


def _sessions_dir(path: Path) -> Path:
    return path.with_name(path.name + ".sessions")


def _session_news(path: Path, session_id: object, limits: dict, now: float) -> set[str]:
    """Which windows of the session changed since the previous render: only those are worth putting into the cache.

    Without a session_id there is nothing to define news by, and the old "write everything" behavior here would be
    exactly the mistake that all of this was started to fix, so we write nothing.
    """
    if not isinstance(session_id, str) or not session_id or "/" in session_id or session_id.startswith("."):
        return set()
    current = _fingerprint(limits)
    memo_dir = _sessions_dir(path)
    memo = memo_dir / f"{session_id}.json"
    try:
        seen = json.loads(memo.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        seen = None
    if not isinstance(seen, dict):
        seen = None
    if seen == current:
        # A repeat of the same is not news. We touch only mtime: cleanup uses it to understand that
        # the session is still alive even though its numbers do not change.
        try:
            os.utime(memo, None)
        except OSError:
            pass
        return set()
    tmp = memo.with_name(memo.name + f".tmp{os.getpid()}")
    try:
        memo_dir.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(current), encoding="utf-8")
        os.replace(tmp, memo)
    except OSError:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
    if seen is None:
        _prune_sessions(memo_dir, now)
        return set()  # first appearance of the session: the numbers could have arrived long before us
    return {key for key in current if seen.get(key) != current[key]}


def _prune_sessions(memo_dir: Path, now: float) -> None:
    """Remove the memory of long-silent sessions. Called only on a new session, so rarely."""
    try:
        entries = list(memo_dir.glob("*.json"))
    except OSError:
        return
    for entry in entries:
        try:
            if now - entry.stat().st_mtime > SESSION_MEMORY_TTL_SEC:
                entry.unlink()
        except OSError:
            continue


def _previous(path: Path) -> dict:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    # Old format: the window has no `measured_at`, a single time was stored for the whole file.
    fallback = _num(raw.get("updated_at"))
    out = {}
    for key in WINDOWS:
        item = raw.get(key)
        if isinstance(item, dict):
            item.setdefault("measured_at", fallback)
            item.setdefault("source", "statusline")
            out[key] = item
    out["model"] = raw.get("model") if isinstance(raw.get("model"), str) else None
    return out


def write_cache(path: Path, payload: dict) -> None:
    """Top up the cache with limits from a statusline event. A corrupted cache must not crash the statusline.

    Records without `rate_limits` are skipped: the first renders of a session come before the first Anthropic
    response, and an empty one would overwrite perfectly good numbers from the previous session. From the rest
    we take only the windows whose numbers changed for this session (`_session_news`).
    """
    limits = payload.get("rate_limits")
    if not isinstance(limits, dict):
        return
    now = time.time()
    news = _session_news(path, payload.get("session_id"), limits, now)
    fresh = {key: _window(limits.get(key), now) if key in news else None for key in WINDOWS}
    if not any(fresh.values()):
        return

    previous = _previous(path)
    model = payload.get("model")
    data = {
        "model": model.get("display_name") if isinstance(model, dict) else previous.get("model"),
        "updated_at": now,
    }
    for key in WINDOWS:
        data[key] = _best([previous.get(key), fresh[key]], now)

    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        # Replace in one move: the reader (orc/usage.py) never sees half a file.
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def line(payload: dict) -> str:
    """Statusline line. A background session shows it to nobody, but `claude attach` does."""
    model = payload.get("model")
    name = model.get("display_name") if isinstance(model, dict) else None
    window = payload.get("context_window")
    pct = window.get("used_percentage") if isinstance(window, dict) else None
    pct = pct if isinstance(pct, (int, float)) and not isinstance(pct, bool) else 0
    parts = [f"[{name or '?'}]", _bar(pct), f"{int(pct)}%"]
    limits = payload.get("rate_limits")
    if isinstance(limits, dict):
        for label, key in (("5h", "five_hour"), ("Weekly", "seven_day")):
            w = _window(limits.get(key), 0.0)
            if w:
                parts.append(f"| {label} {round(w['used_percentage'])}%")
    return " ".join(parts)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage_statusline.py <cache-path>", file=sys.stderr)
        return 2
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    write_cache(Path(sys.argv[1]).expanduser(), payload)
    print(line(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
