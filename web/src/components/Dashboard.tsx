import { useMemo } from "react";
import { CheckCheck, Coins, Hand, RefreshCw, Target, Timer } from "lucide-react";
import type { Analytics, AnalyticsPrevious, AnalyticsRow, AnalyticsSplit, Forecast, Project } from "../types";
import { BREAKDOWN_DIMS, getPeriods, formatDuration, formatPercent, periodLabel, type BreakdownDim, type FlowMetric } from "../analytics";
import { modelLabel } from "../models";
import { permissionLabel } from "../permissions";
import { formatCost, formatTokens } from "../usage";
import { Segmented } from "../ui/Segmented";
import { IconButton } from "../ui/Button";
import { Tip } from "../ui/Overlays";
import { ForecastPanel } from "./ForecastPanel";
import { TimelineChart } from "./charts/TimelineChart";
import { BreakdownTable } from "./charts/BreakdownTable";
import { DurationChart } from "./charts/DurationChart";
import { StatTile, type TileDelta } from "./charts/StatTile";
import { TopCostTable } from "./charts/TopCostTable";
import { cn } from "../lib/cn";
import { useTranslation, type TFunction } from "../i18n";

interface Props {
  data: Analytics | null;
  error: string | null;
  /** Project selected in the sidebar. null means there are no projects at all. */
  project: Project | null;
  /** Slice: only the selected project or all at once. */
  allProjects: boolean;
  onAllProjects: (value: boolean) => void;
  days: number;
  onDays: (value: number) => void;
  /** Measure of the over-time chart: money, tokens or tasks. */
  metric: FlowMetric;
  onMetric: (value: FlowMetric) => void;
  /** What to colour the bar stacks by: model or project. */
  split: AnalyticsSplit;
  onSplit: (value: AnalyticsSplit) => void;
  /** Breakdown table attribute: model, project, effort or permission mode. */
  breakdown: BreakdownDim;
  onBreakdown: (value: BreakdownDim) => void;
  onRefresh: () => void;
  onOpenTask: (id: number) => void;
  forecast?: Forecast | null;
  forecastError?: string | null;
}

/**
 * Dashboard: the second view of the control panel next to the board.
 *
 * The board answers the question "do I need to step in right now". The dashboard answers the ones
 * that appear after weeks of work: how much this costs and what it goes on, will I hit the limit,
 * does a model pay off, has it gotten better. The common thread is spend: it is in the forecast, on
 * the over-time chart, in the breakdown and in the "most expensive" table.
 *
 * Layout top to bottom, from the total to the cause:
 *
 *  1. Five period tiles with a delta against the previous period: completed, success rate, spent,
 *     median work time, times the human was called;
 *  2. Claude limits forecast: always shown, no toggle: the only block that speaks about the future,
 *     and there was no reason to hide it. It is about "now" and is not cut by scope;
 *  3. Over-time chart: one measure (money / tokens / tasks), stacked by model or project;
 *  4. Breakdown of completed tasks by a single attribute (model / project / effort / access)
 *     next to the duration distribution;
 *  5. "Most expensive" table: from it you go back to a specific card.
 *
 * What is no longer here and why. A "queued" tile: the number of created cards says nothing about
 * the work. "Where tasks are now" strips: that is a compressed board, and the board is one click
 * away. A cut by status: completed tasks are almost all "done", and the colour conveyed nothing. A
 * "friction" list: five heterogeneous counters with no question they answer. Each card shows one
 * measure or one attribute, and the switcher sits in its header: these are views of the same data,
 * not different data, and putting them side by side would force the reader to read a matrix.
 *
 * The period and scope filters sit in one row above everything they cut; individual cards have no
 * filters of their own, otherwise the numbers on screen start living in different periods.
 */
export function Dashboard({
  data,
  error,
  project,
  allProjects,
  onAllProjects,
  days,
  onDays,
  metric,
  onMetric,
  split,
  onSplit,
  breakdown,
  onBreakdown,
  onRefresh,
  onOpenTask,
  forecast = null,
  forecastError = null,
}: Props) {
  const { t } = useTranslation();
  // The response may have arrived for the previous filters: while a new one is in flight we show
  // the old one muted: this is more honest than a skeleton, which on every switch would reset the
  // layout with a jump.
  const stale = data !== null && (data.period.days !== days || data.scope.project_id !== (allProjects ? null : project?.id ?? null));

  const totals = data?.totals;
  const successTone = useMemo(() => {
    if (!totals || totals.success_rate === null) return undefined;
    if (totals.success_rate >= 0.8) return "var(--st-done)";
    return totals.success_rate >= 0.5 ? "var(--warn)" : "var(--st-failed)";
  }, [totals]);

  const deltas = useMemo(() => (data ? tileDeltas(t, data) : null), [t, data]);

  // The "project" attribute exists only in the "all projects" scope: in a single project it is one
  // row
  const dims = BREAKDOWN_DIMS.filter((d) => d !== "projects" || allProjects);
  const dim: BreakdownDim = dims.includes(breakdown) ? breakdown : "models";
  const table = data ? breakdownRows(t, dim, data) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <Segmented
          ariaLabel={t("dashboard.scopeLabel")}
          value={allProjects ? "all" : "one"}
          onChange={(v) => onAllProjects(v === "all")}
          options={[
            { value: "one", label: project ? project.name : t("dashboard.projectFallback") },
            { value: "all", label: t("dashboard.allProjects") },
          ]}
        />
        <Segmented
          ariaLabel={t("dashboard.periodLabel")}
          value={String(days)}
          onChange={(v) => onDays(Number(v))}
          options={getPeriods(t).map((p) => ({ value: p.value, label: p.label }))}
        />
        <span className="text-[11px] text-[var(--ink-faint)]">
          {data ? `${periodLabel(t, data.period.days)} · ${data.period.from.slice(0, 10)} — ${data.period.to.slice(0, 10)}` : t("dashboard.calculating")}
        </span>
        <Tip text={t("dashboard.recalculate")}>
          <IconButton icon={RefreshCw} label={t("dashboard.recalculate")} size="sm" className="ml-auto" onClick={onRefresh} />
        </Tip>
      </div>

      {error && data === null ? (
        <p className="text-[12px] text-[var(--danger)]">{t("dashboard.summaryFailed", { error })}</p>
      ) : data === null ? (
        <p className="text-[12px] text-[var(--ink-faint)]">{t("dashboard.calculatingSummary")}</p>
      ) : (
        <div className={cn("min-h-0 flex-1 overflow-y-auto pb-2 transition-opacity duration-150", stale && "opacity-50")}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            <StatTile
              icon={CheckCheck}
              label={t("dashboard.finished")}
              value={String(data.totals.finished)}
              sub={t("dashboard.finishedSub", { done: data.totals.done, failed: data.totals.failed })}
              delta={deltas?.finished}
            />
            <StatTile
              icon={Target}
              label={t("dashboard.successRate")}
              value={formatPercent(data.totals.success_rate)}
              sub={data.totals.finished > 0 ? t("dashboard.successRateSub", { count: data.totals.finished }) : t("dashboard.nothingToFinish")}
              tone={successTone}
              delta={deltas?.success}
            />
            <StatTile
              icon={Coins}
              label={t("dashboard.spent")}
              value={formatCost(data.totals.cost_usd)}
              sub={
                data.totals.cost_known_tasks === 0
                  ? t("dashboard.noPriceData")
                  : t("dashboard.spentSub", { tokens: formatTokens(data.totals.tokens), exact: data.totals.cost_exact_tasks, known: data.totals.cost_known_tasks })
              }
              title={t("dashboard.spentTitle")}
              delta={deltas?.cost}
            />
            <StatTile
              icon={Timer}
              label={t("dashboard.medianWork")}
              value={formatDuration(t, data.totals.work_p50_sec)}
              sub={t("dashboard.medianWorkSub", { p90: formatDuration(t, data.totals.work_p90_sec), lead: formatDuration(t, data.totals.lead_p50_sec) })}
              title={t("dashboard.medianWorkTitle")}
              delta={deltas?.work}
            />
            <StatTile
              icon={Hand}
              label={t("dashboard.calledHuman")}
              value={String(data.totals.interventions)}
              sub={
                data.totals.answer_wait_p50_sec === null
                  ? t("dashboard.noAnswersInPeriod")
                  : t("dashboard.medianAnswer", { time: formatDuration(t, data.totals.answer_wait_p50_sec) })
              }
              tone={data.totals.interventions > 0 ? "var(--st-blocked)" : undefined}
              title={t("dashboard.calledHumanTitle")}
              delta={deltas?.interventions}
            />
          </div>

          {/* Forecast right under the tiles: the only thing on screen that speaks about the
             future. The limit is shared across the account, so the block is cut by neither
             scope nor period. */}
          <div className="mt-2">
            <ForecastPanel data={forecast} error={forecastError} projectId={allProjects ? null : project?.id ?? null} />
          </div>

          <div className="mt-2">
            <TimelineChart
              rows={data.flow}
              bucket={data.period.bucket}
              metric={metric}
              onMetric={onMetric}
              split={split}
              onSplit={onSplit}
              allowProjects={allProjects}
            />
          </div>

          {/* The breakdown is wider than the durations: it has seven columns, the other has
             one strip */}
          <div className="mt-2 grid items-start gap-2 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <BreakdownTable
              title={t(`dashboard.breakdown.title.${dim}`)}
              hint={t(`dashboard.breakdown.hint.${dim}`)}
              rows={table?.rows ?? []}
              keyLabel={t(`dashboard.breakdown.key.${dim}`)}
              renderKey={table?.renderKey}
              aside={
                <Segmented
                  ariaLabel={t("dashboard.breakdown.label")}
                  value={dim}
                  onChange={onBreakdown}
                  options={dims.map((d) => ({ value: d, label: t(`dashboard.breakdown.option.${d}`) }))}
                />
              }
            />
            <DurationChart durations={data.durations} />
          </div>

          <div className="mt-2">
            <TopCostTable rows={data.top_cost} onOpenTask={onOpenTask} showProject={allProjects} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Breakdown rows by attribute and the row key label. The key "—" means "not chosen on the card":
 * for a model it is "not specified", for effort and mode it is the Claude Code default.
 */
function breakdownRows(t: TFunction, dim: BreakdownDim, data: Analytics): { rows: AnalyticsRow[]; renderKey?: (key: string) => string } {
  switch (dim) {
    case "models":
      return { rows: data.models, renderKey: (key) => (key === "—" ? t("dashboard.notSpecified") : modelLabel(key)) };
    case "projects":
      return { rows: data.projects };
    case "efforts":
      return { rows: data.efforts, renderKey: (key) => (key === "—" ? t("dashboard.claudeDefault") : key) };
    case "permissions":
      return { rows: data.permissions, renderKey: (key) => (key === "—" ? t("dashboard.claudeDefault") : permissionLabel(key)) };
  }
}

/**
 * Tile deltas against the previous period of the same length. null means there is nothing to
 * compare with ("all time") or the measure was not computed in one of the periods.
 *
 * The tone is an assessment, not a direction: more finished is good; more failures, money and
 * questions to the human is bad; and "median work time" has no assessment: a long task may simply
 * be big.
 */
function tileDeltas(t: TFunction, data: Analytics): Record<"finished" | "success" | "work" | "cost" | "interventions", TileDelta | null> {
  const prev: AnalyticsPrevious | null = data.previous;
  const cur = data.totals;
  const empty = { finished: null, success: null, work: null, cost: null, interventions: null };
  // An empty previous period (the project is younger than the period) would give "+40" on every
  // tile: that is not a comparison but noise, so there are no deltas, just as for "all time"
  if (!prev || (prev.finished === 0 && prev.created === 0)) return empty;
  const against = periodLabel(t, data.period.days);

  const make = (diff: number, text: string, upIsGood: boolean | null, previous: string): TileDelta => ({
    text,
    tone: diff === 0 || upIsGood === null ? "neutral" : (diff > 0) === upIsGood ? "good" : "bad",
    title: t("dashboard.deltaTitle", { period: against, previous }),
  });
  const signed = (diff: number, body: string) => (diff > 0 ? `+${body}` : diff < 0 ? `−${body}` : `±${body}`);

  const count = (diff: number, upIsGood: boolean | null, previous: number) => make(diff, signed(diff, String(Math.abs(diff))), upIsGood, String(previous));

  return {
    finished: count(cur.finished - prev.finished, true, prev.finished),
    success:
      cur.success_rate === null || prev.success_rate === null
        ? null
        : make(
            cur.success_rate - prev.success_rate,
            signed(Math.round((cur.success_rate - prev.success_rate) * 100), `${Math.abs(Math.round((cur.success_rate - prev.success_rate) * 100))}%`),
            true,
            formatPercent(prev.success_rate),
          ),
    work:
      cur.work_p50_sec === null || prev.work_p50_sec === null
        ? null
        : make(cur.work_p50_sec - prev.work_p50_sec, signed(cur.work_p50_sec - prev.work_p50_sec, formatDuration(t, Math.abs(cur.work_p50_sec - prev.work_p50_sec))), null, formatDuration(t, prev.work_p50_sec)),
    cost: make(cur.cost_usd - prev.cost_usd, signed(Math.round((cur.cost_usd - prev.cost_usd) * 100), formatCost(Math.abs(cur.cost_usd - prev.cost_usd))), false, formatCost(prev.cost_usd)),
    interventions: count(cur.interventions - prev.interventions, false, prev.interventions),
  };
}
