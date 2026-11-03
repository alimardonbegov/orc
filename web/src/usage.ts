import type { Task, TaskUsage, TokenCounters } from "./types";
import type { TFunction } from "./i18n";

/**
 * Task tokens (see orc/token_usage.py).
 * The server returns the aggregate as a string in `usage_json`, like the agent report in `report_json`:
 * here it is parsed and brought to the form for the badge, tooltip and the modal section.
 */

const COUNTER_KEYS: (keyof TokenCounters)[] = ["input", "cache_creation", "cache_read", "output"];

export function counterLabel(t: TFunction, key: keyof TokenCounters): string {
  return t(`usage.counter.${key}`);
}

/**
 * Counters cost different amounts per token (Anthropic API pricing): a cache write is pricier than regular
 * input (~×1.25), a cache read is cheaper (~×0.1). So "cache read" can be orders of
 * magnitude larger than the other counters and cost pennies in money: this is not a counting bug,
 * but the price of the API resending already-seen context more cheaply. See orc/token_usage.py.
 */
export function counterHint(t: TFunction, key: keyof TokenCounters): string | undefined {
  return key === "cache_creation" || key === "cache_read" ? t(`usage.counterHint.${key}`) : undefined;
}

function isCounters(value: unknown): value is TokenCounters {
  return typeof value === "object" && value !== null && COUNTER_KEYS.every((k) => typeof (value as Record<string, unknown>)[k] === "number");
}

/** Parsing `usage_json`. A broken string or a foreign format — null, as if tokens were not counted. */
export function parseUsage(raw: string | null | undefined): TaskUsage | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const u = data as Partial<TaskUsage>;
  if (typeof u.total_tokens !== "number" || !isCounters(u.total)) return null;
  return {
    total: u.total,
    total_tokens: u.total_tokens,
    models: typeof u.models === "object" && u.models !== null ? u.models : {},
    agents: Array.isArray(u.agents) ? u.agents : [],
    sessions: Array.isArray(u.sessions) ? u.sessions : [],
    cost_usd: typeof u.cost_usd === "number" ? u.cost_usd : null,
    cost_usd_estimated: typeof u.cost_usd_estimated === "number" ? u.cost_usd_estimated : null,
    scanned_at: typeof u.scanned_at === "string" ? u.scanned_at : null,
  };
}

/** Best available dollar estimate: the exact one from Claude Code, otherwise our own, otherwise no data.
 *  The exact one is trusted only for a single-session task — the same rule as in the summary
 *  (orc/analytics.py, task_cost): for multi-session tasks cost-state lies in both directions. */
export function usageCost(usage: TaskUsage): { amount: number; exact: boolean } | null {
  if (usage.cost_usd !== null && usage.sessions.length <= 1) return { amount: usage.cost_usd, exact: true };
  if (usage.cost_usd_estimated !== null) return { amount: usage.cost_usd_estimated, exact: false };
  return null;
}

/** Money notation: $0.03, $1.25, $12.40 — always two decimal places, regardless of magnitude. */
export function formatCost(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Short notation of a token count: 950 · 3.1k · 12k · 4.3M · 80M. One digit after the decimal point
 * only while the number is single-digit — on a badge the magnitude matters, not the precision.
 * Formatted by hand rather than via toLocaleString: ICU in different Node builds has different
 * separator spaces, and tests would float from machine to machine.
 */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const [value, suffix] = abs < 1_000_000 ? [n / 1000, "k"] : abs < 1_000_000_000 ? [n / 1_000_000, "M"] : [n / 1_000_000_000, "G"];
  const digits = Math.abs(value) < 10 ? 1 : 0;
  return value.toFixed(digits).replace(/\.0$/, "").replace(".", ",") + suffix;
}

/** Full notation with digit grouping (non-breaking space): for tooltips and tables where precision matters more than space. */
export function formatExact(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
}

/** How many subagents took part: all agents except the main sessions. */
export function subagentCount(usage: TaskUsage): number {
  return usage.agents.filter((a) => a.agent_id !== null).length;
}

/** Badge tooltip text: the breakdown by counters and the subagent count. */
export function usageTitle(t: TFunction, usage: TaskUsage): string {
  const parts = COUNTER_KEYS.map((k) => `${counterLabel(t, k)} ${formatExact(usage.total[k])}`);
  const subs = subagentCount(usage);
  const models = Object.keys(usage.models);
  const head = t("usage.totalTokens", { total: formatExact(usage.total_tokens) });
  const cost = usageCost(usage);
  const tail = [
    subs > 0 ? t("usage.subagentsCount", { count: subs }) : null,
    models.length > 1 ? t("usage.modelsList", { models: models.join(", ") }) : null,
    cost ? `≈ ${formatCost(cost.amount)}${cost.exact ? "" : ` ${t("usage.estimate")}`}` : null,
  ].filter(Boolean);
  return [head, parts.join(" · "), ...tail].join("\n");
}

/** Sum of tokens across the column's cards; tasks without counting are not included. */
export function sumTokens(tasks: Task[]): number {
  let total = 0;
  for (const t of tasks) {
    const u = parseUsage(t.usage_json);
    if (u) total += u.total_tokens;
  }
  return total;
}

/** Limit percentage: 62% · 7.5% — a fraction only for small numbers, where it means something. */
export function formatPct(value: number): string {
  const digits = Math.abs(value) < 10 && Math.round(value) !== value ? 1 : 0;
  return `${value.toFixed(digits).replace(".", ",")}%`;
}
