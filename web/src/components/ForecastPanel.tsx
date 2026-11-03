import { useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, OctagonX, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Forecast, ForecastProject, ForecastVerdict, ForecastWindow, ForecastWindowKey } from "../types";
import { formatDuration } from "../analytics";
import { formatCost, formatExact, formatPct, formatTokens } from "../usage";
import { Figure, NoData } from "./charts/Figure";
import { Segmented } from "../ui/Segmented";
import { cn } from "../lib/cn";
import { useTranslation, type Language, type TFunction } from "../i18n";

interface Props {
  data: Forecast | null;
  error: string | null;
  /** Project selected in the sidebar: we highlight its row. null means a slice across all. */
  projectId: number | null;
}

const VERDICT: Record<ForecastVerdict, { tone: string; icon: LucideIcon }> = {
  ok: { tone: "var(--st-done)", icon: CheckCircle2 },
  tight: { tone: "var(--warn)", icon: AlertTriangle },
  over: { tone: "var(--danger)", icon: TrendingUp },
  hit: { tone: "var(--danger)", icon: OctagonX },
  unknown: { tone: "var(--ink-faint)", icon: CircleHelp },
};

/** Moment for a window: for the five-hour one the hour matters, for the weekly one the day and
 * hour. */
function momentLabel(key: ForecastWindowKey, epochSec: number, language: Language): string {
  const d = new Date(epochSec * 1000);
  const time = d.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date().toDateString() === d.toDateString();
  if (key === "five_hour" && sameDay) return time;
  return `${d.toLocaleDateString(language, { day: "numeric", month: "short" })} ${time}`;
}

function verdictText(t: TFunction, language: Language, key: ForecastWindowKey, w: ForecastWindow): string {
  switch (w.verdict) {
    case "ok":
      return t("dashboard.forecast.verdictOk");
    case "tight":
      return t("dashboard.forecast.verdictTight");
    case "over":
      return t("dashboard.forecast.verdictOver", { time: w.hits_limit_at != null ? momentLabel(key, w.hits_limit_at, language) : "—" });
    case "hit":
      return t("dashboard.forecast.verdictHit");
    default:
      return t("dashboard.forecast.verdictUnknown");
  }
}

function paceText(t: TFunction, key: ForecastWindowKey, w: ForecastWindow): string | null {
  if (w.pace_pct_per_hour == null) return null;
  const pace = formatPct(w.pace_pct_per_hour);
  if (w.pace_basis === "window") return t("dashboard.forecast.paceWindow", { pace });
  const main = t(key === "five_hour" ? "dashboard.forecast.paceRecentHour" : "dashboard.forecast.paceRecentDay", { pace });
  return w.avg_pct_per_hour != null ? `${main} · ${t("dashboard.forecast.avgAside", { pace: formatPct(w.avg_pct_per_hour) })}` : main;
}

/**
 * Window bar: the solid part is already spent, the translucent part is how much will be added by
 * the reset at the current pace. The scale always goes to 100%: "we will hit it" is when the
 * forecast reaches the right edge, and drawing an overshoot beyond it is pointless, it is in the
 * words next to it.
 */
function WindowMeter({ used, projected, tone }: { used: number; projected: number | null; tone: string }) {
  const u = Math.max(0, Math.min(100, used));
  const p = projected == null ? u : Math.max(u, Math.min(100, projected));
  return (
    <div aria-hidden className="relative h-2 overflow-hidden rounded-full bg-[var(--sunken)]">
      <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${p}%`, background: `color-mix(in oklab, ${tone} 30%, transparent)` }} />
      <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(u, 1.5)}%`, background: tone }} />
    </div>
  );
}

function WindowCard({ windowKey, w, spendLeader }: { windowKey: ForecastWindowKey; w: ForecastWindow; spendLeader: ForecastProject | null }) {
  const { t, language } = useTranslation();
  const { tone, icon: Icon } = VERDICT[w.verdict];
  const label = windowKey === "five_hour" ? t("dashboard.forecast.fiveHour") : t("dashboard.forecast.week");
  const pace = paceText(t, windowKey, w);
  const leftSec = w.hits_limit_at != null && w.resets_at != null ? w.resets_at - w.hits_limit_at : null;
  const warn = w.verdict === "over" || w.verdict === "tight" || w.verdict === "hit";
  const byCost = w.spend.measure === "cost";
  const leaderPace = spendLeader ? (byCost ? spendLeader.pace_cost_per_hour : spendLeader.pace_tokens_per_hour) : 0;

  return (
    <div className="min-w-0 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2.5" data-testid={`forecast-${windowKey}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-medium text-[var(--ink-muted)]">{label}</span>
        {w.resets_at != null && (
          <span className="tnum text-[11px] text-[var(--ink-faint)]">{t("dashboard.forecast.resetsAt", { time: momentLabel(windowKey, w.resets_at, language) })}</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[22px] font-semibold leading-none tracking-tight text-[var(--ink)]">{w.used_pct == null ? "—" : formatPct(w.used_pct)}</span>
        {/* Verdict: an icon and words, not only colour: yellow and red on the bar are easy
           to confuse */}
        <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--ink)]">
          <Icon size={13} aria-hidden style={{ color: tone }} />
          {verdictText(t, language, windowKey, w)}
          {w.verdict === "over" && leftSec != null && leftSec > 0 && (
            <span className="font-normal text-[var(--ink-muted)]">· {t("dashboard.forecast.overLeft", { left: formatDuration(t, leftSec) })}</span>
          )}
        </span>
        {w.projected_pct != null && w.verdict !== "hit" && (
          <span className="tnum ml-auto text-[11px] text-[var(--ink-muted)]">{t("dashboard.forecast.projected", { pct: formatPct(w.projected_pct) })}</span>
        )}
      </div>
      {w.used_pct != null && (
        <div className="mt-2">
          <WindowMeter used={w.used_pct} projected={w.projected_pct} tone={tone} />
        </div>
      )}
      <div className="mt-1.5 space-y-0.5 text-[11px] leading-snug text-[var(--ink-muted)]">
        {pace && <p className="tnum m-0">{pace}</p>}
        {w.verdict === "unknown" && w.used_pct != null && <p className="m-0 text-[var(--ink-faint)]">{t("dashboard.forecast.earlyWindow")}</p>}
        {w.verdict === "over" && w.slowdown_to_pct != null && w.safe_pace_pct_per_hour != null && (
          <p className="m-0 text-[var(--ink)]">{t("dashboard.forecast.slowDown", { pct: w.slowdown_to_pct, safe: formatPct(w.safe_pace_pct_per_hour) })}</p>
        )}
        {warn && spendLeader && (
          <p className="m-0 text-[var(--ink)]">
            {leaderPace > 0
              ? t("dashboard.forecast.leader", {
                  project: spendLeader.project,
                  pace: byCost ? formatCost(spendLeader.pace_cost_per_hour) : formatTokens(spendLeader.pace_tokens_per_hour),
                })
              : t("dashboard.forecast.leaderIdle", { project: spendLeader.project })}
          </p>
        )}
      </div>
    </div>
  );
}

/** Who spends within the selected window: money, share, estimate of the limit share, pace, time to
 * reset. */
function SpendTable({ w, projectId }: { w: ForecastWindow; projectId: number | null }) {
  const { t } = useTranslation();
  const rows = w.spend.projects;
  if (rows.length === 0) return <NoData>{t("dashboard.forecast.noSpend")}</NoData>;
  const byCost = w.spend.measure === "cost";
  const maxShare = Math.max(...rows.map((r) => r.share), 0.0001);
  const money = (usd: number, tokens: number) => (byCost ? `${formatCost(usd)} · ${formatTokens(tokens)}` : formatTokens(tokens));
  const pace = (r: ForecastProject) => (byCost ? formatCost(r.pace_cost_per_hour) : formatTokens(r.pace_tokens_per_hour));
  const th = "px-1.5 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-[var(--ink-faint)]";

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-[var(--line)]">
            <th className={th}>{t("dashboard.forecast.colProject")}</th>
            <th className={cn(th, "text-right")}>{t("dashboard.forecast.colSpent")}</th>
            <th className={cn(th, "w-[28%]")}>{t("dashboard.forecast.colShare")}</th>
            <th className={cn(th, "text-right")} title={t("dashboard.forecast.limitMaxTitle")}>{t("dashboard.forecast.colLimit")}</th>
            <th className={cn(th, "text-right")}>{t("dashboard.forecast.colPace")}</th>
            <th className={cn(th, "text-right")}>{t("dashboard.forecast.colProjected")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const current = projectId !== null && r.project_id === projectId;
            const fastest = r.project_id === w.spend.leader_project_id && (byCost ? r.pace_cost_per_hour : r.pace_tokens_per_hour) > 0;
            return (
              <tr
                key={String(r.project_id)}
                className={cn("border-b border-[var(--line)] last:border-b-0", current && "bg-[color-mix(in_oklab,var(--ink)_5%,transparent)]")}
                title={`${formatExact(r.tokens)} · ${r.tasks}`}
              >
                <td className="max-w-[180px] truncate px-1.5 py-1 text-[var(--ink)]">
                  {r.project}
                  {current && <span className="ml-1.5 text-[10px] text-[var(--ink-faint)]">{t("dashboard.forecast.current")}</span>}
                  {fastest && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-[var(--ink-muted)]">
                      <TrendingUp size={10} aria-hidden />
                      {t("dashboard.forecast.fastest")}
                    </span>
                  )}
                </td>
                <td className="tnum whitespace-nowrap px-1.5 py-1 text-right font-mono text-[var(--ink)]">{money(r.cost_usd, r.tokens)}</td>
                <td className="px-1.5 py-1">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--sunken)]">
                      <span className="block h-full rounded-full bg-[var(--ink-muted)]" style={{ width: `${Math.max(2, (r.share / maxShare) * 100)}%` }} />
                    </span>
                    <span className="tnum w-9 text-right font-mono text-[11px] text-[var(--ink-muted)]">{Math.round(r.share * 100)}%</span>
                  </span>
                </td>
                <td className="tnum whitespace-nowrap px-1.5 py-1 text-right font-mono text-[var(--ink-muted)]" title={t("dashboard.forecast.limitMaxTitle")}>
                  {r.limit_pct_max == null ? "—" : `≤ ${formatPct(r.limit_pct_max)}`}
                </td>
                <td className="tnum whitespace-nowrap px-1.5 py-1 text-right font-mono text-[var(--ink-muted)]">{pace(r)}</td>
                <td className="tnum whitespace-nowrap px-1.5 py-1 text-right font-mono text-[var(--ink-muted)]">{money(r.projected_cost_usd, r.projected_tokens)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Claude limits forecast and spend by project (orc/forecast.py).
 *
 * Answers two questions at once, because the second is asked only after the first: "will I hit the
 * limit before the reset" and, if so, "who is eating it". On top are two limit windows with a
 * verdict and a hint on how much to slow down; below is a table of projects within the selected
 * window. The limit is shared across the account, so the block is not cut by the dashboard scope:
 * the selected project is only highlighted.
 */
export function ForecastPanel({ data, error, projectId }: Props) {
  const { t, language } = useTranslation();
  const [chosen, setChosen] = useState<ForecastWindowKey | null>(null);

  // A response of a foreign shape (say, an SPA newer than the server) is treated as if there were
  // none yet, not as a dashboard crash
  if (data === null || !data.five_hour || !data.seven_day) {
    return (
      <Figure title={t("dashboard.forecast.title")} hint={t("dashboard.forecast.hint")}>
        <NoData>{error ? t("dashboard.forecast.failed", { error }) : t("common.loading")}</NoData>
      </Figure>
    );
  }

  // Windows the account does not have (a plan without a five-hour limit) are not drawn at all
  const absent = data.absent ?? [];
  const keys = (["five_hour", "seven_day"] as const).filter((k) => !absent.includes(k));
  const shown: ForecastWindowKey[] = keys.length > 0 ? [...keys] : ["seven_day"];
  // The default table is about the window that is more worrying: the five-hour one if both are calm
  const alarming = (w: ForecastWindow) => w.verdict === "over" || w.verdict === "hit";
  const preferred: ForecastWindowKey = shown.length === 1 ? shown[0]
    : !alarming(data.five_hour) && alarming(data.seven_day) ? "seven_day" : "five_hour";
  const windowKey: ForecastWindowKey = chosen !== null && shown.includes(chosen) ? chosen : preferred;
  const selected = data[windowKey];
  const leaderOf = (w: ForecastWindow) => w.spend.projects.find((p) => p.project_id === w.spend.leader_project_id) ?? null;
  const ledgerLate = data.ledger_since !== null && data.ledger_since > selected.spend_since;

  return (
    <Figure title={t("dashboard.forecast.title")} hint={t("dashboard.forecast.hint")}>
      {!data.available ? (
        <p className="m-0 mb-2 text-[11px] text-[var(--ink-faint)]">{t("dashboard.forecast.unavailable")}</p>
      ) : (
        data.stale && <p className="m-0 mb-2 text-[11px] text-[var(--warn)]">{t("dashboard.forecast.stale")}</p>
      )}
      {data.available && (
        <div className={cn("grid gap-2", shown.length > 1 && "md:grid-cols-2")}>
          {shown.map((key) => <WindowCard key={key} windowKey={key} w={data[key]} spendLeader={leaderOf(data[key])} />)}
        </div>
      )}

      <div className="mb-1.5 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="m-0 text-[12px] font-semibold text-[var(--ink)]">{t("dashboard.forecast.spendTitle")}</h4>
        <span className="text-[11px] text-[var(--ink-faint)]">{t("dashboard.forecast.spendHint")}</span>
        {shown.length > 1 && (
          <Segmented
            className="ml-auto"
            ariaLabel={t("dashboard.forecast.windowSwitch")}
            value={windowKey}
            onChange={setChosen}
            options={[
              { value: "five_hour", label: t("dashboard.forecast.fiveHour") },
              { value: "seven_day", label: t("dashboard.forecast.week") },
            ]}
          />
        )}
      </div>
      <SpendTable w={selected} projectId={projectId} />
      <p className="m-0 mt-1.5 text-[10px] leading-snug text-[var(--ink-faint)]">
        {selected.spend.measure === "cost" ? t("dashboard.forecast.shareByCost") : t("dashboard.forecast.shareByTokens")}{" "}
        {t("dashboard.forecast.limitMaxTitle")}
        {ledgerLate && ` ${t("dashboard.forecast.ledgerNote", { date: new Date(data.ledger_since!).toLocaleDateString(language, { day: "numeric", month: "short" }) })}`}
      </p>
    </Figure>
  );
}
