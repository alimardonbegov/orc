import type { ReactNode } from "react";
import type { AnalyticsRow } from "../../types";
import { formatDuration, formatPercent } from "../../analytics";
import { formatCost, formatExact, formatTokens } from "../../usage";
import { Figure, LegendKey, NoData } from "./Figure";
import { ChartTipLayer, TipBody, useChartTip } from "./ChartTip";
import { useTranslation } from "../../i18n";

/**
 * Breakdown of completed tasks by a single attribute: model, effort level, access mode,
 * project.
 *
 * A table, not a pie chart and not a set of colored series: there can be more than seven
 * attributes, and each needs five numbers at once — how many, what success share, how much money
 * in total and per task, how much time. The only graphic here is the success and
 * failure bar in a row: it shows both volume (length relative to the largest row) and quality
 * (failure share), and these are exactly statuses, so color is appropriate.
 *
 * "Per task" is the column the table is read for: "which model pays off" is answered
 * not by the total (an expensive model did more tasks) but by the average ticket.
 */
export function BreakdownTable({
  title,
  hint,
  rows,
  keyLabel,
  renderKey,
  empty,
  aside,
}: {
  title: string;
  hint?: string;
  rows: AnalyticsRow[];
  keyLabel: string;
  /** How to label a row key: for models it is the human-readable name, for the rest the key itself. */
  renderKey?: (key: string) => string;
  empty?: string;
  /** Right corner of the header: the attribute switcher, when one table serves several. */
  aside?: ReactNode;
}) {
  const { t } = useTranslation();
  const { hostRef, tip, bind } = useChartTip();
  const max = Math.max(1, ...rows.map((r) => r.tasks));
  const label = (key: string) => (renderKey ? renderKey(key) : key);

  const tipFor = (row: AnalyticsRow) => (
    <TipBody
      title={label(row.key)}
      rows={[
        { key: "done", label: t("charts.done"), value: `${row.done} · ${formatPercent(row.tasks ? row.done / row.tasks : null)}`, tone: "var(--st-done)" },
        { key: "failed", label: t("charts.failed"), value: String(row.failed), tone: "var(--st-failed)" },
        { key: "tokens", label: t("charts.tokensHeader"), value: formatExact(row.tokens) },
        { key: "cost", label: t("charts.priceHeader"), value: row.cost_usd > 0 ? formatCost(row.cost_usd) : "—" },
        { key: "per", label: t("charts.perTaskHeader"), value: row.cost_usd > 0 && row.tasks > 0 ? formatCost(row.cost_usd / row.tasks) : "—" },
        { key: "median", label: t("charts.medianHeader"), value: formatDuration(t, row.median_sec) },
      ]}
    />
  );

  return (
    <Figure
      title={title}
      hint={hint}
      aside={aside}
      legend={
        rows.length > 0 ? (
          <>
            <LegendKey tone="var(--st-done)">{t("charts.done")}</LegendKey>
            <LegendKey tone="var(--st-failed)">{t("charts.failed")}</LegendKey>
          </>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <NoData>{empty ?? t("charts.noFinishedTasks")}</NoData>
      ) : (
        <div ref={hostRef} className="relative">
          <table className="tnum w-full border-collapse text-[11px]">
            <thead>
              <tr className="text-[var(--ink-faint)]">
                <th className="pb-1 text-left font-normal">{keyLabel}</th>
                <th className="pb-1 text-left font-normal">{t("charts.tasksHeader")}</th>
                <th className="pb-1 text-right font-normal" title={t("charts.successTitle")}>{t("charts.successHeader")}</th>
                <th className="pb-1 text-right font-normal">{t("charts.tokensHeader")}</th>
                <th className="pb-1 text-right font-normal">{t("charts.priceHeader")}</th>
                <th className="pb-1 text-right font-normal" title={t("charts.perTaskTitle")}>{t("charts.perTaskHeader")}</th>
                <th className="pb-1 text-right font-normal" title={t("charts.medianTitle")}>
                  {t("charts.medianHeader")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-[var(--line)] hover:bg-[var(--sunken)]">
                  <td className="max-w-[9rem] truncate py-1 pr-2 text-[var(--ink)]" title={row.key}>
                    {label(row.key)}
                  </td>
                  <td className="w-[32%] py-1 pr-2">
                    {/* The bar is a button: tap and focus open the same tooltip as hover */}
                    <button
                      type="button"
                      aria-label={t("charts.rowAriaLabel", { label: label(row.key), tasks: row.tasks, done: row.done, failed: row.failed })}
                      className="flex w-full items-center gap-2 rounded-[3px] py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                      {...bind(row.key, tipFor(row))}
                    >
                      {/* Bar length is the share of the largest row; inside it, the failure share */}
                      <span className="flex h-2 min-w-0 flex-1 items-center">
                        <span className="flex h-2 gap-[2px]" style={{ width: `${(row.tasks / max) * 100}%` }}>
                          {row.done > 0 && (
                            <span className="block rounded-[2px]" style={{ width: `${(row.done / row.tasks) * 100}%`, background: "var(--st-done)" }} />
                          )}
                          {row.failed > 0 && (
                            <span className="block rounded-[2px]" style={{ width: `${(row.failed / row.tasks) * 100}%`, background: "var(--st-failed)" }} />
                          )}
                        </span>
                      </span>
                      <span className="w-6 shrink-0 text-right font-mono font-medium text-[var(--ink)]">{row.tasks}</span>
                    </button>
                  </td>
                  <td className="py-1 pl-2 text-right font-mono text-[var(--ink-muted)]">{formatPercent(row.tasks ? row.done / row.tasks : null)}</td>
                  <td className="py-1 pl-2 text-right font-mono text-[var(--ink-muted)]" title={formatExact(row.tokens)}>
                    {formatTokens(row.tokens)}
                  </td>
                  <td className="py-1 pl-2 text-right font-mono text-[var(--ink-muted)]">
                    {row.cost_usd > 0 ? formatCost(row.cost_usd) : "—"}
                  </td>
                  <td className="py-1 pl-2 text-right font-mono text-[var(--ink-muted)]">
                    {row.cost_usd > 0 && row.tasks > 0 ? formatCost(row.cost_usd / row.tasks) : "—"}
                  </td>
                  <td className="py-1 pl-2 text-right font-mono text-[var(--ink-muted)]">{formatDuration(t, row.median_sec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ChartTipLayer tip={tip} />
        </div>
      )}
    </Figure>
  );
}
