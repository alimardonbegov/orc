import { CalendarPlus, CircleDashed, type LucideIcon } from "lucide-react";
import type { Task } from "../types";
import { STATUS_META } from "../status";
import { formatDuration, fullDateTime, relativeTime, timeline, type MomentKind } from "../dates";
import { useNow } from "../hooks/useNow";
import { useTranslation } from "../i18n";
import { cn } from "../lib/cn";

const ICON: Record<MomentKind, LucideIcon> = {
  created: CalendarPlus,
  started: STATUS_META.in_progress.icon,
  done: STATUS_META.done.icon,
  failed: STATUS_META.failed.icon,
};

const TONE: Record<MomentKind, string> = {
  created: "text-[var(--ink-faint)]",
  started: STATUS_META.in_progress.fg,
  done: STATUS_META.done.fg,
  failed: STATUS_META.failed.fg,
};

/**
 * Task timeline in the modal: when it was created, picked up, and closed —
 * with exact time, "how long ago" and stage duration (waited in the queue / was in progress).
 * The card shows only one moment (see cardMoment); here all of them at once.
 */
export function TaskTimeline({ task }: { task: Task }) {
  const { t, language } = useTranslation();
  const now = useNow();
  const steps = timeline(task);
  // The task is still queued: an empty "picked up" row is more honest than leaving it out —
  // it shows the step is ahead, not lost.
  const waiting = (task.status === "backlog" || task.status === "todo") && !steps.some((s) => s.kind === "started");

  return (
    <section aria-label={t("dates.timeline.heading")} className="rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-1.5">
      <ol>
        {steps.map((s) => {
          const Icon = ICON[s.kind];
          return (
            <li key={s.kind} className="flex min-w-0 items-center gap-2 py-1">
              <Icon size={12} className={cn("shrink-0", TONE[s.kind])} aria-hidden />
              <span className="w-28 shrink-0 text-[11px] text-[var(--ink-faint)]">{t(`dates.timeline.${s.kind}`)}</span>
              <time dateTime={new Date(s.at).toISOString()} className="tnum shrink-0 text-[12px] text-[var(--ink)]">
                {fullDateTime(s.at, language)}
              </time>
              <span className="tnum min-w-0 truncate text-[11px] text-[var(--ink-faint)]">· {relativeTime(s.at, language, now)}</span>
              {s.since !== undefined && (
                <span className="tnum ml-auto shrink-0 text-[11px] text-[var(--ink-muted)]">
                  {t(s.kind === "started" ? "dates.timeline.waited" : "dates.timeline.worked", {
                    duration: formatDuration(t, s.since),
                  })}
                </span>
              )}
            </li>
          );
        })}
        {waiting && (
          <li className="flex min-w-0 items-center gap-2 py-1">
            <CircleDashed size={12} className="shrink-0 text-[var(--ink-faint)]" aria-hidden />
            <span className="w-28 shrink-0 text-[11px] text-[var(--ink-faint)]">{t("dates.timeline.started")}</span>
            <span className="text-[11px] text-[var(--ink-faint)]">{t("dates.timeline.notStarted")}</span>
          </li>
        )}
      </ol>
    </section>
  );
}
