import { FolderOpen } from "lucide-react";
import type { Task } from "../types";
import { blockerLabel, waitingLabel } from "../labels";
import { BLOCKER_META, STATUS_META } from "../status";
import { focusRing } from "../ui/tokens";
import { cn } from "../lib/cn";
import { Horn } from "../brand/glyphs";
import { useTranslation, type TFunction } from "../i18n";

interface Props {
  tasks: Task[];
  /** Tasks waiting for a human in OTHER projects: the dispatcher is shared, and a question
   * asked in a neighbouring project would otherwise be invisible until you switch there. */
  elsewhere?: Task[];
  onOpen: (id: number) => void;
}

/** Short stop reason right on the chip, so the card need not be opened for a single word. */
function reason(t: TFunction, task: Task): { text: string; tone: string; icon: typeof BLOCKER_META.conflict.icon } {
  if (task.blocker) {
    const meta = BLOCKER_META[task.blocker];
    const text = task.blocker === "needs_input" ? waitingLabel(t, task) : blockerLabel(t, task.blocker);
    return { text, tone: meta.fg, icon: meta.icon };
  }
  return { text: t("attentionBar.failed"), tone: STATUS_META.failed.fg, icon: STATUS_META.failed.icon };
}

/**
 * "Waiting for me" strip above the board.
 *
 * Tasks stuck on a human are scattered across different columns, and spotting them on a board of
 * six compartments takes careful looking. The strip gathers them in one place and disappears when
 * there are no such tasks; there is deliberately no empty placeholder line: its absence by itself
 * means "all is well".
 */
export function AttentionBar({ tasks, elsewhere = [], onOpen }: Props) {
  const { t } = useTranslation();
  if (tasks.length === 0 && elsewhere.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[color-mix(in_oklab,var(--st-blocked)_25%,var(--line))] bg-[color-mix(in_oklab,var(--st-blocked)_7%,transparent)] px-3 py-1.5">
      {/* War horn: the strip is a call to the human, and the glyph says what the magenta says */}
      <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-semibold text-[var(--st-blocked)]">
        <Horn size={13} />
        <span>
          {t("topBar.waitingForMe")}<span className="tnum ml-1 font-normal">{tasks.length + elsewhere.length}</span>
        </span>
      </span>
      <ul className="flex min-w-0 items-center gap-1.5">
        {tasks.map((task) => {
          const r = reason(t, task);
          const Icon = r.icon;
          return (
            <li key={task.id}>
              <button
                onClick={() => onOpen(task.id)}
                className={cn(
                  "flex h-6 max-w-72 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--surface)] pl-2 pr-2.5 text-[12px] transition-colors hover:border-[var(--line-strong)]",
                  focusRing,
                )}
              >
                <Icon size={11} className={cn("shrink-0", r.tone)} aria-hidden />
                <span className="tnum shrink-0 font-mono text-[11px] text-[var(--ink-faint)]">#{task.id}</span>
                <span className="truncate text-[var(--ink)]">{task.title}</span>
                <span className={cn("shrink-0 text-[11px]", r.tone)}>{r.text}</span>
              </button>
            </li>
          );
        })}
        {elsewhere.length > 0 && (
          <li>
            <button
              onClick={() => onOpen(elsewhere[0].id)}
              title={t("attentionBar.openFirstElsewhere")}
              className={cn(
                "flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-[var(--line-strong)] px-2.5 text-[12px] text-[var(--ink-muted)] transition-colors hover:border-[var(--st-blocked)] hover:text-[var(--ink)]",
                focusRing,
              )}
            >
              <FolderOpen size={11} className="shrink-0" aria-hidden />
              <span className="tnum">{t("attentionBar.elsewhereCount", { count: elsewhere.length })}</span>
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
