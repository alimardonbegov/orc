import type { Task } from "./types";
import type { TFunction } from "./i18n";
import { finishedAt } from "./sort";

/**
 * Task life dates: created → picked up → done (or failed).
 *
 * On the board each column has its own "main" date: in the queue it matters how long the card
 * has been sitting, in progress — how long the agent has been working on it, in "Done" — when it closed.
 * The label on the card always has a verb ("done 2 h ago"), not a bare "2 h ago":
 * otherwise it is unclear which of the three moments is meant.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Which moment of the task's life the card shows. */
export type MomentKind = "created" | "started" | "done" | "failed";

export interface TaskMoment {
  kind: MomentKind;
  /** The moment in ms. */
  at: number;
}

const parse = (raw: string | null | undefined): number | null => {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
};

export const createdAt = (task: Task): number | null => parse(task.created_at);
export const startedAt = (task: Task): number | null => parse(task.started_at);

/** The card's main date — depends on which column it is in. */
export function cardMoment(task: Task): TaskMoment | null {
  switch (task.status) {
    case "done":
      return { kind: "done", at: finishedAt(task) };
    case "failed":
      return { kind: "failed", at: finishedAt(task) };
    case "in_progress":
    case "verifying":
    case "merging": {
      // The session may not have registered yet (the task was just launched) —
      // then it is more honest to show when the task was created than to invent a start.
      const started = startedAt(task);
      if (started !== null) return { kind: "started", at: started };
      break;
    }
  }
  const created = createdAt(task);
  return created === null ? null : { kind: "created", at: created };
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Difference in calendar days: "yesterday" is yesterday's date, not "24 hours ago". */
const calendarDays = (at: number, now: number) => Math.round((startOfDay(now) - startOfDay(at)) / DAY);

/**
 * "just now" / "5 min ago" / "3 h ago" / "yesterday" / "4 d ago", and beyond a week —
 * just a date: "Sep 12" (with the year if it is not the current one). The words come from Intl, so
 * no separate dictionary strings are needed for this.
 */
export function relativeTime(at: number, locale: string, now: number): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const diff = Math.max(0, now - at);
  if (diff < MINUTE) return rtf.format(0, "second");
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), "minute");
  const days = calendarDays(at, now);
  if (diff < 12 * HOUR || days === 0) return rtf.format(-Math.floor(diff / HOUR), "hour");
  if (days < 7) return rtf.format(-days, "day");
  return shortDate(at, locale, now);
}

/** "Sep 12" or "Sep 12, 2025" — the year only if it is not the current one. */
export function shortDate(at: number, locale: string, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Full date with time — for tooltips and the timeline in the task modal. */
export function fullDateTime(at: number, locale: string): string {
  return new Date(at).toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Duration: "<1 min", "45 min", "2 h 5 min", "3 d 4 h". The two largest units, no more. */
export function formatDuration(t: TFunction, ms: number): string {
  const total = Math.max(0, ms);
  if (total < MINUTE) return t("dates.duration.lessThanMinute");
  if (total < HOUR) return t("dates.duration.minutes", { m: Math.floor(total / MINUTE) });
  if (total < DAY) {
    const h = Math.floor(total / HOUR);
    const m = Math.floor((total % HOUR) / MINUTE);
    return m === 0 ? t("dates.duration.hoursOnly", { h }) : t("dates.duration.hours", { h, m });
  }
  const d = Math.floor(total / DAY);
  const h = Math.floor((total % DAY) / HOUR);
  return h === 0 ? t("dates.duration.daysOnly", { d }) : t("dates.duration.days", { d, h });
}

/** Label on the card: "created 3 d ago", "in progress 45 min", "done yesterday". */
export function momentLabel(t: TFunction, moment: TaskMoment, locale: string, now: number): string {
  if (moment.kind === "started") return t("dates.card.started", { duration: formatDuration(t, now - moment.at) });
  return t(`dates.card.${moment.kind}`, { time: relativeTime(moment.at, locale, now) });
}

/** Timeline row: which moment, when, and how much time passed since the previous step. */
export interface TimelineStep {
  kind: MomentKind;
  at: number;
  /** How long the previous stage lasted: queue wait for the start, work for the finish. */
  since?: number;
}

/**
 * The task timeline in order. The "picked up" step is skipped if there were no sessions
 * (the card was closed by hand or is still queued), the finish — if the task is not finished.
 */
export function timeline(task: Task): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const created = createdAt(task);
  if (created !== null) steps.push({ kind: "created", at: created });
  const started = startedAt(task);
  if (started !== null) steps.push({ kind: "started", at: started, since: created !== null ? started - created : undefined });
  if (task.status === "done" || task.status === "failed") {
    // Work duration — only from a real start: for a card closed without a single
    // session, "in progress for so long" would be untrue.
    const end = finishedAt(task);
    steps.push({ kind: task.status, at: end, since: started !== null ? end - started : undefined });
  }
  return steps;
}

/** Tooltip for the card label: the whole timeline line by line, with exact time. */
export function timelineTitle(t: TFunction, task: Task, locale: string): string {
  return timeline(task)
    .map((s) => `${t(`dates.timeline.${s.kind}`)}: ${fullDateTime(s.at, locale)}`)
    .join("\n");
}

/** Day heading in the "Done" column: "Today" / "Yesterday" / "September 21" (+ year if not current). */
export function dayHeading(t: TFunction, at: number, locale: string, now: number): string {
  const days = calendarDays(at, now);
  if (days <= 0) return t("dates.today");
  if (days === 1) return t("dates.yesterday");
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(locale, { day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}
