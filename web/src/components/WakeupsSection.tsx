import { useEffect, useState } from "react";
import { AlarmClock, BellOff, BellRing, Link2, X } from "lucide-react";
import { api } from "../api";
import { fullDateTime } from "../dates";
import { useTranslation, type TFunction } from "../i18n";
import { wakeupCondition } from "../wakeups";
import { cn } from "../lib/cn";
import type { TaskDetail, Wakeup } from "../types";
import { IconButton } from "../ui/Button";
import { SidebarSection } from "../ui/SidebarSection";
import { focusRing } from "../ui/tokens";

interface Props {
  task: TaskDetail;
  pending: boolean;
  /** Runs a card action and reloads the card: the same path the composer's buttons take. */
  onAction: (action: () => Promise<unknown>) => Promise<boolean>;
  onOpenTask?: (id: number) => void;
}

/**
 * The wakeups the card's agent asked for, after multica's issue wakeups: what will wake it, with a cancel, and the
 * history folded below. Hidden on a card whose agent never asked for one.
 */
export function WakeupsSection({ task, pending, onAction, onOpenTask }: Props) {
  const { t, language } = useTranslation();
  const [wakeups, setWakeups] = useState<Wakeup[] | null>(null);
  const [history, setHistory] = useState(false);
  const [reload, setReload] = useState(0);

  // The card re-reads itself when the task changes; the list follows the same stamp, as the execution log does.
  const stamp = `${task.updated_at}|${task.status}|${task.blocker ?? ""}|${reload}`;
  useEffect(() => {
    let current = true;
    api
      .taskWakeups(task.id)
      .then((fresh) => {
        if (current) setWakeups(fresh);
      })
      .catch(() => {
        // An older server without the endpoint leaves the card without the section.
      });
    return () => {
      current = false;
    };
  }, [task.id, stamp]);

  // Anything but a list (an older server's fallback page, say) means no section
  if (!Array.isArray(wakeups) || wakeups.length === 0) return null;
  const waiting = wakeups.filter((w) => w.state === "pending");
  const past = wakeups.filter((w) => w.state !== "pending").reverse();
  const asleep = task.status === "in_progress" && task.blocker === "sleeping";

  const cancel = (wakeup: Wakeup) =>
    void onAction(() => api.cancelWakeup(task.id, wakeup.id)).then(() => setReload((n) => n + 1));

  return (
    <SidebarSection title={t("card.wakeups.heading")} count={waiting.length} defaultOpen={waiting.length > 0 || asleep}>
      <div className="-mx-1.5 space-y-1">
        {waiting.length > 0 && (
          <ul className="space-y-0.5">
            {waiting.map((w) => (
              <WakeupRow key={w.id} wakeup={w} t={t} locale={language} onOpenTask={onOpenTask}>
                <IconButton icon={X} size="sm" label={t("card.wakeups.cancel")} disabled={pending} onClick={() => cancel(w)} />
              </WakeupRow>
            ))}
          </ul>
        )}
        {asleep && waiting.length === 0 && <p className="px-1.5 text-[11px] leading-snug text-[var(--ink-muted)]">{t("card.wakeups.nothingLeft")}</p>}
        {past.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={history}
              onClick={() => setHistory(!history)}
              className={cn("px-1.5 text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink)]", focusRing)}
            >
              {t("card.wakeups.history", { count: past.length })}
            </button>
            {history && (
              <ul className="space-y-0.5">
                {past.map((w) => (
                  <WakeupRow key={w.id} wakeup={w} t={t} locale={language} onOpenTask={onOpenTask} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </SidebarSection>
  );
}

function WakeupRow({ wakeup, t, locale, onOpenTask, children }: {
  wakeup: Wakeup;
  t: TFunction;
  locale: string;
  onOpenTask?: (id: number) => void;
  children?: React.ReactNode;
}) {
  const Icon = wakeup.state === "fired" ? BellRing : wakeup.state === "cancelled" ? BellOff : wakeup.kind === "task" ? Link2 : AlarmClock;
  const condition = wakeupCondition(t, wakeup, locale);
  const done = wakeup.state !== "pending";
  const title = [
    fullDateTime(Date.parse(wakeup.created_at), locale),
    done ? `${t(`card.wakeups.${wakeup.state}`)}${wakeup.reason ? `: ${wakeup.reason}` : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li title={title} className="group/wake flex min-w-0 items-start gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 hover:bg-[color-mix(in_oklab,var(--ink)_5%,transparent)]">
      <Icon size={13} aria-hidden className={cn("mt-0.5 shrink-0", done ? "text-[var(--ink-faint)]" : "text-[var(--ink-muted)]")} />
      <div className="min-w-0 flex-1 text-[12px] leading-snug">
        <div className={cn("truncate", done ? "text-[var(--ink-muted)]" : "text-[var(--ink)]")}>
          {wakeup.kind === "task" && wakeup.watch_task_id !== null && onOpenTask ? (
            <button type="button" onClick={() => onOpenTask(wakeup.watch_task_id!)} className={cn("max-w-full truncate text-left hover:underline", focusRing)}>
              {condition}
            </button>
          ) : (
            condition
          )}
        </div>
        {done && wakeup.reason && <div className="truncate text-[11px] text-[var(--ink-faint)]">{t(`card.wakeups.${wakeup.state}`)} · {wakeup.reason}</div>}
        {wakeup.note && (
          <div className="line-clamp-2 whitespace-pre-wrap break-words text-[11px] text-[var(--ink-faint)]" title={wakeup.note}>
            <span className="sr-only">{t("card.wakeups.note")}: </span>
            {wakeup.note}
          </div>
        )}
      </div>
      {children && <span className="shrink-0">{children}</span>}
    </li>
  );
}
