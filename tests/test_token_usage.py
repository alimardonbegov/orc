import json

from orc.token_usage import EMPTY_COUNTERS, SessionRef, collect, estimate_cost_usd, session_files, signature


def _usage(inp=0, create=0, read=0, out=0):
    return {
        "input_tokens": inp,
        "cache_creation_input_tokens": create,
        "cache_read_input_tokens": read,
        "output_tokens": out,
    }


def _assistant(msg_id, model, usage, agent_id=None, session_id="s1"):
    line = {
        "type": "assistant",
        "sessionId": session_id,
        "message": {"id": msg_id, "model": model, "role": "assistant", "usage": usage, "content": []},
    }
    if agent_id:
        line["agentId"] = agent_id
        line["isSidechain"] = True
    return line


def _write(path, lines):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in lines), encoding="utf-8")


def test_collect_dedups_streamed_chunks_of_one_message(tmp_path):
    # One message is written as several lines (streaming): the usage of early chunks may be
    # partial, of late ones full. We take the maximum of each field, not the sum of lines.
    path = tmp_path / "s1.jsonl"
    _write(path, [
        {"type": "user", "message": {"role": "user", "content": "hello"}},
        _assistant("m1", "claude-opus-5", _usage(1, 100, 1000, 10)),
        _assistant("m1", "claude-opus-5", _usage(1, 100, 1000, 40)),
        _assistant("m2", "claude-opus-5", _usage(2, 0, 2000, 5)),
    ])
    usage = collect([SessionRef("s1", "job1", str(path))])
    assert usage["total"] == {"input": 3, "cache_creation": 100, "cache_read": 3000, "output": 45}
    assert usage["total_tokens"] == 3148
    assert usage["models"]["claude-opus-5"]["messages"] == 2
    assert usage["sessions"] == [{"session_id": "s1", "job_id": "job1", "total_tokens": 3148}]
    assert len(usage["agents"]) == 1
    main = usage["agents"][0]
    assert main["agent_id"] is None and main["agent_type"] is None and main["model"] == "claude-opus-5"
    assert main["total_tokens"] == 3148 and main["messages"] == 2
    assert usage["cost_usd"] is None
    assert usage["scan"] == {"files": 1, "bytes": path.stat().st_size}
    assert usage["scanned_at"]


def test_collect_includes_subagents_with_meta_and_their_own_models(tmp_path):
    main = tmp_path / "s1.jsonl"
    _write(main, [_assistant("m1", "claude-opus-5", _usage(out=10))])
    sub_dir = tmp_path / "s1" / "subagents"
    _write(sub_dir / "agent-aaa.jsonl", [
        _assistant("a1", "claude-sonnet-5", _usage(read=500, out=20), agent_id="aaa"),
        _assistant("a2", "claude-sonnet-5", _usage(read=600, out=30), agent_id="aaa"),
    ])
    (sub_dir / "agent-aaa.meta.json").write_text(json.dumps({"agentType": "Explore", "description": "Find X"}))
    _write(sub_dir / "agent-bbb.jsonl", [_assistant("b1", "claude-haiku-4-5", _usage(out=1), agent_id="bbb")])
    # there is no meta for bbb: the subagent is still counted, just without a type

    usage = collect([SessionRef("s1", "job1", str(main))])
    assert usage["total"]["output"] == 61 and usage["total"]["cache_read"] == 1100
    assert set(usage["models"]) == {"claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"}
    assert usage["models"]["claude-sonnet-5"] == {"input": 0, "cache_creation": 0, "cache_read": 1100, "output": 50,
                                                  "cache_creation_1h": 0, "messages": 2}
    agents = {a["agent_id"]: a for a in usage["agents"]}
    assert set(agents) == {None, "aaa", "bbb"}
    assert agents["aaa"]["agent_type"] == "Explore" and agents["aaa"]["description"] == "Find X"
    assert agents["aaa"]["model"] == "claude-sonnet-5" and agents["aaa"]["total_tokens"] == 1150
    assert agents["bbb"]["agent_type"] is None and agents["bbb"]["total_tokens"] == 1
    # The main session comes first, subagents in file-name order
    assert [a["agent_id"] for a in usage["agents"]] == [None, "aaa", "bbb"]
    assert usage["scan"]["files"] == 3


def test_collect_dedups_messages_copied_into_resumed_session(tmp_path):
    # A resume creates a new session file with a copy of the old messages: the same message.id
    # must not be counted twice, while new ones must.
    old = tmp_path / "s1.jsonl"
    new = tmp_path / "s2.jsonl"
    _write(old, [_assistant("m1", "claude-opus-5", _usage(out=10))])
    _write(new, [
        _assistant("m1", "claude-opus-5", _usage(out=10), session_id="s2"),
        _assistant("m2", "claude-opus-5", _usage(out=7), session_id="s2"),
    ])
    usage = collect([SessionRef("s1", "job1", str(old)), SessionRef("s2", "job2", str(new))])
    assert usage["total"]["output"] == 17
    assert [s["total_tokens"] for s in usage["sessions"]] == [10, 7]
    assert len(usage["agents"]) == 2 and [a["session_id"] for a in usage["agents"]] == ["s1", "s2"]


def test_collect_skips_broken_lines_missing_files_and_messages_without_usage(tmp_path):
    path = tmp_path / "s1.jsonl"
    path.write_text(
        '{"type": "assistant", "message": {"id": "m1", "model": "claude-opus-5", "usage": '
        + json.dumps(_usage(out=3)) + "}}\n"
        + "{not json\n"
        + json.dumps({"type": "assistant", "message": {"id": "m2", "model": "claude-opus-5"}}) + "\n"
        + json.dumps({"type": "assistant", "message": {"id": "m3", "model": "claude-opus-5", "usage": "x"}}) + "\n"
        + '{"type": "assistant", "message": {"id": "m4", "model": "claude-opus-5", "usage": '
        + json.dumps(_usage(out=4))[:-1] + "\n",  # a truncated line: the file is being written live
        encoding="utf-8",
    )
    usage = collect([
        SessionRef("s1", "job1", str(path)),
        SessionRef("s0", "job0", str(tmp_path / "nope.jsonl")),
        SessionRef("s9", "job9", None),
    ])
    assert usage["total"]["output"] == 3 and usage["total_tokens"] == 3
    assert [s["total_tokens"] for s in usage["sessions"]] == [3, 0, 0]
    assert usage["scan"]["files"] == 1


def test_collect_counts_messages_without_id_separately_and_unknown_model(tmp_path):
    path = tmp_path / "s1.jsonl"
    _write(path, [
        {"type": "assistant", "message": {"usage": _usage(out=1)}},
        {"type": "assistant", "message": {"usage": _usage(out=2)}},
    ])
    usage = collect([SessionRef("s1", "job1", str(path))])
    assert usage["total"]["output"] == 3
    assert usage["models"] == {"unknown": {**EMPTY_COUNTERS, "output": 3, "cache_creation_1h": 0, "messages": 2}}


def test_collect_ignores_zero_usage_synthetic_messages(tmp_path):
    # Claude Code writes service replies with the <synthetic> model and zero usage
    path = tmp_path / "s1.jsonl"
    _write(path, [
        _assistant("m1", "claude-opus-5", _usage(out=3)),
        _assistant("syn1", "<synthetic>", _usage()),
    ])
    usage = collect([SessionRef("s1", "job1", str(path))])
    assert list(usage["models"]) == ["claude-opus-5"]
    assert usage["agents"][0]["messages"] == 1


def test_collect_sums_cost_state_across_sessions(tmp_path):
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    _write(a, [_assistant("m1", "claude-opus-5", _usage(out=1)), {"type": "cost-state", "totalCostUSD": 1.5}])
    _write(b, [_assistant("m2", "claude-opus-5", _usage(out=1)), {"type": "cost-state", "totalCostUSD": "garbage"}])
    usage = collect([SessionRef("a", "j1", str(a)), SessionRef("b", "j2", str(b))])
    assert usage["cost_usd"] == 1.5


def test_collect_takes_max_cost_state_within_one_session_not_sum(tmp_path):
    # totalCostUSD is the session's running total, Claude Code writes cost-state several times
    # during the work (e.g. at the end of the main session and once more after an append). Summing
    # these entries is not allowed, otherwise the task cost is doubled/tripled out of nowhere.
    path = tmp_path / "a.jsonl"
    _write(path, [
        _assistant("m1", "claude-opus-5", _usage(out=1)),
        {"type": "cost-state", "totalCostUSD": 3.0},
        {"type": "cost-state", "totalCostUSD": 7.5},
    ])
    usage = collect([SessionRef("a", "j1", str(path))])
    assert usage["cost_usd"] == 7.5


def test_collect_sums_max_cost_per_session_across_resumed_sessions(tmp_path):
    # Different sessions of a task (resume, conflict session) remain summable with each other; only
    # repeated entries within one session must not add up.
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    _write(a, [
        _assistant("m1", "claude-opus-5", _usage(out=1)),
        {"type": "cost-state", "totalCostUSD": 2.0},
        {"type": "cost-state", "totalCostUSD": 2.0},
    ])
    _write(b, [
        _assistant("m2", "claude-opus-5", _usage(out=1), session_id="b"),
        {"type": "cost-state", "totalCostUSD": 5.0},
    ])
    usage = collect([SessionRef("a", "j1", str(a)), SessionRef("b", "j2", str(b))])
    assert usage["cost_usd"] == 7.0


def test_collect_adds_cost_estimate_from_own_price_table(tmp_path):
    # Unlike cost_usd (from Claude Code's cost-state, available only after the
    # session finishes), our own estimate is computed right away from the counters already collected.
    path = tmp_path / "s1.jsonl"
    _write(path, [_assistant("m1", "claude-opus-5", _usage(inp=1_000_000, out=1_000_000))])
    usage = collect([SessionRef("s1", "job1", str(path))])
    assert usage["cost_usd"] is None
    # opus-5: $5/MTok input + $25/MTok output → 1M input + 1M output = $30
    assert usage["cost_usd_estimated"] == 30.0


def test_estimate_cost_usd_weighs_cache_write_and_read_differently_from_input():
    # A cache write costs more than regular input (×1.25 for 5 minutes, ×2 for an hour), a read costs less
    # (×0.1 for Opus 5): the cache-read counter can be huge yet cost pennies in the end.
    five_min = {"claude-opus-5": {"input": 0, "cache_creation": 1_000_000, "cache_read": 0, "output": 0,
                                  "cache_creation_1h": 0, "messages": 1}}
    assert estimate_cost_usd(five_min) == 6.25  # 1M × $5 × 1.25
    hour = {"claude-opus-5": {**five_min["claude-opus-5"], "cache_creation_1h": 1_000_000}}
    assert estimate_cost_usd(hour) == 10.0  # 1M × $5 × 2
    # An old breakdown without the per-TTL part: we count it as hourly, which is how Claude Code writes the cache now
    legacy = {"claude-opus-5": {"input": 0, "cache_creation": 1_000_000, "cache_read": 0, "output": 0, "messages": 1}}
    assert estimate_cost_usd(legacy) == 10.0

    models = {"claude-opus-5": {"input": 0, "cache_creation": 0, "cache_read": 1_000_000, "output": 0, "messages": 1}}
    assert estimate_cost_usd(models) == 0.5  # 1M × $5 × 0.1


def test_estimate_cost_usd_knows_current_models_and_their_cache_read_prices():
    """Sonnet 5.5 and Haiku 5.5 used to be missing from the price list: half the tasks had an empty estimate.
    Cache reads on the new models are cheaper than the usual ×0.1: for Opus 5.5 and Sonnet 5.5 it is ×0.05."""
    read = {**EMPTY_COUNTERS, "cache_read": 1_000_000, "messages": 1}
    assert estimate_cost_usd({"claude-sonnet-5-5": read}) == 0.1
    assert estimate_cost_usd({"claude-opus-5-5": read}) == 0.2
    assert estimate_cost_usd({"claude-fable-5-1": read}) == 0.25
    assert estimate_cost_usd({"claude-haiku-5-5": {**EMPTY_COUNTERS, "output": 1_000_000, "messages": 1}}) == 0.5


def test_estimate_cost_usd_ignores_snapshot_date_and_context_suffix():
    out = {**EMPTY_COUNTERS, "output": 1_000_000, "messages": 1}
    assert estimate_cost_usd({"claude-haiku-4-5-20251001": out}) == 5.0
    assert estimate_cost_usd({"claude-opus-5-5[1m]": out}) == 20.0


def test_estimate_matches_claude_code_cost_for_a_real_probe():
    """Cross-check against Claude Code itself: a Haiku 5.5 probe (2 input, 39317 cache-write tokens for an hour,
    4 output) cost exactly $0.0078656 in its `costUSD`."""
    models = {"claude-haiku-5-5": {"input": 2, "cache_creation": 39317, "cache_read": 0, "output": 4,
                                   "cache_creation_1h": 39317, "messages": 1}}
    assert estimate_cost_usd(models) == round(0.0078656, 4)


def test_collect_splits_cache_writes_by_ttl(tmp_path):
    path = tmp_path / "s1.jsonl"
    usage = _usage(create=300)
    usage["cache_creation"] = {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200}
    _write(path, [_assistant("m1", "claude-opus-5", usage)])
    result = collect([SessionRef("s1", "job1", str(path))])
    assert result["models"]["claude-opus-5"]["cache_creation_1h"] == 200
    # The per-TTL part is not part of the token total: it refines the write counter rather than being a new one
    assert result["total_tokens"] == 300
    assert result["cost_usd_estimated"] == round((100 * 5 * 1.25 + 200 * 5 * 2) / 1_000_000, 4)


def test_estimate_cost_usd_skips_unknown_models_but_counts_known_ones():
    # A model outside the table (discontinued / entered manually) must not spoil the estimate for
    # other models and must not be silently counted as zero; it is simply skipped.
    assert estimate_cost_usd({"gpt-nonsense": {**EMPTY_COUNTERS, "output": 1_000_000, "messages": 1}}) is None
    mixed = estimate_cost_usd({
        "gpt-nonsense": {**EMPTY_COUNTERS, "output": 1_000_000, "messages": 1},
        "claude-haiku-4-5": {**EMPTY_COUNTERS, "output": 1_000_000, "messages": 1},
    })
    assert mixed == 5.0  # only haiku is counted: $5/MTok output


def test_session_files_and_signature(tmp_path):
    main = tmp_path / "s1.jsonl"
    _write(main, [_assistant("m1", "claude-opus-5", _usage(out=1))])
    sub = tmp_path / "s1" / "subagents" / "agent-x.jsonl"
    _write(sub, [_assistant("x1", "claude-opus-5", _usage(out=1), agent_id="x")])
    (sub.parent / "agent-x.meta.json").write_text("{}")
    files = session_files(str(main))
    assert [(p.name, agent) for p, agent in files] == [("s1.jsonl", None), ("agent-x.jsonl", "x")]
    refs = [SessionRef("s1", "j", str(main)), SessionRef("s2", "j2", str(tmp_path / "missing.jsonl"))]
    assert signature(refs) == {"files": 2, "bytes": main.stat().st_size + sub.stat().st_size}
    sub.write_text(sub.read_text() + "\n")
    assert signature(refs)["bytes"] == main.stat().st_size + sub.stat().st_size
