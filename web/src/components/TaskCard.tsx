import { useDraggable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, Check, Clock, Coins, GitBranch, Repeat, Send } from "lucide-react";
import type { Task } from "../types";
import { blockerLabel, outboxLabel, priorityLabel, stageLabel, statusLabel, waitingLabel } from "../labels";
import { BLOCKER_META, OUTBOX_TONE, STATUS_META } from "../status";
import { formatTokens, parseUsage, usageTitle } from "../usage";
import { Badge } from "../ui/Badge";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { useTranslation } from "../i18n";
import { cardMoment, formatDuration, momentLabel, timelineTitle } from "../dates";
import { scheduleState, scheduleTitle, windowTime } from "../schedule";
import { useNow } from "../hooks/useNow";

interface Props {
  task: Task;
  onOpen: (id: number) => void;
  /** The card is drawn in the drag layer: without handlers and without a source spot. */
  overlay?: boolean;
  /** The column allows manual reordering (see reorderable in Column.tsx): the card itself becomes a
   * drop target for its neighbours, not only a drag source. */
  sortable?: boolean;
  /** Result viewing (viewing.ts). Not set means the card does not take part: the project does not
   * track viewing, the task is not finished or is archived. */
  viewing?: { viewed: boolean; onToggle: (viewed: boolean) => void };
}

/**
 * Viewing mark in the corner of a finished card: both the state and the check mark at once.
 *
 * An unviewed result is a green dot, like an unread email: the colour is the same as for the "Done"
 * status, because it means exactly "here is a finished result you have not seen". A viewed one is a
 * quiet check mark without colour. A click toggles both ways without opening the card: under the
 * cursor the dot turns into a check mark, showing what will happen.
 */
function ViewedMark({ viewed, onToggle, inert }: { viewed: boolean; onToggle: (viewed: boolean) => void; inert?: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={viewed}
      aria-label={t("viewing.viewed")}
      title={viewed ? t("viewing.unmark") : t("viewing.mark")}
      tabIndex={inert ? -1 : undefined}
      // The mark sits inside a card that both opens on click and is dragged by the mouse: we
      // suppress the click, the drag start and the keys, like a clickable badge (ui/Badge.tsx).
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (!inert) onToggle(!viewed);
      }}
      className={cn(
        "group/mark -my-1 -mr-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors duration-100",
        "hover:bg-[color-mix(in_oklab,var(--ink)_10%,transparent)]",
        focusRing,
      )}
    >
      {viewed ? (
        <Check size={12} strokeWidth={2.25} aria-hidden className="text-[var(--ink-faint)] transition-colors group-hover/mark:text-[var(--ink)]" />
      ) : (
        <>
          <span aria-hidden className={cn("h-[7px] w-[7px] rounded-full group-hover/mark:hidden", STATUS_META.done.dot)} />
          <Check size={12} strokeWidth={2.25} aria-hidden className={cn("hidden group-hover/mark:block", STATUS_META.done.fg)} />
        </>
      )}
    </button>
  );
}

/**
 * "Strip" card: on the left a coloured status holder, the only thing that changes as the task moves
 * across columns. The strip's shape is the same everywhere, so the eye looks for colour instead of
 * rereading labels.
 */
export function TaskCard({ task, onOpen, overlay, sortable, viewing }: Props) {
  const { t, language } = useTranslation();
  const now = useNow();
  // An archived card is not dragged: the dispatcher does not move it, and a "move" would mean
  // nothing.
  const archived = Boolean(task.archived_at);
  const disabled = overlay || archived;
  // Both hooks are called unconditionally (rules of hooks), but only one actually works, the other
  // is switched off via disabled. In columns without manual reordering the card behaves exactly as
  // before (useDraggable, no neighbour-shift animation).
  const draggable = useDraggable({ id: task.id, disabled: disabled || sortable });
  const sortableCtl = useSortable({ id: task.id, disabled: disabled || !sortable });
  const { attributes, listeners, setNodeRef, isDragging } = sortable ? sortableCtl : draggable;
  // While the card is being dragged, we neutralise its transform: the visible spot is taken by
  // DragOverlay, not the card itself, otherwise the strip would be duplicated (one flies after the
  // cursor, the other crawls along in the list).
  const style = sortable && !isDragging
    ? { transform: CSS.Transform.toString(sortableCtl.transform), transition: sortableCtl.transition }
    : undefined;
  const meta = STATUS_META[task.status];
  const blocker = task.blocker ? BLOCKER_META[task.blocker] : null;
  const stage = stageLabel(t, task.status);
  // A task the dispatcher sent back into a session to resolve a conflict is still listed as "in
  // progress": the badge shows that branches are being reconciled there, not code being written.
  const resolvingConflict = task.status === "in_progress" && task.conflict_retry_count > 0;
  // While the task waits for a human, the holder glows with the blocking colour, not the status
  // colour: "in progress but standing still" is a human's state, not the agent's.
  const railTone = task.blocker === "needs_input" ? BLOCKER_META.needs_input.dot : meta.rail;
  // We show tokens in any status: for a running task the number grows before your eyes, for a
  // finished one it is the total the badge exists for. A zero total is not a badge but noise.
  const usage = parseUsage(task.usage_json);
  const tokens = usage && usage.total_tokens > 0 ? usage : null;
  // The card's main date is its own for each column (see cardMoment), the rest are in the tooltip.
  // A just-closed task is highlighted: "what finished in the last hour" is visible without reading
  // numbers.
  const moment = cardMoment(task);
  const fresh = moment?.kind === "done" && now - moment.at < 60 * 60_000;
  // Deferred start: countdown to the deadline, end of the window or "window has passed" (see
  // schedule.ts)
  const sched = scheduleState(task, now);
  // The "starts in" countdown is honest only in todo: the dispatcher does not take a task from
  // backlog or failed until it is sent to "To do", so there we show only "not earlier than".
  const schedLabel =
    sched?.kind === "waiting"
      ? task.status === "todo"
        ? t("taskCard.schedule.startsIn", { duration: formatDuration(t, sched.at - now) })
        : t("taskCard.schedule.notBefore", { time: windowTime(sched.at, language, now) })
      : sched?.kind === "window"
        ? t("taskCard.schedule.windowUntil", { time: windowTime(sched.until, language, now) })
        : sched?.kind === "missed"
          ? t("taskCard.schedule.missed")
          : null;

  // The order in the markup below matters: dnd-kit spreads come first, our handlers after,
  // otherwise its listeners could override opening the card from the keyboard.
  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      style={overlay ? undefined : style}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      role="button"
      tabIndex={0}
      onClick={overlay ? undefined : () => onOpen(task.id)}
      onKeyDown={
        overlay
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(task.id);
              }
            }
      }
      className={cn(
        // shrink-0 is mandatory: the column is a flex container, and flex-shrink defaults to 1, so
        // the browser squashes a long list of cards in height just to fit them into the column
        // instead of scrolling it. A strip always takes as much as its content needs, rather than
        // fitting into the remaining height.
        "group relative shrink-0 select-none overflow-hidden rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface)]",
        "pl-3 pr-2.5 py-2 text-left shadow-[var(--shadow-card)] transition-[border-color,transform,box-shadow] duration-100",
        focusRing,
        overlay
          ? "rotate-[1.5deg] cursor-grabbing border-[var(--line-strong)] shadow-[var(--shadow-pop)]"
          : archived
            ? "cursor-pointer hover:border-[var(--line-strong)]"
            : "cursor-grab hover:border-[var(--line-strong)]",
        // The source spot stays as an empty frame: you can see where the strip was taken from.
        isDragging && !overlay && "opacity-30",
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", railTone)} />

      <div className="mb-1 flex items-center gap-2">
        <span className="tnum shrink-0 font-mono text-[11px] text-[var(--ink-faint)]">#{task.id}</span>
        {moment && (
          <span
            className={cn("tnum min-w-0 truncate text-[11px]", fresh ? STATUS_META.done.fg : "text-[var(--ink-faint)]")}
            title={timelineTitle(t, task, language)}
          >
            {momentLabel(t, moment, language, now)}
          </span>
        )}
        {task.priority !== "normal" && (
          <span
            className={cn(
              "text-[11px] font-medium",
              task.priority === "high" ? "text-[var(--danger)]" : "text-[var(--ink-faint)]",
            )}
          >
            {priorityLabel(t, task.priority)}
          </span>
        )}
        {(task.target_branch || viewing) && (
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            {task.target_branch && (
              <span
                className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-[var(--ink-faint)]"
                title={t("taskCard.branchTitle", { branch: task.target_branch })}
              >
                <GitBranch size={10} className="shrink-0" aria-hidden />
                <span className="truncate">{task.target_branch}</span>
              </span>
            )}
            {viewing && <ViewedMark viewed={viewing.viewed} onToggle={viewing.onToggle} inert={overlay} />}
          </span>
        )}
      </div>

      {/* As in email: unviewed is set denser, viewed recedes. Where viewing is not tracked,
         the heading stays as it was. */}
      <div
        className={cn(
          "line-clamp-3 text-[13px] leading-snug",
          !viewing
            ? "font-medium text-[var(--ink)]"
            : viewing.viewed
              ? "font-normal text-[var(--ink-muted)]"
              : "font-semibold text-[var(--ink)]",
        )}
      >
        {task.title}
      </div>

      {(archived ||
        schedLabel ||
        task.status === "failed" ||
        stage ||
        resolvingConflict ||
        blocker ||
        task.outbox_state ||
        tokens ||
        task.routine_run ||
        task.depends_on.length > 0) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {/* Run of a recurring task: the run number, while the routine itself is in the
             "Routines" tab. */}
          {task.routine_run ? (
            <Badge icon={Repeat} mono title={t("taskCard.routineRunTitle", { run: task.routine_run })} className="tnum">
              {t("taskCard.routineRun", { run: task.routine_run })}
            </Badge>
          ) : null}
          {schedLabel && (
            <Badge
              icon={Clock}
              tone={sched?.kind === "missed" ? "bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]" : STATUS_META.todo.chip}
              title={scheduleTitle(t, task, language)}
              className="tnum"
            >
              {schedLabel}
            </Badge>
          )}
          {archived && <Badge icon={Archive}>{t("taskCard.archived")}</Badge>}
          {task.status === "failed" && (
            <Badge icon={STATUS_META.failed.icon} tone={STATUS_META.failed.chip}>
              {statusLabel(t, "failed")}
            </Badge>
          )}
          {/* Verification and merging have no column of their own (see COLUMN_OF in
             Board.tsx), so the stage is read from the badge, in the colour of its own status. */}
          {stage && (
            <Badge icon={meta.icon} tone={meta.chip}>
              {stage}
            </Badge>
          )}
          {resolvingConflict && (
            <Badge icon={BLOCKER_META.conflict.icon} tone={BLOCKER_META.conflict.chip}>
              {t("taskCard.resolvingConflict")}
            </Badge>
          )}
          {task.blocker && blocker && (
            <Badge icon={blocker.icon} tone={blocker.chip}>
              {task.blocker === "needs_input" ? waitingLabel(t, task) : blockerLabel(t, task.blocker)}
            </Badge>
          )}
          {task.outbox_state && (
            <Badge icon={Send} tone={OUTBOX_TONE[task.outbox_state]}>
              {outboxLabel(t, task.outbox_state)}
            </Badge>
          )}
          {/* The blocker badge is a link to the blocking task itself: most often one clicks
             "after #N" to go to what is being waited for, not to open the same card. */}
          {task.depends_on.map((d) => (
            <Badge key={d} mono title={t("taskCard.dependsOnTitle", { id: d })} onClick={overlay ? undefined : () => onOpen(d)}>
              {t("taskCard.dependsOn", { id: d })}
            </Badge>
          ))}
          {tokens && (
            <Badge icon={Coins} mono title={usageTitle(t, tokens)} className="tnum">
              {formatTokens(tokens.total_tokens)}
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}
