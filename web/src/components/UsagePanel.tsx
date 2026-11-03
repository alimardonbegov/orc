import { Gauge, RefreshCw } from "lucide-react";
import type { UsageStatus } from "../types";
import { IconButton } from "../ui/Button";
import { Tip } from "../ui/Overlays";
import { cn } from "../lib/cn";
import { useTranslation, type TFunction, type Language } from "../i18n";

interface Props {
  status: UsageStatus | null;
  onRefresh: () => void;
  pending?: boolean;
  /** Collapsed rail: no labels, both indicators remain (five-hour first) with a tooltip. */
  collapsed?: boolean;
}

/** Windows to show. A window the account does not have (a plan without a five-hour limit) is not drawn
 *  at all — an empty "—" row would read as "we don't know yet". */
function getWindows(t: TFunction, status: UsageStatus | null) {
  const absent = status?.absent ?? [];
  return ([
    { key: "five_hour", label: t("usagePanel.fiveHours"), short: t("usagePanel.fiveHoursShort") },
    { key: "seven_day", label: t("usagePanel.week"), short: t("usagePanel.weekShort") },
  ] as const).filter(({ key }) => !absent.includes(key));
}

const timeLabel = (epochSec: number, locale: string) =>
  new Date(epochSec * 1000).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
const dateLabel = (epochSec: number, locale: string) =>
  new Date(epochSec * 1000).toLocaleDateString(locale, { day: "numeric", month: "short" });

/** "until 14:30" for the five-hour window and "until Sep 23" for the weekly one: the hour of the week is useless. */
const resetLabel = (key: string, epochSec: number, locale: string) =>
  key === "five_hour" ? timeLabel(epochSec, locale) : dateLabel(epochSec, locale);

function toneVar(pct: number): string {
  if (pct >= 90) return "var(--danger)";
  if (pct >= 70) return "var(--warn)";
  return "var(--ink-muted)";
}

/** When the snapshot was taken: we won't lie with "just now", and the exact time is the most honest. */
function freshness(t: TFunction, locale: string, status: UsageStatus): string {
  if (status.updated_at == null) return t("usagePanel.freshnessUnknown");
  const mins = Math.max(0, Math.round((Date.now() - status.updated_at * 1000) / 60000));
  if (mins < 2) return t("usagePanel.justNow");
  if (mins < 60) return t("usagePanel.minsAgo", { count: mins });
  return t("usagePanel.atTime", { time: timeLabel(status.updated_at, locale) });
}

function sourceLabel(t: TFunction, status: UsageStatus): string {
  if (status.source === "claude_json") return t("usagePanel.sourceClaudeJson");
  if (status.source === "statusline") return t("usagePanel.sourceStatusline");
  return t("usagePanel.sourcePoll");
}

function hint(t: TFunction, language: Language, status: UsageStatus | null): string {
  const how = t("usagePanel.howButton");
  if (!status || !status.available) {
    return `${t("usagePanel.unknownYet")} ${how}`;
  }
  // The reset time is duplicated in the tooltip: in the expanded panel the window row already
  // shows it itself (see Window), but the collapsed rail has nowhere else to get
  // it — only the number and the bar remain of each window there.
  const resets = getWindows(t, status).map(({ key, short }) => {
    const w = status[key];
    return w && w.resets_at != null ? t("usagePanel.resetUntil", { short, until: resetLabel(key, w.resets_at, language) }) : null;
  }).filter(Boolean);
  const when = resets.length > 0 ? t("usagePanel.resetsSuffix", { list: resets.join(", ") }) : "";
  const where = t("usagePanel.sourceMeasured", { source: sourceLabel(t, status), freshness: freshness(t, language, status) }) + when;
  if (status.stale) return `${where} ${how}`;
  return where;
}

/** One limit window in the collapsed rail: the number on top, the bar below, no label — only a tooltip. */
function CollapsedWindow({ pct }: { pct: number | null }) {
  return (
    <span className="flex flex-col items-center gap-[3px]">
      <span
        className="tnum text-[9px] font-semibold leading-none"
        style={{ color: pct == null ? "var(--ink-faint)" : toneVar(pct) }}
      >
        {pct == null ? "—" : Math.round(pct)}
      </span>
      <span aria-hidden className="h-[3px] w-5 overflow-hidden rounded-full bg-[var(--sunken)]">
        <span
          className="block h-full rounded-full"
          style={{
            width: pct == null ? "0%" : `${Math.max(2, Math.min(100, pct))}%`,
            background: pct == null ? "var(--line-strong)" : toneVar(pct),
          }}
        />
      </span>
    </span>
  );
}

/** One limit window in a single row: label, bar, percentage, reset time. */
function Window({ label, pct, reset }: { label: string; pct: number | null; reset: string | null }) {
  const { t } = useTranslation();
  const width = pct == null ? 0 : Math.max(2, Math.min(100, pct));
  return (
    <div className="flex items-center gap-1.5 text-[11px] leading-none">
      <span className="w-10 shrink-0 text-[var(--ink-muted)]">{label}</span>
      <span aria-hidden className="h-[3px] min-w-[14px] flex-1 overflow-hidden rounded-full bg-[var(--sunken)]">
        <span
          className="block h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${width}%`, background: pct == null ? "var(--line-strong)" : toneVar(pct) }}
        />
      </span>
      <span
        className="tnum w-7 shrink-0 text-right font-medium"
        style={{ color: pct == null ? "var(--ink-faint)" : toneVar(pct) }}
      >
        {pct == null ? "—" : `${Math.round(pct)}%`}
      </span>
      {reset && <span className="tnum shrink-0 text-[10px] text-[var(--ink-faint)]">{t("usagePanel.until", { reset })}</span>}
    </div>
  );
}

/**
 * Claude Code account limits — the 5-hour and weekly windows, not the current task's usage
 * (that lives in the card badge and in the "Tokens" section of the modal). The five-hour window may be
 * absent (some Ultra plans) — then a single row remains.
 *
 * They live at the bottom of the left column, not in the header: this is background information, not a board control, and
 * they took up space next to the filters for nothing. The orchestrator obtains the numbers itself (orc/usage.py):
 * for free — from the statusline of its own sessions; on button press and when the data is stale — with a probe
 * request to Claude. It no longer depends on the terminal statusline.
 */
export function UsagePanel({ status, onRefresh, pending, collapsed }: Props) {
  const { t, language } = useTranslation();
  const empty = !status || !status.available;

  if (collapsed) {
    // The five-hour window is the session one and matters more at a glance, so it goes first.
    const hasAny = !empty && (status!.five_hour != null || status!.seven_day != null);
    return (
      <Tip side="right" text={hint(t, language, status)}>
        <button
          type="button"
          onClick={onRefresh}
          aria-label={t("usagePanel.askAgain")}
          className={cn(
            "mx-auto flex w-7 flex-col items-center justify-center gap-1.5 rounded-[var(--radius-sm)] py-0.5",
            "text-[var(--ink-faint)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]",
          )}
        >
          {!hasAny ? (
            <Gauge size={13} aria-hidden />
          ) : (
            <>
              {getWindows(t, status).map(({ key }) => (
                <CollapsedWindow key={key} pct={status![key] ? status![key]!.used_percentage : null} />
              ))}
            </>
          )}
        </button>
      </Tip>
    );
  }

  return (
    <div className={cn("px-1 pb-0.5", empty || status!.stale ? "opacity-80" : "")}>
      <div className="flex items-center gap-1">
        <Tip side="right" text={hint(t, language, status)}>
          <span className="flex cursor-help items-center gap-1 text-[11px] font-medium text-[var(--ink-faint)]">
            {t("usagePanel.heading")}
            {!empty && status!.stale && <span className="text-[var(--ink-faint)]">· {freshness(t, language, status!)}</span>}
          </span>
        </Tip>
        <IconButton icon={RefreshCw} label={t("usagePanel.askButton")} size="sm" loading={pending} onClick={onRefresh} className="ml-auto" />
      </div>

      {empty ? (
        <p className="pb-1 pt-0.5 text-[11px] leading-snug text-[var(--ink-faint)]">
          {t("usagePanel.unknownHint")}
        </p>
      ) : (
        <div className="space-y-1.5 pb-0.5 pt-1.5">
          {getWindows(t, status).map(({ key, label }) => {
            const w = status![key];
            return (
              <Window
                key={key}
                label={label}
                pct={w ? w.used_percentage : null}
                reset={w && w.resets_at != null ? resetLabel(key, w.resets_at, language) : null}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
