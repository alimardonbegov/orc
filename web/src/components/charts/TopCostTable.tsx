import type { AnalyticsTopRow } from "../../types";
import { statusLabel } from "../../labels";
import { formatDuration } from "../../analytics";
import { formatCost, formatExact, formatTokens } from "../../usage";
import { Figure, NoData } from "./Figure";
import { useTranslation } from "../../i18n";

/**
 * The most expensive tasks of the period.
 *
 * The "spent this month" tile says how much, but not on what; this table answers the latter
 * and is therefore clickable — it opens the card itself, which holds both the task statement and the report,
 * and the full token breakdown.
 */
export function TopCostTable({ rows, onOpenTask, showProject }: {
  rows: AnalyticsTopRow[];
  onOpenTask: (id: number) => void;
  /** The all-projects slice needs a project column, a single-project slice does not. */
  showProject?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Figure title={t("charts.topCostTitle")} hint={t("charts.topCostHint")}>
      {rows.length === 0 ? (
        <NoData />
      ) : (
        <table className="tnum w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-[var(--ink-faint)]">
              <th className="pb-1 text-left font-normal">{t("charts.taskHeader")}</th>
              {showProject && <th className="w-px whitespace-nowrap pb-1 text-left font-normal">{t("charts.projectHeader")}</th>}
              <th className="w-px whitespace-nowrap pb-1 text-right font-normal">{t("charts.tokensHeader")}</th>
              <th className="w-px whitespace-nowrap pb-1 text-right font-normal">{t("charts.priceHeader")}</th>
              <th className="w-px whitespace-nowrap pb-1 text-right font-normal">{t("charts.timeHeader")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              return (
                <tr key={row.id} className="border-t border-[var(--line)] hover:bg-[var(--sunken)]">
                  <td className="max-w-0 py-1 pr-2">
                    <button
                      type="button"
                      onClick={() => onOpenTask(row.id)}
                      title={t("charts.topCostRowTitle", { title: row.title, status: statusLabel(t, row.status), model: row.model })}
                      className="flex w-full min-w-0 items-center gap-1.5 text-left text-[var(--ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                    >
                      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: `var(--st-${row.status === "in_progress" ? "progress" : row.status})` }} />
                      <span className="shrink-0 font-mono text-[var(--ink-faint)]">#{row.id}</span>
                      <span className="truncate">{row.title}</span>
                    </button>
                  </td>
                  {showProject && (
                    <td className="max-w-[10rem] truncate whitespace-nowrap py-1 pr-3 text-[var(--ink-muted)]">{row.project ?? "—"}</td>
                  )}
                  <td className="whitespace-nowrap py-1 pl-3 text-right font-mono text-[var(--ink-muted)]" title={formatExact(row.tokens)}>
                    {formatTokens(row.tokens)}
                  </td>
                  <td className="whitespace-nowrap py-1 pl-3 text-right font-mono font-medium text-[var(--ink)]">
                    {row.cost_usd === null ? "—" : formatCost(row.cost_usd)}
                  </td>
                  <td className="whitespace-nowrap py-1 pl-3 text-right font-mono text-[var(--ink-muted)]">{formatDuration(t, row.work_sec)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Figure>
  );
}
