import type { TFunction } from "./i18n";
import type { Wakeup } from "./types";

/** "14:30" today, "Nov 9, 14:30" on another day: a wakeup is near, and the date only matters when it is not today. */
export function wakeTime(iso: string, locale: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return at.toLocaleString(locale, {
    ...(sameDay ? {} : { day: "numeric", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The condition in the owner's language, built from the fields rather than the server's English summary. */
export function wakeupCondition(t: TFunction, wakeup: Wakeup, locale: string, now?: number): string {
  if (wakeup.kind === "task" && wakeup.watch_task_id !== null) {
    const base = t("card.wakeups.task", { id: wakeup.watch_task_id });
    return wakeup.wake_at ? `${base}, ${t("card.wakeups.deadline", { time: wakeTime(wakeup.wake_at, locale, now) })}` : base;
  }
  return t("card.wakeups.at", { time: wakeup.wake_at ? wakeTime(wakeup.wake_at, locale, now) : "?" });
}
