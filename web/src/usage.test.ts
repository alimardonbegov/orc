import { describe, expect, it } from "vitest";
import { formatCost, formatTokens, parseUsage, subagentCount, sumTokens, usageCost, usageTitle } from "./usage";
import { defaultT as t } from "./i18n";
import type { Task, TaskUsage } from "./types";

const usage: TaskUsage = {
  total: { input: 642, cache_creation: 729753, cache_read: 78667162, output: 111253 },
  total_tokens: 79508810,
  models: { "claude-opus-5": { input: 642, cache_creation: 729753, cache_read: 78667162, output: 111253, messages: 321 } },
  agents: [
    { session_id: "s1", agent_id: null, agent_type: null, description: null, model: "claude-opus-5",
      tokens: { input: 600, cache_creation: 700000, cache_read: 78000000, output: 100000 }, total_tokens: 78800600, messages: 300 },
    { session_id: "s1", agent_id: "aaa", agent_type: "Explore", description: "Find X", model: "claude-opus-5",
      tokens: { input: 42, cache_creation: 29753, cache_read: 667162, output: 11253 }, total_tokens: 708210, messages: 21 },
  ],
  sessions: [{ session_id: "s1", job_id: "j1", total_tokens: 79508810 }],
  cost_usd: 13.17,
  cost_usd_estimated: 12.9,
  scanned_at: "2026-09-21T12:00:00+00:00",
};

describe("formatTokens", () => {
  it("a short entry with a suffix", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_340)).toBe("12k");
    expect(formatTokens(3_148)).toBe("3,1k");
    expect(formatTokens(79_508_810)).toBe("80M");
    expect(formatTokens(4_250_000)).toBe("4,3M");
    expect(formatTokens(1_500_000_000)).toBe("1,5G");
  });
});

describe("parseUsage", () => {
  it("parses the server JSON and fills in defaults for optional fields", () => {
    const parsed = parseUsage(JSON.stringify({ total: usage.total, total_tokens: usage.total_tokens }));
    expect(parsed).toEqual({
      ...usage, models: {}, agents: [], sessions: [], cost_usd: null, cost_usd_estimated: null, scanned_at: null,
    });
    expect(parseUsage(JSON.stringify(usage))).toEqual(usage);
  });

  it("a broken string, null and a foreign format give null", () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage("")).toBeNull();
    expect(parseUsage("{not json")).toBeNull();
    expect(parseUsage(JSON.stringify({ total_tokens: "x" }))).toBeNull();
    expect(parseUsage(JSON.stringify({ total_tokens: 5, total: { input: 1 } }))).toBeNull();
    expect(parseUsage("[]")).toBeNull();
  });
});

describe("usageCost", () => {
  it("prefers the exact cost_usd over the estimate", () => {
    expect(usageCost(usage)).toEqual({ amount: 13.17, exact: true });
  });

  it("falls back to its own estimate if Claude Code did not record the exact total", () => {
    expect(usageCost({ ...usage, cost_usd: null })).toEqual({ amount: 12.9, exact: false });
  });

  it("null if there is neither", () => {
    expect(usageCost({ ...usage, cost_usd: null, cost_usd_estimated: null })).toBeNull();
  });

  it("for a task of several sessions it takes its own estimate: cost-state lies there", () => {
    const sessions = [
      { session_id: "a", job_id: "a", total_tokens: 1 },
      { session_id: "b", job_id: "b", total_tokens: 1 },
    ];
    expect(usageCost({ ...usage, sessions })).toEqual({ amount: 12.9, exact: false });
  });
});

describe("formatCost", () => {
  it("two decimal places always", () => {
    expect(formatCost(0.003265)).toBe("$0.00");
    expect(formatCost(1.2)).toBe("$1.20");
    expect(formatCost(12.999)).toBe("$13.00");
  });
});

describe("summaries", () => {
  it("counts subagents and builds the tooltip", () => {
    expect(subagentCount(usage)).toBe(1);
    const title = usageTitle(t, usage);
    expect(title.split("\n")[0]).toBe("total tokens 79 508 810");
    expect(title).toContain("cache read 78 667 162");
    expect(title).toContain("subagents: 1");
    expect(title).not.toContain("models:"); // one model: nothing to list
    expect(title).toContain("≈ $13.17");
    expect(title).not.toContain("(estimate)"); // cost_usd is exact: there must be no estimate mark
  });

  it("the tooltip marks the cost as an estimate when there is no exact total", () => {
    const title = usageTitle(t, { ...usage, cost_usd: null });
    expect(title).toContain("≈ $12.90 (estimate)");
  });

  it("sums tokens across cards, skipping uncounted ones", () => {
    const task = { usage_json: JSON.stringify(usage) } as Task;
    const empty = { usage_json: null } as Task;
    const broken = { usage_json: "{" } as Task;
    expect(sumTokens([task, empty, broken, task])).toBe(usage.total_tokens * 2);
    expect(sumTokens([])).toBe(0);
  });
});
