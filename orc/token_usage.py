"""Task token usage from Claude Code transcripts: the main session plus subagents, deduplicated.

There is a single source of truth, the session transcript `~/.claude/projects/<slug>/<session_id>.jsonl`
(the daemon stores its path in `state.json`, see `ClaudeCli.read_state`). Three facts about its
format explain why the module is built this way (verified against Claude Code 2.1.278):

1. One model message is written as SEVERAL `type: "assistant"` lines (block streaming), and each
   of them carries `message.usage`. A naive sum over lines doubles the usage, so we count per
   `message.id`, taking the maximum of each counter among the lines with that id.
2. Subagents (Task/Agent tool) write to separate files `<session_id>/subagents/agent-<id>.jsonl`
   next to the transcript, and their type and description go to `agent-<id>.meta.json`. They
   have their own model.
3. Resuming a session creates a new file with a copy of the old messages, so a task is counted
   across all its sessions at once, with a shared set of seen `message.id` values.

This module only reads files and does arithmetic: no DB, no dispatcher. The result format is the
dict returned by collect().
"""
from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

# Token counters: our key → key in the Anthropic API `message.usage`
COUNTER_KEYS = {
    "input": "input_tokens",
    "cache_creation": "cache_creation_input_tokens",
    "cache_read": "cache_read_input_tokens",
    "output": "output_tokens",
}
EMPTY_COUNTERS = {key: 0 for key in COUNTER_KEYS}
# The part of `cache_creation` written with a one-hour TTL (`usage.cache_creation.ephemeral_1h_input_tokens`).
# Not a fifth counter but a refinement of the fourth: it is not included in the token total and
# only matters for pricing: an hour costs ×2 of input, five minutes ×1.25. It lives only in the
# per-model breakdown.
CACHE_1H_KEY = "cache_creation_1h"
UNKNOWN_MODEL = "unknown"
# Changes together with the price table below: on startup it is used to recompute the estimates of
# already counted tasks (Dispatcher.reprice_usage), otherwise closed tasks would keep the old price forever.
PRICING_VERSION = "2026-11-01"

# $ per 1M tokens (input, output, cache read) — Anthropic API rates from the page
# platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-01). Cache read is a
# separate price, not a common multiplier: for Opus 5.5 and Sonnet 5.5 it is ×0.05 of input, for
# Fable 5.1 it is ×0.025, for the rest the usual ×0.1. The cache read counter is the largest in
# a transcript, so an error in its price distorts the total the most.
# Haiku 5.5 is the price for requests up to 100K tokens (above that $0.50/$2.50): the per-model
# breakdown stores sums, not the size of each request, so long Haiku requests are slightly underestimated.
MODEL_PRICES_PER_MTOK: dict[str, tuple[float, float, float]] = {
    "claude-fable-5-1": (10.0, 50.0, 0.25),
    "claude-mythos-5-1": (10.0, 50.0, 0.25),
    "claude-fable-5": (10.0, 50.0, 1.0),
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-opus-5": (5.0, 25.0, 0.50),
    "claude-opus-4-8": (5.0, 25.0, 0.50),
    "claude-opus-4-7": (5.0, 25.0, 0.50),
    "claude-opus-4-6": (5.0, 25.0, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0, 0.10),
    "claude-sonnet-5": (2.0, 10.0, 0.20),
    "claude-sonnet-4-6": (3.0, 15.0, 0.30),
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
    "claude-haiku-4-5": (1.0, 5.0, 0.10),
}
# Cache write is a multiplier of the input price and depends on the TTL: ×1.25 for 5 minutes, ×2
# for an hour. The transcript provides both parts (`CACHE_1H_KEY`). In old breakdowns that lack the
# part, everything is counted as one-hour: that is how Claude Code writes the cache now, almost
# the whole write volume. The formula was checked against Claude Code's own `costUSD`: a Haiku 5.5
# probe and Opus 5.5 / Sonnet 5.5 sessions match to the cent.
CACHE_WRITE_5M_MULTIPLIER = 1.25
CACHE_WRITE_1H_MULTIPLIER = 2.0
# Suffixes a model carries in transcripts but which are absent from the price table:
# the snapshot date (`claude-haiku-4-5-20251001`) and the long-context marker (`[1m]`).
_DATE_SUFFIX = re.compile(r"-\d{8}$")


def price_key(model: str) -> str:
    """Model name from the transcript → price key: without the snapshot date and context marker."""
    name = model.strip().lower()
    if "[" in name:
        name = name[:name.index("[")]
    return _DATE_SUFFIX.sub("", name)


def _model_cost_usd(model: str, counters: dict[str, int]) -> float | None:
    """Cost of one model's counters. `None` means the model is not in the table (discontinued,
    not added yet or entered manually): such a model's share is skipped in the estimate rather
    than counted as zero, otherwise a task on an unknown model would silently show $0."""
    prices = MODEL_PRICES_PER_MTOK.get(price_key(model))
    if prices is None:
        return None
    input_price, output_price, cache_read_price = prices
    written = counters["cache_creation"]
    hour = counters.get(CACHE_1H_KEY)
    hour = written if not isinstance(hour, int) or isinstance(hour, bool) else min(hour, written)
    return (
        counters["input"] * input_price
        + (written - hour) * input_price * CACHE_WRITE_5M_MULTIPLIER
        + hour * input_price * CACHE_WRITE_1H_MULTIPLIER
        + counters["cache_read"] * cache_read_price
        + counters["output"] * output_price
    ) / 1_000_000


def estimate_cost_usd(models: dict[str, dict]) -> float | None:
    """Estimate of the task cost using our own rates. Unlike `cost_usd` (from Claude Code's
    `cost-state`, written only when a session ends), it is computed from the already collected
    counters at any time, including for a task in progress. `None` if no model in the breakdown
    is in the rate table (nothing to estimate with, as opposed to "costs 0")."""
    total = 0.0
    known = False
    for model, counters in (models or {}).items():
        try:
            cost = _model_cost_usd(model, counters)
        except (AttributeError, KeyError, TypeError, ValueError):
            cost = None  # foreign breakdown format (manual edit, old version): skip it
        if cost is not None:
            total += cost
            known = True
    return round(total, 4) if known else None


@dataclass(frozen=True)
class SessionRef:
    session_id: str | None
    job_id: str | None
    transcript_path: str | None


@dataclass
class _Agent:
    """One agent of one session: the main session (agent_id None) or a subagent."""
    session_id: str | None
    agent_id: str | None
    agent_type: str | None
    description: str | None
    tokens: dict[str, int]
    models: Counter
    messages: int = 0


def _counters(usage: object) -> dict[str, int] | None:
    """The four counters from `message.usage` plus the one-hour share of cache writes (`CACHE_1H_KEY`)."""
    if not isinstance(usage, dict):
        return None
    out = {}
    for key, api_key in COUNTER_KEYS.items():
        value = usage.get(api_key, 0)
        out[key] = value if isinstance(value, int) and not isinstance(value, bool) else 0
    split = usage.get("cache_creation")
    hour = split.get("ephemeral_1h_input_tokens") if isinstance(split, dict) else None
    # No breakdown (old Claude Code): same as in pricing, count everything as one-hour
    out[CACHE_1H_KEY] = hour if isinstance(hour, int) and not isinstance(hour, bool) else out["cache_creation"]
    return out


def _add(into: dict[str, int], counters: dict[str, int]) -> None:
    for key in COUNTER_KEYS:
        into[key] += counters[key]


def _total(counters: dict[str, int]) -> int:
    return sum(counters[key] for key in COUNTER_KEYS)


def session_files(transcript_path: str) -> list[tuple[Path, str | None]]:
    """Files of one session: (path, agent_id). The main transcript first, subagents by name."""
    main = Path(transcript_path)
    files: list[tuple[Path, str | None]] = []
    if main.is_file():
        files.append((main, None))
    sub_dir = main.with_suffix("") / "subagents"
    if sub_dir.is_dir():
        for path in sorted(sub_dir.glob("agent-*.jsonl")):
            files.append((path, path.stem.removeprefix("agent-")))
    return files


def _agent_meta(path: Path) -> tuple[str | None, str | None]:
    """`agent-<id>.meta.json` next to a subagent transcript: the type and description from the Task call."""
    meta_path = path.with_name(path.stem + ".meta.json")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None
    if not isinstance(meta, dict):
        return None, None
    agent_type = meta.get("agentType")
    description = meta.get("description")
    return (agent_type if isinstance(agent_type, str) else None,
            description if isinstance(description, str) else None)


def iter_records(path: Path) -> Iterator[dict]:
    """Transcript lines we care about: model replies with usage and `cost-state`.

    The file is written live, so the last line may be cut off and any line may be a different
    JSON than we expect; such lines are simply skipped. The substring check before `json.loads`
    is not optimization for its own sake: most of the transcript bytes are tool results in
    `user` lines, and there is no need to parse them on every tick.
    """
    try:
        handle = path.open(encoding="utf-8", errors="replace")
    except OSError:
        return
    with handle:
        for line in handle:
            if '"assistant"' not in line and '"cost-state"' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict) and record.get("type") in ("assistant", "cost-state"):
                yield record


def signature(sessions: list[SessionRef]) -> dict[str, int]:
    """Fingerprint of all task files: count and total size. If it matches, there is nothing to re-read."""
    files = 0
    size = 0
    for session in sessions:
        if not session.transcript_path:
            continue
        for path, _agent in session_files(session.transcript_path):
            try:
                size += path.stat().st_size
            except OSError:
                continue
            files += 1
    return {"files": files, "bytes": size}


def collect(sessions: list[SessionRef], now: datetime | None = None) -> dict:
    """Aggregate of the task tokens across all its sessions."""
    seen: dict[str, tuple[_Agent, dict[str, int], str]] = {}   # message.id → (agent, counters, model)
    agents: list[_Agent] = []
    session_totals: list[dict] = []
    cost_usd: float | None = None
    files = 0
    size = 0
    anonymous = 0  # messages without message.id are each counted separately

    for session in sessions:
        session_agents: list[_Agent] = []
        session_cost: float | None = None  # totalCostUSD is a running total, written more than once during a session
        for path, agent_id in session_files(session.transcript_path) if session.transcript_path else []:
            try:
                size += path.stat().st_size
            except OSError:
                pass
            files += 1
            agent_type, description = _agent_meta(path) if agent_id else (None, None)
            agent = _Agent(session.session_id, agent_id, agent_type, description, dict(EMPTY_COUNTERS), Counter())
            session_agents.append(agent)
            for record in iter_records(path):
                if record.get("type") == "cost-state":
                    cost = record.get("totalCostUSD")
                    if isinstance(cost, (int, float)) and not isinstance(cost, bool):
                        # Claude Code writes cost-state several times per session with the same
                        # running totalCostUSD (not a delta), so the records cannot be summed;
                        # take the maximum seen within this session.
                        session_cost = max(session_cost or 0.0, float(cost))
                    continue
                message = record.get("message")
                if not isinstance(message, dict):
                    continue
                counters = _counters(message.get("usage"))
                if counters is None or _total(counters) == 0:
                    # Zero records are Claude Code service messages (model `<synthetic>`:
                    # interrupts, API errors). They carry no tokens, and in the per-model
                    # breakdown and the reply counter they would be noise.
                    continue
                model = message.get("model") if isinstance(message.get("model"), str) else UNKNOWN_MODEL
                message_id = message.get("id")
                if not isinstance(message_id, str) or not message_id:
                    anonymous += 1
                    message_id = f"\0anon{anonymous}"
                known = seen.get(message_id)
                if known is None:
                    seen[message_id] = (agent, counters, model)
                    continue
                # Another chunk of the same message: raise the counters to the maximum. The agent
                # and model stay from the first occurrence; in a session copy they are the same.
                owner, best, _model = known
                for key in (*COUNTER_KEYS, CACHE_1H_KEY):
                    if counters[key] > best[key]:
                        best[key] = counters[key]
        agents.extend(session_agents)
        session_totals.append({"session_id": session.session_id, "job_id": session.job_id, "agents": session_agents})
        if session_cost is not None:
            cost_usd = (cost_usd or 0.0) + session_cost

    total = dict(EMPTY_COUNTERS)
    models: dict[str, dict] = {}
    for agent, counters, model in seen.values():
        _add(total, counters)
        _add(agent.tokens, counters)
        agent.messages += 1
        agent.models[model] += 1
        bucket = models.setdefault(model, {**EMPTY_COUNTERS, CACHE_1H_KEY: 0, "messages": 0})
        _add(bucket, counters)
        bucket[CACHE_1H_KEY] += counters[CACHE_1H_KEY]
        bucket["messages"] += 1

    stamp = (now or datetime.now(timezone.utc)).replace(microsecond=0).isoformat()
    return {
        "total": total,
        "total_tokens": _total(total),
        "models": models,
        "agents": [
            {
                "session_id": a.session_id,
                "agent_id": a.agent_id,
                "agent_type": a.agent_type,
                "description": a.description,
                "model": a.models.most_common(1)[0][0] if a.models else None,
                "tokens": a.tokens,
                "total_tokens": _total(a.tokens),
                "messages": a.messages,
            }
            for a in agents
        ],
        "sessions": [
            {
                "session_id": s["session_id"],
                "job_id": s["job_id"],
                "total_tokens": sum(_total(a.tokens) for a in s["agents"]),
            }
            for s in session_totals
        ],
        "cost_usd": cost_usd,
        "cost_usd_estimated": estimate_cost_usd(models),
        "pricing": PRICING_VERSION,
        "scanned_at": stamp,
        "scan": {"files": files, "bytes": size},
    }
