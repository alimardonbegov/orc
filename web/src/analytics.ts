import type { AnalyticsBucket, AnalyticsDurationBin } from "./types";
import type { TFunction } from "./i18n";

/**
 * Labels and formatting for the dashboard. The server returns bare numbers (orc/analytics.py), and
 * the words for them live here: this way the same interval is written identically in the tile, on
 * the axis and in the tooltip. The words are translated through t() (analytics.* keys).
 */

const PERIOD_VALUES: { value: string; days: number }[] = [
  { value: "7", days: 7 },
  { value: "30", days: 30 },
  { value: "90", days: 90 },
  { value: "0", days: 0 },
];

/** Periods in the switcher. 0 means all time; the same list is validated by the server
 * (ALLOWED_DAYS). */
export function getPeriods(t: TFunction): { value: string; label: string; days: number }[] {
  return PERIOD_VALUES.map((p) => ({ ...p, label: t(`analytics.period.${p.value}`) }));
}

export const DEFAULT_PERIOD = 30;

export const isKnownPeriod = (days: number) => PERIOD_VALUES.some((p) => p.days === days);

/**
 * Duration in human words: 42 s · 7 min · 1 h 20 min · 3 d 4 h. We never write more than two units:
 * on a tile the order of magnitude matters, not the seconds in a day. null means there was nothing
 * to measure, and that is not "zero".
 */
export function formatDuration(t: TFunction, sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  const s = Math.max(0, Math.round(sec));
  const unit = (key: string) => t(`analytics.unit.${key}`);
  if (s < 60) return `${s} ${unit("sec")}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${unit("min")}`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} ${unit("hour")}` : `${h} ${unit("hour")} ${m % 60} ${unit("min")}`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} ${unit("day")}` : `${d} ${unit("day")} ${h % 24} ${unit("hour")}`;
}

/** Share as a percentage: 0.867 → "87%". null means there was nothing to compute from. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

function monthShort(t: TFunction, index: number): string {
  return t(`analytics.monthShort.${index}`);
}

/** "2026-09-18" → "18 Sep". We parse the string ourselves: `new Date` would shift the date by the
 * time zone. */
export function formatDay(t: TFunction, date: string): string {
  const [, month, day] = date.split("-");
  const index = Number(month) - 1;
  return `${Number(day)} ${monthShort(t, index)}`;
}

/** Label of a time-axis bucket, taking its step into account. */
export function formatBucket(t: TFunction, date: string, bucket: AnalyticsBucket): string {
  if (bucket === "month") {
    const [year, month] = date.split("-");
    return `${monthShort(t, Number(month) - 1)} ${year.slice(2)}`;
  }
  return formatDay(t, date);
}

/** Full bucket label for the tooltip: for a week or a month the start day is not self-explanatory. */
export function bucketTitle(t: TFunction, date: string, bucket: AnalyticsBucket): string {
  if (bucket === "day") return formatDay(t, date);
  if (bucket === "week") return t("analytics.weekOf", { date: formatDay(t, date) });
  return t("analytics.monthOf", { month: formatBucket(t, date, "month") });
}

/** Period label in the header: "for 30 days" / "for all time". */
export function periodLabel(t: TFunction, days: number): string {
  const period =
    days === 0 ? t("analytics.allTime") : getPeriods(t).find((p) => p.days === days)?.label ?? t("analytics.period.days", { days });
  return t("analytics.forPeriod", { period });
}

/**
 * How many labels fit on the axis: we draw every Nth one so neighbours do not overlap. It is
 * computed from the number of buckets, not from the width: the width is fluid, while the number of
 * bars is known.
 */
export function labelStep(count: number, maxLabels = 8): number {
  return Math.max(1, Math.ceil(count / maxLabels));
}

/**
 * Round axis ceiling: 7 → 8, 23 → 25, 60 → 60, 140 → 150. An axis without a round top reads worse
 * than any grid: a division "up to 23" tells you nothing. There are many steps within an order of
 * magnitude on purpose: with a jump 50 → 100 a bar of 60 tasks would take half the field.
 */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

/** Numbers in thousands with a non-breaking space: 1 284. For axes and tables. */
export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Duration bucket label from its bounds: "< 5 min", "5–15 min", "1–2 h", "> 4 h". The server sends
 * its own label too, but it is in a single language; here it is assembled from numbers in the
 * interface language. The unit is written once if both bounds share it.
 */
export function binLabel(t: TFunction, bin: AnalyticsDurationBin): string {
  const from = formatDuration(t, bin.from_sec);
  if (bin.to_sec === null) return `> ${from}`;
  const to = formatDuration(t, bin.to_sec);
  if (bin.from_sec === 0) return `< ${to}`;
  const fromParts = from.split(" ");
  const toParts = to.split(" ");
  const sameUnit = fromParts.length === 2 && toParts.length === 2 && fromParts[1] === toParts[1];
  return sameUnit ? `${fromParts[0]}–${toParts[0]} ${toParts[1]}` : `${from} – ${to}`;
}

/**
 * The "over time" chart measure: money, tokens or the number of completed tasks. Only one is on
 * screen: these are three views of the same buckets, not three different charts. The order is the
 * order of the buttons and the order of the fallback choice when the selected measure is empty for
 * the period.
 */
export const FLOW_METRICS = ["cost_usd", "tokens", "tasks"] as const;
export type FlowMetric = (typeof FLOW_METRICS)[number];
export const DEFAULT_METRIC: FlowMetric = "cost_usd";
export const isFlowMetric = (value: unknown): value is FlowMetric => FLOW_METRICS.includes(value as FlowMetric);

/**
 * Breakdown attribute of completed tasks: there is one table, and the attribute is switched in its
 * header. Names match the fields of the /api/analytics response so rows can be taken without a
 * dictionary.
 */
export const BREAKDOWN_DIMS = ["models", "projects", "efforts", "permissions"] as const;
export type BreakdownDim = (typeof BREAKDOWN_DIMS)[number];
export const DEFAULT_BREAKDOWN: BreakdownDim = "models";
export const isBreakdownDim = (value: unknown): value is BreakdownDim => BREAKDOWN_DIMS.includes(value as BreakdownDim);
