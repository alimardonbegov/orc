"""Account limits: merging sources (orc/usage.py), Claude probing, the statusline collector and the API."""
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

import pytest

from orc import inbox, usage
from orc.hooks import usage_statusline

HOUR = 3600


def statusline_cache(path, five=42, seven=15, updated_at=None, model="Claude Sonnet 5",
                     five_resets=None, seven_resets=None):
    """A cache in the OLD format (a window without measured_at/source): this is how it sits after an update."""
    now = time.time()
    path.write_text(json.dumps({
        "model": model,
        "five_hour": None if five is None else {
            "used_percentage": five, "resets_at": now + HOUR if five_resets is None else five_resets},
        "seven_day": None if seven is None else {
            "used_percentage": seven, "resets_at": now + 5 * HOUR if seven_resets is None else seven_resets},
        "updated_at": now if updated_at is None else updated_at,
    }))
    return path


def iso(epoch):
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()


def claude_json(path, five=7, seven=28, fetched_at=None, five_resets=None, seven_resets=None):
    """A Claude Code snapshot. Reset times default to the same as the cache's: in real life the sources
    talk about ONE and the same window, and differ only in percentage and freshness."""
    now = time.time()
    path.write_text(json.dumps({
        "cachedUsageUtilization": {
            "fetchedAtMs": (now if fetched_at is None else fetched_at) * 1000,
            "utilization": {
                "five_hour": {"utilization": five,
                              "resets_at": iso(now + HOUR) if five_resets is None else five_resets},
                "seven_day": {"utilization": seven,
                              "resets_at": iso(now + 5 * HOUR) if seven_resets is None else seven_resets},
            },
        },
    }))
    return path


def rate_limit_line(five=0.89, seven=0.56, five_resets=None, seven_resets=None):
    """A stream-json line in exactly the form `claude -p` prints it."""
    now = time.time()
    return json.dumps({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed",
            "rateLimitType": "five_hour",
            "unifiedWindows": {
                "five_hour": {"utilization": five, "resetsAt": now + HOUR if five_resets is None else five_resets},
                "seven_day": {"utilization": seven, "resetsAt": now + 5 * HOUR if seven_resets is None else seven_resets},
            },
        },
    })


# ---------- reading and merging ----------

def test_read_missing_everything(tmp_path):
    assert usage.read(tmp_path / "nope.json", tmp_path / "also-nope.json") == {
        "available": False, "stale": True, "source": None, "model": None,
        "five_hour": None, "seven_day": None, "absent": [], "updated_at": None,
    }


def test_read_corrupt_file(tmp_path):
    p = tmp_path / "usage-cache.json"
    p.write_text("not json")
    assert usage.read(p)["available"] is False


def test_read_fresh_cache(tmp_path):
    r = usage.read(statusline_cache(tmp_path / "usage-cache.json"))
    assert r["available"] is True and r["stale"] is False and r["source"] == "statusline"
    assert r["model"] == "Claude Sonnet 5"
    assert r["five_hour"]["used_percentage"] == 42
    assert r["seven_day"]["used_percentage"] == 15


def test_read_stale_cache(tmp_path):
    p = statusline_cache(tmp_path / "usage-cache.json", updated_at=time.time() - HOUR)
    assert usage.read(p)["stale"] is True


def test_window_with_passed_reset_is_dropped(tmp_path):
    """A window that has already reset is dropped: the old percentage no longer applies there."""
    p = statusline_cache(tmp_path / "usage-cache.json", five=90, five_resets=time.time() - 60, seven=15)
    r = usage.read(p)
    assert r["five_hour"] is None and r["seven_day"]["used_percentage"] == 15


# ---------- fallback source: ~/.claude.json ----------

def test_read_falls_back_to_claude_json(tmp_path):
    r = usage.read(tmp_path / "nope.json", claude_json(tmp_path / ".claude.json"))
    assert r["available"] is True and r["source"] == "claude_json"
    assert r["five_hour"]["used_percentage"] == 7 and r["seven_day"]["used_percentage"] == 28


def test_claude_json_without_usage_section(tmp_path):
    p = tmp_path / ".claude.json"
    p.write_text(json.dumps({"projects": {}}))
    assert usage.read(tmp_path / "nope.json", p)["available"] is False


def test_sources_merge_per_window(tmp_path):
    """Sources are combined by window: only the weekly one is alive in the snapshot, so we take it from there."""
    cache = statusline_cache(tmp_path / "usage-cache.json", five=42, seven=None)
    snapshot = claude_json(tmp_path / ".claude.json", five=7, seven=28,
                           five_resets="2000-01-01T00:00:00+00:00")
    r = usage.read(cache, snapshot)
    assert r["five_hour"]["used_percentage"] == 42 and r["five_hour"]["source"] == "statusline"
    assert r["seven_day"]["used_percentage"] == 28 and r["seven_day"]["source"] == "claude_json"


def test_empty_source_does_not_beat_source_with_numbers(tmp_path):
    """A fresh but empty snapshot (all windows reset) must not displace a source with numbers."""
    cache = statusline_cache(tmp_path / "usage-cache.json", updated_at=time.time() - 10 * HOUR)
    snapshot = tmp_path / ".claude.json"
    snapshot.write_text(json.dumps({
        "cachedUsageUtilization": {
            "fetchedAtMs": time.time() * 1000,
            "utilization": {
                "five_hour": {"utilization": 7, "resets_at": "2000-01-01T00:00:00+00:00"},
                "seven_day": {"utilization": 28, "resets_at": "2000-01-02T00:00:00+00:00"},
            },
        },
    }))
    assert usage.read(cache, snapshot)["source"] == "statusline"


def test_upgrade_lowers_percent_inside_the_same_window(tmp_path):
    """The main fix: after a subscription upgrade the limit grew, and the same usage became a smaller
    percentage in the SAME window. Previously "the larger percentage wins within a window" kept the board at
    97% for the week even though Claude was already answering 8%."""
    resets = time.time() + 3 * 24 * HOUR
    cache = tmp_path / "usage-cache.json"
    usage.store(cache, {"seven_day": usage.sample(97, resets, time.time() - 12 * HOUR, "probe")})
    usage.store(cache, {"seven_day": usage.sample(8, resets, time.time(), "probe")})
    assert usage.read(cache)["seven_day"]["used_percentage"] == 8


def test_older_snapshot_does_not_beat_newer_probe_in_the_same_window(tmp_path):
    """A ~/.claude.json snapshot two days old (55%) is also an old scale: a fresh probe
    of the same window (8%) must win even though its percentage is smaller."""
    resets = time.time() + 3 * 24 * HOUR
    cache = tmp_path / "usage-cache.json"
    usage.store(cache, {"seven_day": usage.sample(8, resets, time.time(), "probe")})
    snapshot = claude_json(tmp_path / ".claude.json", seven=55, seven_resets=iso(resets),
                           fetched_at=time.time() - 48 * HOUR)
    r = usage.read(cache, snapshot)
    assert r["seven_day"]["used_percentage"] == 8 and r["seven_day"]["source"] == "probe"


def test_new_window_wins_over_higher_percent(tmp_path):
    """But a window with a later reset is a different window, and a small percentage is correct."""
    cache = tmp_path / "usage-cache.json"
    usage.store(cache, {"five_hour": usage.sample(87, time.time() + 60, time.time() - 600, "statusline")})
    usage.store(cache, {"five_hour": usage.sample(3, time.time() + 5 * HOUR, time.time(), "probe")})
    assert usage.read(cache)["five_hour"]["used_percentage"] == 3


def test_subsecond_reset_difference_is_the_same_window(tmp_path):
    """Two sources date the same window differently: `rate_limit_event` in round
    seconds, ~/.claude.json in ISO with microseconds. Because of that fraction of a second a snapshot
    19 hours old beat a fresh probe."""
    resets = time.time() + 5 * HOUR
    cache = tmp_path / "usage-cache.json"
    usage.store(cache, {"seven_day": usage.sample(56, resets, time.time(), "probe")})
    snapshot = claude_json(tmp_path / ".claude.json", seven=28,
                           seven_resets=iso(resets + 0.023), fetched_at=time.time() - 19 * HOUR)
    r = usage.read(cache, snapshot)
    assert r["seven_day"]["used_percentage"] == 56 and r["seven_day"]["source"] == "probe"


def test_probe_without_five_hour_marks_it_absent(tmp_path):
    """A plan without a five-hour limit: `unifiedWindows` carries only the week. Old 5h numbers
    must not hang on the board until their reset: the account simply has no such window."""
    cache = tmp_path / "usage-cache.json"
    usage.store(cache, {"five_hour": usage.sample(40, time.time() + HOUR, time.time() - 600, "probe")})
    line = json.dumps({"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": {
        "seven_day": {"utilization": 0.08, "resetsAt": time.time() + 24 * HOUR}}}})
    found = usage.parse_rate_limit_event(line, time.time())
    assert found["five_hour"]["absent"] is True
    usage.store(cache, found)
    r = usage.read(cache)
    assert r["available"] is True and r["five_hour"] is None and r["absent"] == ["five_hour"]
    assert r["seven_day"]["used_percentage"] == 8 and r["source"] == "probe"


def test_five_hour_comes_back_when_a_newer_sample_has_it(tmp_path):
    """Limits can also come back (the plan was switched back): a fresh probe with the window displaces the marker."""
    cache = tmp_path / "usage-cache.json"
    usage.store(cache, {"five_hour": usage.absent(time.time() - 600, "probe")})
    usage.store(cache, {"five_hour": usage.sample(3, time.time() + 4 * HOUR, time.time(), "probe")})
    r = usage.read(cache)
    assert r["five_hour"]["used_percentage"] == 3 and r["absent"] == []


def test_claude_json_null_window_is_absent(tmp_path):
    p = tmp_path / ".claude.json"
    p.write_text(json.dumps({"cachedUsageUtilization": {"fetchedAtMs": time.time() * 1000, "utilization": {
        "five_hour": None,
        "seven_day": {"utilization": 12, "resets_at": iso(time.time() + 24 * HOUR)},
    }}}))
    r = usage.read(tmp_path / "nope.json", p)
    assert r["five_hour"] is None and r["absent"] == ["five_hour"] and r["seven_day"]["used_percentage"] == 12


def test_store_keeps_model_when_probe_does_not_know_it(tmp_path):
    cache = statusline_cache(tmp_path / "usage-cache.json", model="Opus 5")
    usage.store(cache, {"five_hour": usage.sample(99, time.time() + HOUR, time.time(), "probe")})
    assert usage.read(cache)["model"] == "Opus 5"


# ---------- Claude probing ----------

def test_parse_rate_limit_event_converts_fraction_to_percent():
    windows = usage.parse_rate_limit_event(rate_limit_line(five=0.89, seven=0.56), time.time())
    assert windows["five_hour"]["used_percentage"] == 89
    assert windows["seven_day"]["used_percentage"] == 56
    assert windows["five_hour"]["source"] == "probe"


@pytest.mark.parametrize("line", ["not json", json.dumps({"type": "system"}), "",
                                  json.dumps({"type": "rate_limit_event", "rate_limit_info": {}})])
def test_parse_rate_limit_event_ignores_everything_else(line):
    assert usage.parse_rate_limit_event(line, time.time()) == {}


def test_probe_args_are_cheap_and_leave_no_trace():
    args = usage.probe_args()
    assert "--output-format" in args and "stream-json" in args
    # --verbose is required: without it stream-json is not printed in --print mode
    assert "--verbose" in args
    assert "--no-session-persistence" in args and "--strict-mcp-config" in args
    assert args[args.index("--model") + 1] == usage.PROBE_MODEL


def test_prober_stores_windows_and_respects_cooldown(tmp_path):
    calls = []
    now = [1000.0]

    def runner():
        calls.append(1)
        return usage.parse_rate_limit_event(rate_limit_line(five=0.77), now[0])

    prober = usage.Prober(tmp_path / "usage-cache.json", runner=runner, now=lambda: now[0])
    assert prober.refresh() is True
    assert usage.read(tmp_path / "usage-cache.json")["five_hour"]["used_percentage"] == 77

    # A second question right away is no question: a probe costs a model call.
    assert prober.refresh() is False
    assert len(calls) == 1

    now[0] += usage.PROBE_COOLDOWN_SEC + 1
    assert prober.refresh() is True and len(calls) == 2


def test_manual_refresh_waits_for_a_running_probe(tmp_path):
    """Pressing "refresh" in the middle of a background poll must wait for it, not leave empty-handed."""
    import threading

    started, release = threading.Event(), threading.Event()

    def slow_runner():
        started.set()
        release.wait(5)
        return usage.parse_rate_limit_event(rate_limit_line(five=0.64), time.time())

    calls = []

    def counting_runner():
        calls.append(1)
        return slow_runner()

    cache = tmp_path / "usage-cache.json"
    prober = usage.Prober(cache, runner=counting_runner)
    prober.refresh_async(0)
    assert started.wait(5)

    # The background poll is still running: without waiting, the second request has nothing to catch...
    assert prober.refresh(usage.PROBE_MANUAL_COOLDOWN_SEC) is False
    waited = []
    waiter = threading.Thread(
        target=lambda: waited.append(prober.refresh(usage.PROBE_MANUAL_COOLDOWN_SEC, wait=10)))
    waiter.start()
    release.set()
    waiter.join(10)

    # ...but with waiting it waits for SOMEONE ELSE'S answer: it makes no request of its own to Claude
    # (False), but by the time it returns the fresh numbers are already in the cache, and the endpoint will read them.
    assert waited == [False] and calls == [1]
    assert usage.read(cache)["five_hour"]["used_percentage"] == 64


def test_prober_disabled_never_runs(tmp_path):
    prober = usage.Prober(tmp_path / "c.json", enabled=False, runner=lambda: (_ for _ in ()).throw(AssertionError))
    assert prober.refresh(0) is False
    assert prober.refresh(0, wait=5) is False
    prober.refresh_async(0)


def test_prober_survives_broken_runner(tmp_path):
    prober = usage.Prober(tmp_path / "c.json", runner=lambda: (_ for _ in ()).throw(RuntimeError("no claude")))
    assert prober.refresh(0) is False


def test_run_probe_with_missing_binary(tmp_path):
    assert usage.run_probe(claude_bin=str(tmp_path / "no-such-binary"), timeout=5) == {}


def test_run_probe_reads_event_from_stream(tmp_path):
    """A real Popen, but instead of claude a script that prints the same stream."""
    fake = tmp_path / "fake-claude.py"
    fake.write_text(
        "import sys, time\n"
        "print('{\"type\": \"system\", \"subtype\": \"init\"}', flush=True)\n"
        f"print({rate_limit_line(five=0.42, seven=0.11)!r}, flush=True)\n"
        # After that the real claude keeps printing the model's answer for a long time; the probe does not need it.
        "time.sleep(30)\n"
    )
    launcher = tmp_path / "claude"
    launcher.write_text(f'#!/bin/sh\nexec {sys.executable} {fake} "$@"\n')
    launcher.chmod(0o755)
    started = time.time()
    windows = usage.run_probe(claude_bin=str(launcher), timeout=20)
    assert windows["five_hour"]["used_percentage"] == 42
    assert windows["seven_day"]["used_percentage"] == 11
    # We cut the process right after the event instead of waiting for its end.
    assert time.time() - started < 20


# ---------- statusline collector ----------

def render(out, five=None, seven=None, session="sess-1", five_resets=None, seven_resets=None, model="Opus 5"):
    """One statusline render of a session: exactly what Claude Code hands to the script on stdin."""
    limits = {}
    if five is not None:
        limits["five_hour"] = {"used_percentage": five, "resets_at": five_resets or time.time() + HOUR}
    if seven is not None:
        limits["seven_day"] = {"used_percentage": seven, "resets_at": seven_resets or time.time() + 5 * HOUR}
    usage_statusline.write_cache(out, {"session_id": session, "model": {"display_name": model},
                                       "rate_limits": limits})


def test_statusline_writes_cache_when_session_numbers_change(tmp_path):
    out = tmp_path / "usage-cache.json"
    five_resets, seven_resets = time.time() + HOUR, time.time() + 5 * HOUR
    render(out, five=70, seven=45, five_resets=five_resets, seven_resets=seven_resets)
    render(out, five=71, seven=45, five_resets=five_resets, seven_resets=seven_resets)
    data = json.loads(out.read_text())
    assert data["model"] == "Opus 5"
    assert data["five_hour"]["used_percentage"] == 71 and data["five_hour"]["source"] == "statusline"
    # The session's weekly number did not change: not news, it did not reach the cache
    assert data["seven_day"] is None
    assert time.time() - data["updated_at"] < 5


def test_statusline_first_sighting_of_a_session_is_not_news(tmp_path):
    """The numbers the session was first seen with could have arrived long before us:
    e.g. right after an orchestrator restart an idle session renders old ones."""
    out = tmp_path / "usage-cache.json"
    render(out, five=97)
    assert not out.exists()


def test_idle_session_does_not_overwrite_a_fresher_probe(tmp_path):
    """An idle session renders OLD limits with the current time. Previously such a render
    overwrote fresh numbers ("87% in the terminal, 52% on the board"), now it is not news."""
    out = tmp_path / "usage-cache.json"
    resets = time.time() + HOUR
    render(out, five=52, five_resets=resets, session="idle")
    usage.store(out, {"five_hour": usage.sample(87, resets, time.time(), "probe")})
    for _ in range(3):
        render(out, five=52, five_resets=resets, session="idle")
    assert usage.read(out)["five_hour"]["used_percentage"] == 87


def test_statusline_lowers_a_window_after_upgrade(tmp_path):
    """A change in the session's numbers is a fresh Anthropic response, and the smaller percentage is true here."""
    out = tmp_path / "usage-cache.json"
    resets = time.time() + 5 * HOUR
    usage.store(out, {"seven_day": usage.sample(97, resets, time.time() - 600, "probe")})
    render(out, seven=96, seven_resets=resets)
    render(out, seven=8, seven_resets=resets)
    assert usage.read(out)["seven_day"]["used_percentage"] == 8


def test_statusline_keeps_previous_numbers_when_event_has_no_limits(tmp_path):
    """A session's first renders arrive before Anthropic's response: a placeholder must not overwrite the cache."""
    out = tmp_path / "usage-cache.json"
    out.write_text(json.dumps({"model": "Opus 5", "five_hour": {"used_percentage": 71, "resets_at": 111},
                               "seven_day": None, "updated_at": 1.0}))
    usage_statusline.write_cache(out, {"model": {"display_name": "Opus 5"}})
    assert json.loads(out.read_text())["updated_at"] == 1.0


def test_statusline_without_session_id_writes_nothing(tmp_path):
    out = tmp_path / "usage-cache.json"
    for pct in (10, 20):
        usage_statusline.write_cache(out, {"rate_limits": {
            "five_hour": {"used_percentage": pct, "resets_at": time.time() + HOUR}}})
    assert not out.exists()


def test_statusline_accepts_new_window(tmp_path):
    out = tmp_path / "usage-cache.json"
    render(out, five=87, five_resets=time.time() + 60)
    render(out, five=4, five_resets=time.time() + 5 * HOUR)
    assert json.loads(out.read_text())["five_hour"]["used_percentage"] == 4


def test_statusline_respects_absent_marker_from_probe(tmp_path):
    """The probe said "there is no five-hour window"; a statusline without 5h does not touch the marker."""
    out = tmp_path / "usage-cache.json"
    usage.store(out, {"five_hour": usage.absent(time.time(), "probe"),
                      "seven_day": usage.sample(5, time.time() + 5 * HOUR, time.time() - 60, "probe")})
    render(out, seven=5)
    render(out, seven=6)
    r = usage.read(out)
    assert r["absent"] == ["five_hour"] and r["seven_day"]["used_percentage"] == 6


def test_statusline_script_runs_end_to_end(tmp_path):
    out = tmp_path / "usage-cache.json"
    resets = time.time() + HOUR
    for pct in (70, 71):
        event = json.dumps({
            "session_id": "e2e",
            "model": {"display_name": "Opus 5"},
            "context_window": {"used_percentage": 30},
            "rate_limits": {"five_hour": {"used_percentage": pct, "resets_at": resets}},
        })
        proc = subprocess.run([sys.executable, str(usage.STATUSLINE_SCRIPT), str(out)],
                              input=event, capture_output=True, text=True, timeout=30)
        assert proc.returncode == 0
    assert "5h 71%" in proc.stdout
    assert json.loads(out.read_text())["five_hour"]["used_percentage"] == 71


def test_statusline_survives_garbage_on_stdin(tmp_path):
    proc = subprocess.run([sys.executable, str(usage.STATUSLINE_SCRIPT), str(tmp_path / "c.json")],
                          input="not json", capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0 and proc.stdout.strip()


# ---------- session settings ----------

def test_session_settings_carry_statusline_and_hooks(tmp_path):
    cache = tmp_path / "usage-cache.json"
    settings = json.loads(inbox.hook_settings_json(extra=usage.statusline_settings(cache)))
    assert str(cache) in settings["statusLine"]["command"]
    assert "usage_statusline.py" in settings["statusLine"]["command"]
    # The statusline does not cancel message delivery
    assert settings["hooks"]["PostToolUse"] and settings["hooks"]["Stop"]


def test_extra_cannot_replace_delivery_hooks(tmp_path):
    settings = json.loads(inbox.hook_settings_json(extra={"hooks": {"PostToolUse": []}}))
    assert settings["hooks"]["PostToolUse"]


def test_cache_path_defaults_into_data_dir(tmp_path):
    """Its own file, not the shared ~/.claude/usage-cache.json: that one overwrites the user's statusline."""
    from orc.config import Settings
    assert Settings(data_dir=tmp_path).usage_cache_path == tmp_path / "usage-cache.json"


# ---------- endpoints ----------

def test_api_usage_reads_configured_paths(client, dispatcher):
    r = client.get("/api/usage")
    assert r.status_code == 200 and r.json()["available"] is False

    claude_json(dispatcher.settings.claude_json_path, five=7)
    body = client.get("/api/usage").json()
    assert body["source"] == "claude_json" and body["five_hour"]["used_percentage"] == 7

    # The orchestrator cache speaks about the same window but with a larger percentage, so it is fresher.
    statusline_cache(dispatcher.settings.usage_cache_path, five=10)
    body = client.get("/api/usage").json()
    assert body["source"] == "statusline" and body["five_hour"]["used_percentage"] == 10


def test_api_usage_refresh_asks_claude(client, dispatcher):
    """The "refresh" button is a trip to Claude, not a re-read of the file."""
    now = time.time()
    client.app.state.prober = usage.Prober(
        dispatcher.settings.usage_cache_path,
        runner=lambda: usage.parse_rate_limit_event(rate_limit_line(five=0.93), now),
    )
    body = client.post("/api/usage/refresh").json()
    assert body["five_hour"]["used_percentage"] == 93 and body["source"] == "probe"


def test_api_usage_triggers_probe_when_stale(client, dispatcher):
    """Stale numbers are refreshed by the server itself, without making the person press the button."""
    asked = []

    class Spy(usage.Prober):
        def refresh_async(self, min_interval=usage.PROBE_COOLDOWN_SEC):
            asked.append(min_interval)

    client.app.state.prober = Spy(dispatcher.settings.usage_cache_path)
    statusline_cache(dispatcher.settings.usage_cache_path, updated_at=time.time() - 10 * HOUR)
    assert client.get("/api/usage").json()["stale"] is True
    assert asked

    asked.clear()
    statusline_cache(dispatcher.settings.usage_cache_path)
    assert client.get("/api/usage").json()["stale"] is False
    assert not asked
