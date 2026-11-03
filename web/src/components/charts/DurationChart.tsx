import type { AnalyticsDurations } from "../../types";
import { binLabel, formatCount, formatPercent } from "../../analytics";
import { Figure, NoData } from "./Figure";
import { ChartTipLayer, TipBody, useChartTip } from "./ChartTip";
import { useTranslation } from "../../i18n";

/**
 * Distribution of agent working time across buckets.
 *
 * There is one series, so one color — neutral: painting long tasks "red"
 * would declare them bad, while a long task may simply be big. Color in this
 * interface is reserved for statuses (see index.css), and a duration distribution is not a status.
 *
 * The median is nearby in the tiles; the TAIL matters here: two four-hour tasks are visible here and
 * invisible in any average. The number sits right at the bar, the tooltip adds the share.
 */
export function DurationChart({ durations }: { durations: AnalyticsDurations }) {
  const { t } = useTranslation();
  const { hostRef, tip, bind } = useChartTip();
  const { bins, measured, finished } = durations;
  const total = measured;
  const max = Math.max(1, ...bins.map((b) => b.count));

  return (
    <Figure
      title={t("charts.durationTitle")}
      hint={t("charts.durationHint")}
      // The scope is named explicitly: for tasks closed before the session log existed there is nothing to measure,
      // and silently showing a distribution "over all completed" would be untrue.
      aside={
        <span className="tnum font-mono text-[11px] text-[var(--ink-faint)]">
          {measured === finished ? t("charts.tasksCount", { count: formatCount(total) }) : t("charts.tasksCountOf", { measured: formatCount(measured), finished: formatCount(finished) })}
        </span>
      }
    >
      {total === 0 ? (
        <NoData>{t("charts.noDurationData")}</NoData>
      ) : (
        <div ref={hostRef} className="relative">
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={t("charts.durationDistribution")}>
            {bins.map((bin) => {
              const label = binLabel(t, bin);
              return (
              <li key={bin.label}>
                <button
                  type="button"
                  aria-label={t("charts.durationBinTitle", { label, count: bin.count, percent: formatPercent(bin.count / total) })}
                  className="group flex w-full items-center gap-2 rounded-[3px] py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                  {...bind(bin.label, (
                    <TipBody
                      title={label}
                      rows={[
                        { key: "count", label: t("charts.tasksHeader"), value: String(bin.count), tone: "var(--ink-faint)" },
                        { key: "share", label: t("charts.shareOfMeasured"), value: formatPercent(bin.count / total) },
                      ]}
                    />
                  ))}
                >
                  <span className="w-[4.5rem] shrink-0 text-right text-[11px] text-[var(--ink-muted)]">{label}</span>
                  <span className="relative flex h-4 min-w-0 flex-1 items-center">
                    <span
                      className="block h-2 rounded-r-[4px] transition-[filter] group-hover:[filter:brightness(1.25)]"
                      style={{
                        width: `${Math.max((bin.count / max) * 100, bin.count > 0 ? 1.5 : 0)}%`,
                        background: "var(--ink-faint)",
                      }}
                    />
                  </span>
                  <span className="tnum w-7 shrink-0 text-right font-mono text-[11px] text-[var(--ink)]">{bin.count}</span>
                </button>
              </li>
              );
            })}
          </ul>
          <ChartTipLayer tip={tip} />
        </div>
      )}
    </Figure>
  );
}
