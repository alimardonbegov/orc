import type { TFunction } from "./i18n";
import type { Routine, RoutineRun } from "./types";

/**
 * Recurring tasks on the dashboard side: converting an interval into "number + unit", ready-made
 * cron expressions for the form, and time labels. The schedule is computed by the server (orc/recurrence.py) —
 * here is only what is needed to show and enter it in a human-friendly way.
 */

export type IntervalUnit = "minutes" | "hours" | "days";

export const UNIT_MINUTES: Record<IntervalUnit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

/** Minimum interval — as on the server (MIN_INTERVAL_MINUTES): launching more often would burn through limits. */
export const MIN_INTERVAL_MINUTES = 5;

/** 120 minutes → 2 hours: the largest unit the interval divides into evenly. */
export function splitInterval(minutes: number | null | undefined): { value: number; unit: IntervalUnit } {
  const m = minutes && minutes > 0 ? minutes : 60;
  if (m % UNIT_MINUTES.days === 0) return { value: m / UNIT_MINUTES.days, unit: "days" };
  if (m % UNIT_MINUTES.hours === 0) return { value: m / UNIT_MINUTES.hours, unit: "hours" };
  return { value: m, unit: "minutes" };
}

export function joinInterval(value: number, unit: IntervalUnit): number {
  return Math.round(value * UNIT_MINUTES[unit]);
}

/** Ready-made cron expressions: the key is the dictionary label (routines.presets.*). */
export const CRON_PRESETS: { key: string; cron: string }[] = [
  { key: "hourly", cron: "0 * * * *" },
  { key: "daily", cron: "0 9 * * *" },
  { key: "weekdays", cron: "0 9 * * 1-5" },
  { key: "weekly", cron: "0 9 * * 1" },
  { key: "monthly", cron: "0 9 1 * *" },
];

/** Browser time zone: cron "at 9:00" is read by the owner's clock, not the server's. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "in 23 min", "in 5 h", "in 2 d" — for the next run. A past time — "now". */
export function untilLabel(at: number, locale: string, now: number): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const diff = at - now;
  if (diff < MINUTE) return rtf.format(0, "second");
  if (diff < HOUR) return rtf.format(Math.ceil(diff / MINUTE), "minute");
  if (diff < DAY) return rtf.format(Math.round(diff / HOUR), "hour");
  return rtf.format(Math.round(diff / DAY), "day");
}

/** Slot time: "14:00", and if not today — "Oct 8, 09:00". */
export function slotTime(at: number, locale: string, now: number): string {
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  return d.toLocaleString(locale, today ? { hour: "2-digit", minute: "2-digit" } : {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

/** How long a run took: from session start to completion (for a failed one — to the last change).
 *  null — has not started or finished yet. */
export function runDuration(run: RoutineRun): number | null {
  const end = run.done_at ?? (run.status === "failed" ? run.updated_at : null);
  if (!run.started_at || !end) return null;
  const ms = Date.parse(end) - Date.parse(run.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Run summary line: the report's summary, otherwise the failure reason. */
export function runOutcome(run: RoutineRun): string {
  return run.report?.summary?.trim() || run.blocker_detail?.trim() || "";
}

/** Share of successful runs among completed ones, 0..1. null — no completed runs yet. */
export function successRate(routine: Pick<Routine, "stats">): number | null {
  const finished = routine.stats.done + routine.stats.failed;
  return finished > 0 ? routine.stats.done / finished : null;
}

/** The schedule in human terms in the dashboard language: "every hour", "every 15 min", "cron 0 9 * * 1-5 · Europe/Moscow". */
export function scheduleText(
  t: TFunction,
  r: Pick<Routine, "schedule_kind" | "interval_minutes" | "cron" | "timezone">,
): string {
  if (r.schedule_kind === "cron") return t("routines.schedule.cron", { cron: r.cron ?? "", tz: r.timezone ?? "UTC" });
  const { value, unit } = splitInterval(r.interval_minutes);
  if (value === 1 && unit === "hours") return t("routines.schedule.hourly");
  if (value === 1 && unit === "days") return t("routines.schedule.daily");
  const key = unit === "days" ? "everyDays" : unit === "hours" ? "everyHours" : "everyMinutes";
  return t(`routines.schedule.${key}`, { n: value });
}
