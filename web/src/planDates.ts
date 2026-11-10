/**
 * Planning days of a card: `YYYY-MM-DD`, no time and no time zone. They describe the plan for people;
 * the dispatcher never reads them (the deferred start, `start_after`, is a different thing).
 */

import type { TaskStatus } from "./types";

/** Today in the browser's calendar, as `YYYY-MM-DD`. */
export function todayKey(now: number = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A due date in the past on a card that is not finished. Done is done, whenever the date was. */
export function isOverdue(due: string | null | undefined, status: TaskStatus, today: string): boolean {
  return Boolean(due) && status !== "done" && (due as string) < today;
}

/** A day for a person: "7 Nov" in the interface language, with the year when it is not this one. */
export function formatDay(day: string, locale: string, now: number = Date.now()): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const at = new Date(y, m - 1, d);
  const sameYear = y === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
}
