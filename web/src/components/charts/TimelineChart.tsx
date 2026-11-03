import { useMemo, type ReactNode } from "react";
import type { AnalyticsBucket, AnalyticsFlowCell, AnalyticsFlowRow, AnalyticsSplit } from "../../types";
import { FLOW_METRICS, bucketTitle, formatBucket, formatCount, labelStep, niceMax, type FlowMetric } from "../../analytics";
import { formatCost, formatTokens } from "../../usage";
import { modelLabel } from "../../models";
import { foldSeries, OTHER_KEY, seriesPalette } from "../../series";
import { Segmented } from "../../ui/Segmented";
import { Figure, LegendKey, NoData } from "./Figure";
import { ChartTipLayer, TipBody, useChartTip } from "./ChartTip";
import { useTranslation } from "../../i18n";

/** Chart area height: there is a single panel and it can be given room — bars are read by height. */
const HEIGHT = 168;

/** Width of the Y-axis label column: fits "$1500.00" in a monospace 10px font. */
const AXIS_WIDTH = "3.5rem";

const format: Record<FlowMetric, (v: number) => string> = {
  tasks: formatCount,
  tokens: formatTokens,
  cost_usd: formatCost,
};

/** Bucket total by measure: tasks — from the done/failed fields, everything else as is. */
const rowTotal = (row: AnalyticsFlowRow, metric: FlowMetric): number =>
  metric === "tasks" ? row.done + row.failed : row[metric];

const sumCells = (a: AnalyticsFlowCell, b: AnalyticsFlowCell): AnalyticsFlowCell => ({
  tasks: a.tasks + b.tasks,
  tokens: a.tokens + b.tokens,
  cost_usd: a.cost_usd + b.cost_usd,
});

/**
 * Completed tasks over time: one measure on screen — money, tokens or task count —
 * as bars per period bucket, each bar stacked by model or by project.
 *
 * There used to be three panels here (tasks, tokens, money) with shared coloring by one of
 * three breakdowns, including status. That produced a 3×3 matrix that had to be read rather than
 * looked at: nine combinations for two or three questions. A measure is a view of the same
 * buckets, not a separate chart, so now it is switchable and the choice is remembered.
 *
 * There is no status breakdown: nearly all completed tasks are "done", and a single-color stack
 * told nothing. Failures are visible in the bar tooltip and on the "Finished" tile.
 * The project breakdown exists only in the "all projects" scope: in one project it is a single series,
 * and a switcher with a single option would be noise.
 */
export function TimelineChart({
  rows,
  bucket,
  metric,
  onMetric,
  split,
  onSplit,
  allowProjects,
}: {
  rows: AnalyticsFlowRow[];
  bucket: AnalyticsBucket;
  metric: FlowMetric;
  onMetric: (metric: FlowMetric) => void;
  split: AnalyticsSplit;
  onSplit: (split: AnalyticsSplit) => void;
  /** A stack by project exists only in the "all projects" scope: in one project it is a single series. */
  allowProjects: boolean;
}) {
  const { t } = useTranslation();
  const { hostRef, tip, bind } = useChartTip();
  const effectiveSplit: AnalyticsSplit = split === "by_project" && !allowProjects ? "by_model" : split;

  const { present, effectiveMetric, order, color, folded, max } = useMemo(() => {
    // Measures that have anything for the period. For tasks without token counts, tokens and
    // money are empty, for tasks without prices only money is. We do not offer an empty measure or draw an empty
    // axis: we show the first non-empty one, and the switcher button honestly lands on it.
    const present = FLOW_METRICS.filter((m) => rows.some((r) => rowTotal(r, m) > 0));
    const effectiveMetric: FlowMetric = present.includes(metric) ? metric : present[0] ?? metric;
    const keys = new Set<string>();
    // `?? {}` — a response from a server of the previous version without breakdowns must not bring down the whole dashboard
    for (const row of rows) for (const key of Object.keys(row[effectiveSplit] ?? {})) keys.add(key);
    const { order, color } = seriesPalette(effectiveSplit, keys);
    const folded = rows.map((row) => foldSeries(row[effectiveSplit] ?? {}, order, sumCells));
    let max = 0;
    for (const cells of folded) {
      max = Math.max(max, Object.values(cells).reduce((s, c) => s + c[effectiveMetric], 0));
    }
    return { present, effectiveMetric, order, color, folded, max: niceMax(max) };
  }, [rows, effectiveSplit, metric]);
  const empty = present.length === 0;
  const fmt = format[effectiveMetric];
  const metricLabel = t(`charts.metric.${effectiveMetric}`);

  const seriesLabel = (key: string): string => {
    if (key === OTHER_KEY) return t("charts.otherSeries");
    if (effectiveSplit === "by_model") return key === "—" ? t("dashboard.notSpecified") : modelLabel(key);
    return key;
  };

  const step = labelStep(rows.length);
  // The axis midpoint is labeled only when it is round: "7.5 tasks" on an axis is not a label
  const mid = max / 2;
  const showMid = effectiveMetric !== "tasks" || Number.isInteger(mid);

  const tipFor = (i: number): ReactNode => {
    const row = rows[i];
    const cells = folded[i];
    const series = order
      .filter((key) => cells[key] && cells[key][effectiveMetric] > 0)
      .map((key) => ({ key, label: seriesLabel(key), value: fmt(cells[key][effectiveMetric]), tone: color.get(key) }));
    // The other measures of the same bucket and the failures go in the footer: the question "how much did this cost"
    // is asked while looking at the task bar, and vice versa
    const foot = [
      ...FLOW_METRICS.filter((m) => m !== effectiveMetric).map((m) => `${t(`charts.metric.${m}`)} ${format[m](rowTotal(row, m))}`),
      row.failed > 0 ? t("charts.failedCount", { count: row.failed }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <TipBody
        title={`${bucketTitle(t, row.date, bucket)} · ${metricLabel} ${fmt(rowTotal(row, effectiveMetric))}`}
        rows={series.length > 0 ? series : [{ key: "none", label: metricLabel, value: fmt(0) }]}
        foot={foot}
      />
    );
  };

  const metricOptions = (present.length > 0 ? present : FLOW_METRICS).map((m) => ({ value: m, label: t(`charts.metric.${m}`) }));

  return (
    <Figure
      title={`${t(`charts.timeline.title.${effectiveMetric}`)} ${t(`charts.timeline.per.${bucket}`)}`}
      hint={t("charts.timeline.hint")}
      aside={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {metricOptions.length > 1 && (
            <Segmented ariaLabel={t("charts.timeline.metricLabel")} value={effectiveMetric} onChange={onMetric} options={metricOptions} />
          )}
          {allowProjects && (
            <Segmented
              ariaLabel={t("charts.timeline.splitLabel")}
              value={effectiveSplit}
              onChange={onSplit}
              options={[
                { value: "by_model", label: t("charts.timeline.splitModel") },
                { value: "by_project", label: t("charts.timeline.splitProject") },
              ]}
            />
          )}
        </div>
      }
    >
      {empty ? (
        <NoData />
      ) : (
        <div ref={hostRef} className="relative">
          <div className="flex gap-2">
            <div
              className="tnum relative shrink-0 font-mono text-[10px] text-[var(--ink-faint)]"
              style={{ height: HEIGHT, width: AXIS_WIDTH }}
              aria-hidden
            >
              <span className="absolute right-0 top-0 -translate-y-1/2 leading-none">{fmt(max)}</span>
              {showMid && <span className="absolute right-0 top-1/2 -translate-y-1/2 leading-none">{fmt(mid)}</span>}
              <span className="absolute bottom-0 right-0 translate-y-1/2 leading-none">0</span>
            </div>
            <div className="relative min-w-0 flex-1" style={{ height: HEIGHT }}>
              {[0, 50, 100].map((top) => (
                <span key={top} aria-hidden className="absolute inset-x-0 border-t border-[var(--line)]" style={{ top: `${top}%` }} />
              ))}
              <div className="relative flex h-full items-end gap-px" role="group" aria-label={metricLabel}>
                {rows.map((row, i) => {
                  const cells = folded[i];
                  const stack = order.filter((key) => cells[key] && cells[key][effectiveMetric] > 0);
                  const total = stack.reduce((s, key) => s + cells[key][effectiveMetric], 0);
                  return (
                    <button
                      key={row.date}
                      type="button"
                      aria-label={`${bucketTitle(t, row.date, bucket)}: ${metricLabel} ${fmt(total)}`}
                      className="group flex h-full min-w-0 flex-1 flex-col justify-end rounded-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                      {...bind(row.date, tipFor(i))}
                    >
                      <span className="mx-auto flex w-full max-w-[28px] flex-col-reverse gap-[2px] transition-[filter] group-hover:[filter:brightness(1.18)]">
                        {stack.map((key, j) => (
                          <span
                            key={key}
                            className={j === stack.length - 1 ? "block rounded-t-[4px]" : "block"}
                            style={{
                              height: `${Math.max((cells[key][effectiveMetric] / max) * HEIGHT, 1)}px`,
                              background: color.get(key),
                            }}
                          />
                        ))}
                        {stack.length === 0 && <span className="block h-px" style={{ background: "var(--line)" }} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-1 flex gap-px" style={{ paddingLeft: `calc(${AXIS_WIDTH} + 0.5rem)` }}>
            {rows.map((row, i) => (
              <span key={row.date} className="min-w-0 flex-1 whitespace-nowrap text-center font-mono text-[10px] text-[var(--ink-faint)]">
                {i % step === 0 ? formatBucket(t, row.date, bucket) : " "}
              </span>
            ))}
          </div>

          {/* The legend is under the axis, not in the header: the header already holds switchers, and six models
              next to them would break the heading row */}
          {order.length > 0 && (
            <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-3 gap-y-1 p-0" style={{ paddingLeft: `calc(${AXIS_WIDTH} + 0.5rem)` }}>
              {order.map((key) => (
                <li key={key}>
                  <LegendKey tone={color.get(key) ?? "var(--ink-faint)"}>{seriesLabel(key)}</LegendKey>
                </li>
              ))}
            </ul>
          )}

          <ChartTipLayer tip={tip} />
        </div>
      )}
    </Figure>
  );
}
