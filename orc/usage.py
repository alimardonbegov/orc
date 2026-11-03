"""Claude Code account limits (the 5-hour and weekly windows): the orchestrator's own numbers.

Claude Code has no dedicated "ask for limits" command, but `claude -p --output-format
stream-json` prints a `rate_limit_event` with both windows during ANY request.
That is where the own logic comes from: `Prober` runs a cheap probe request, reads the stream
until the first such event and kills the process. It does not depend on the terminal statusline
at all.

There are still three sources, and they are combined PER WINDOW, not as a whole:

1. `probe`: polling Claude from the orchestrator. Accurate at the moment of the question, but costs
   one model call, so it is invoked by a button and when the numbers are stale, no more often than
   PROBE_COOLDOWN_SEC.
2. `statusline`: the statusline of sessions the orchestrator launches itself (see
   `statusline_settings` and orc/hooks/usage_statusline.py). While the board is running, the numbers
   are updated for free.
3. `claude_json`: a snapshot of `cachedUsageUtilization` from ~/.claude.json. Claude Code itself
   writes it, but rarely (hours), so it is "something", not a source.

Everything converges into a single cache file owned by the orchestrator (settings.usage_cache_path,
data/usage-cache.json by default). We no longer touch the shared `~/.claude/usage-cache.json`:
the user's `~/.claude/statusline.sh` writes it too, and on a render without `rate_limits` it puts
a dummy there with a fresh time, which is why the board used to "reset" to old numbers.

The merge rule is per window, not per source: the latest MEASUREMENT wins, in either direction.
Previously within one window the larger percentage won ("usage only grows"), but that is wrong:
after a subscription upgrade the limit grows, and the same usage becomes a smaller percentage in the
same window. The old rule kept 97% of the week on the board while Claude was already answering 8%.

Protection against stale numbers now lives where they are born, in the statusline
(orc/hooks/usage_statusline.py): an idle session renders OLD limits with the current time, so only
a CHANGE of numbers in a session reaches the cache, that is, a genuinely new Anthropic response.
This way `measured_at` of all three sources means the measurement time, and comparing them by it
is fair. That is what cures "87% in the terminal, 52% on the board".

A window may be absent: on some plans (Ultra) there is no five-hour limit. A full snapshot
(the probe and ~/.claude.json) puts an `absent` mark with a measurement time for such a window,
and it takes part in the merge on a par with numbers: old 5h numbers do not hang on the board until their reset.
"""
from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

log = logging.getLogger("orc.usage")

# If no source has reported for longer than this, we show the numbers but mark them stale.
STALE_AFTER_SEC = 15 * 60
# A probe is a real model request, so it is not free: we do not ask more often than this even
# with the board continuously open.
PROBE_COOLDOWN_SEC = 5 * 60
# The "refresh" button may ask earlier, but may not create a queue of probes.
PROBE_MANUAL_COOLDOWN_SEC = 20
PROBE_TIMEOUT_SEC = 120
# How long a manual request is ready to wait for an ALREADY RUNNING probe. Waiting matters more than
# answering fast: otherwise pressing "refresh" in the middle of a background poll would return
# exactly the old numbers that made the user press the button.
PROBE_WAIT_SEC = 30
# The cheapest model: account limits are shared, and it does not matter who exactly answered "ok".
PROBE_MODEL = "haiku"

WINDOWS = ("five_hour", "seven_day")
# The precision at which we consider two sources to talk about the SAME window. Window boundaries are
# hours apart, but each source rounds the reset time its own way: in `rate_limit_event` it is
# whole seconds, in ~/.claude.json it is ISO with microseconds. Without a tolerance, a snapshot 19 hours
# old won over a fresh probe on a 0.02 second difference.
WINDOW_GRANULARITY_SEC = 60

STATUSLINE_SCRIPT = Path(__file__).parent / "hooks" / "usage_statusline.py"

_EMPTY = {
    "available": False, "stale": True, "source": None, "model": None,
    "five_hour": None, "seven_day": None, "absent": [], "updated_at": None,
}


def statusline_settings(cache_path: Path, python: str | None = None) -> dict:
    """A piece of `claude --settings`: a statusline that puts the session limits into the cache.

    It overrides the user's statusline only inside orchestrator sessions, which are background ones:
    nobody sees their line in a terminal (except with `claude attach`, which is why the script
    still prints a meaningful line).
    """
    # The paths go into a shell string, and a space in any of them (say "~/Projects/my project")
    # would silently turn the command into garbage, hence the quoting.
    command = shlex.join([python or sys.executable, str(STATUSLINE_SCRIPT), str(cache_path)])
    return {"statusLine": {"type": "command", "command": command, "padding": 0}}


# ---------------------------------------------------------------- window samples


def _num(value: object) -> float | None:
    """A number or nothing. bool is also an int, and we do not want `True` as a percentage."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def sample(pct: object, resets_at: object, measured_at: object, source: str) -> dict | None:
    """One window sample: the percentage, reset time, measurement time and who brought it.

    `measured_at` is specifically the time of the MEASUREMENT, not of the file write. The difference is
    fundamental: the statusline renders constantly, but the limits in it are updated only together with
    an Anthropic response, and confusing the two is exactly the mistake that made the numbers "lag".
    """
    value = _num(pct)
    if value is None:
        return None
    return {
        "used_percentage": max(0.0, min(100.0, value)),
        "resets_at": _num(resets_at),
        "measured_at": _num(measured_at),
        "source": source,
    }


def absent(measured_at: object, source: str) -> dict:
    """A mark saying "the account has no such window", with a measurement time so it has something to compete with.

    A separate entry rather than plain None: None means "we don't know", and then the old window probe
    honestly lives until its reset. And "absent" is news that displaces it.
    """
    return {"absent": True, "used_percentage": None, "resets_at": None,
            "measured_at": _num(measured_at), "source": source}


def window_key(resets_at: float | None) -> float:
    """The rounded reset time: "which window this is". A small difference in seconds does not make
    the window different, otherwise a source with a more precise time would always beat a fresher one."""
    if resets_at is None:
        return 0.0
    return round(resets_at / WINDOW_GRANULARITY_SEC)


def best(samples: list[dict | None], now: float) -> dict | None:
    """The best window sample out of several: the latest measurement.

    A sample whose reset time has already passed is discarded: the counter has been reset and
    refilled since then, and how much is unknown from the snapshot. Showing the old percentage as
    the current one would be a lie in the most dangerous direction ("plenty left").
    """
    live = [s for s in samples
            if s and (s.get("absent") or s["resets_at"] is None or s["resets_at"] > now)]
    if not live:
        return None
    # A measurement without a time loses to any dated one. With equal times, the later window
    # wins, then the larger percentage: it is the same response retold by two sources.
    return max(live, key=lambda s: (s["measured_at"] or 0, window_key(s["resets_at"]),
                                    s["used_percentage"] or 0))


def merge(previous: dict, incoming: dict, now: float) -> dict:
    """Merge new samples with what is already in the cache, using the `best` rule."""
    merged: dict = {}
    for key in WINDOWS:
        merged[key] = best([previous.get(key), incoming.get(key)], now)
    return merged


# ---------------------------------------------------------------- orchestrator cache


def _load_json(path: Path | None) -> dict | None:
    """A foreign or own file, it makes no difference: absence and corruption are a normal state of the machine."""
    if path is None:
        return None
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def cached_samples(raw: dict) -> tuple[dict, str | None]:
    """Cache file → samples per window and the model.

    The old format (a window without `measured_at` and `source`) is read too: after an orchestrator
    upgrade that is exactly what lies on disk, and there is no reason to lose the numbers because of it.
    """
    fallback_at = _num(raw.get("updated_at"))
    out: dict = {}
    for key in WINDOWS:
        item = raw.get(key)
        if not isinstance(item, dict):
            continue
        source = item.get("source") if isinstance(item.get("source"), str) else "statusline"
        if item.get("absent") is True:
            out[key] = absent(item.get("measured_at", fallback_at), source)
            continue
        out[key] = sample(
            item.get("used_percentage"),
            item.get("resets_at"),
            item.get("measured_at", fallback_at),
            source,
        )
    model = raw.get("model")
    return {k: v for k, v in out.items() if v}, model if isinstance(model, str) else None


def write_cache(path: Path, windows: dict, model: str | None, now: float) -> None:
    """Atomically put samples into the cache. A reader never sees half a file."""
    data = {"model": model, "updated_at": now}
    for key in WINDOWS:
        data[key] = windows.get(key)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        log.warning("could not write the limits cache %s", path, exc_info=True)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def store(cache_path: Path, windows: dict, model: str | None = None, now: float | None = None) -> None:
    """Add samples to the orchestrator cache without overwriting what is already there with something worse."""
    at = time.time() if now is None else now
    raw = _load_json(cache_path) or {}
    previous, previous_model = cached_samples(raw)
    write_cache(cache_path, merge(previous, windows, at), model or previous_model, at)


# ---------------------------------------------------------------- fallback source


def _epoch(iso: object) -> float | None:
    """ISO time from ~/.claude.json → epoch. The format is foreign, so any slip is simply None."""
    if not isinstance(iso, str):
        return None
    try:
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return None


def claude_json_samples(path: Path | None) -> dict:
    """The `cachedUsageUtilization` snapshot from ~/.claude.json → samples per window.

    Here `utilization` is already in percent (28 = 28%), unlike the `rate_limit_event` event,
    where the same value arrives as a fraction (0.28). Two scales in two places are easy to forget about.
    """
    raw = _load_json(path)
    cached = raw.get("cachedUsageUtilization") if raw else None
    if not isinstance(cached, dict):
        return {}
    util = cached.get("utilization")
    if not isinstance(util, dict):
        return {}
    fetched = _num(cached.get("fetchedAtMs"))
    measured_at = fetched / 1000 if fetched is not None else None
    out = {}
    for key in WINDOWS:
        item = util.get(key)
        if key in util and item is None:
            # The key is there but the window is not: this is how the snapshot says "this plan has no such limit"
            out[key] = absent(measured_at, "claude_json")
            continue
        if not isinstance(item, dict):
            continue
        out[key] = sample(item.get("utilization"), _epoch(item.get("resets_at")), measured_at, "claude_json")
    return {k: v for k, v in out.items() if v}


# ---------------------------------------------------------------- polling Claude


def probe_args(model: str = PROBE_MODEL) -> list[str]:
    """Arguments of the probe request: a minimal conversation for the sake of one service event.

    Everything extra is switched off: a probe must neither cost extra nor leave traces: its own
    system prompt instead of the default one, a single turn, no MCP, hooks or transcript.
    """
    return [
        "-p", "ok",
        "--model", model,
        # stream-json in --print mode requires --verbose, otherwise the CLI refuses to print the stream.
        "--output-format", "stream-json", "--verbose",
        "--max-turns", "1",
        "--no-session-persistence",
        # Without --mcp-config this flag means "no MCP servers at all".
        "--strict-mcp-config",
        "--system-prompt", "Reply with a single word: ok",
        "--settings", json.dumps({"disableAllHooks": True}),
    ]


def _percent(value: object) -> float | None:
    """A fraction from `unifiedWindows` → percent. 0.89 is 89%, and 1.0 is 100%."""
    raw = _num(value)
    if raw is None:
        return None
    return round(raw * 100, 1) if raw <= 1 else raw


def parse_rate_limit_event(line: str, now: float) -> dict:
    """A stream-json line → window samples. A different event or garbage gives an empty dict."""
    try:
        obj = json.loads(line)
    except ValueError:
        return {}
    if not isinstance(obj, dict) or obj.get("type") != "rate_limit_event":
        return {}
    info = obj.get("rate_limit_info")
    windows = info.get("unifiedWindows") if isinstance(info, dict) else None
    if not isinstance(windows, dict):
        return {}
    out = {}
    for key in WINDOWS:
        item = windows.get(key)
        if not isinstance(item, dict):
            continue
        out[key] = sample(_percent(item.get("utilization")), item.get("resetsAt"), now, "probe")
    out = {k: v for k, v in out.items() if v}
    if not out:
        return {}
    # `unifiedWindows` is the full list of account windows. A window missing from it is not "unknown"
    # but absent: this is what, for example, a plan without a five-hour limit looks like.
    for key in WINDOWS:
        out.setdefault(key, absent(now, "probe"))
    return out


def run_probe(claude_bin: str = "claude", cwd: Path | None = None,
              timeout: float = PROBE_TIMEOUT_SEC, now: float | None = None) -> dict:
    """Ask Claude for the current limits. An empty dict means it did not work, and that is no big deal.

    We kill the process right after the needed event: we do not need the model's answer, and
    output tokens cost money.
    """
    at = time.time() if now is None else now
    try:
        proc = subprocess.Popen(
            [claude_bin, *probe_args()],
            cwd=str(cwd) if cwd else None,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True,
        )
    except OSError:
        log.warning("could not start the limits probe (%s)", claude_bin, exc_info=True)
        return {}
    # A timer rather than communicate(timeout=): we read the stream line by line and cut it off midway.
    killer = threading.Timer(timeout, proc.kill)
    killer.start()
    try:
        for line in proc.stdout or ():
            found = parse_rate_limit_event(line, at)
            if found:
                return found
        return {}
    finally:
        killer.cancel()
        proc.kill()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        if proc.stdout:
            proc.stdout.close()


class Prober:
    """Polling Claude for limits and putting the result into the orchestrator cache.

    There is one per application: parallel probes are pointless (the answer is the same) and cost
    extra model calls, so a second request simply leaves empty-handed. `runner` is replaced in
    tests, otherwise every run would call the real `claude`.
    """

    def __init__(self, cache_path: Path, claude_bin: str = "claude", cwd: Path | None = None,
                 enabled: bool = True, runner: Callable[[], dict] | None = None,
                 now: Callable[[], float] = time.time) -> None:
        self.cache_path = Path(cache_path)
        self.claude_bin = claude_bin
        self.cwd = cwd
        self.enabled = enabled
        self.now = now
        self._runner = runner or (lambda: run_probe(self.claude_bin, self.cwd, now=self.now()))
        self._lock = threading.Lock()
        self._last_attempt = 0.0

    def refresh(self, min_interval: float = PROBE_COOLDOWN_SEC, wait: float = 0.0) -> bool:
        """Ask for the limits and put them into the cache. False means we did not ask or it failed.

        The lock is held for the whole probe, not only at entry: two simultaneous questions to
        Claude are pointless. The one that arrives second either leaves immediately (wait=0, a background
        poll) or waits for the other's answer and gets it from the cache; both are better than
        an extra request of its own.
        """
        if not self.enabled:
            return False
        acquired = self._lock.acquire(True, wait) if wait > 0 else self._lock.acquire(False)
        if not acquired:
            return False
        try:
            if self.now() - self._last_attempt < min_interval:
                return False
            self._last_attempt = self.now()
            windows = self._runner()
            if windows:
                store(self.cache_path, windows, now=self.now())
            return bool(windows)
        except Exception:
            log.warning("limits probe crashed", exc_info=True)
            return False
        finally:
            self._lock.release()

    def refresh_async(self, min_interval: float = PROBE_COOLDOWN_SEC) -> None:
        """The same, but without making the board request wait several seconds."""
        if not self.enabled:
            return
        threading.Thread(target=self.refresh, args=(min_interval,), daemon=True,
                         name="orc-usage-probe").start()


# ---------------------------------------------------------------- reading


def read(cache_path: Path, claude_json_path: Path | None = None) -> dict:
    """The latest known limits: the best sample of each window across all sources.

    Sources are combined per window rather than picking a single "freshest" one: an empty but
    fresh snapshot used to displace a source in which the numbers were still present.
    """
    now = time.time()
    raw = _load_json(cache_path) or {}
    cached, model = cached_samples(raw)
    snapshot = claude_json_samples(claude_json_path)

    merged = {key: best([cached.get(key), snapshot.get(key)], now) for key in WINDOWS}
    gone = [key for key in WINDOWS if merged[key] and merged[key].get("absent")]
    windows = {key: (None if key in gone else merged[key]) for key in WINDOWS}
    live = [w for w in windows.values() if w]
    if not live:
        return dict(_EMPTY, absent=gone)
    measured = [w["measured_at"] for w in merged.values() if w and w["measured_at"] is not None]
    updated_at = max(measured) if measured else None
    # We show the source of the five-hour window: that is the one people look at first.
    leader = windows["five_hour"] or windows["seven_day"]
    return {
        "available": True,
        "stale": updated_at is None or (now - updated_at) > STALE_AFTER_SEC,
        "source": leader["source"],
        "model": model,
        "five_hour": windows["five_hour"],
        "seven_day": windows["seven_day"],
        # Windows the account does not have at all (as opposed to "not known yet"): the board does not draw them.
        "absent": gone,
        "updated_at": updated_at,
    }
