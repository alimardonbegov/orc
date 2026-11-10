import { Fragment, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CheckCheck } from "lucide-react";
import type { Task, TaskStatus } from "../types";
import { TaskCard } from "./TaskCard";
import { isUnviewed } from "../viewing";
import { BLOCKER_META, STATUS_META } from "../status";
import { Count } from "../ui/Badge";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { useTranslation } from "../i18n";

interface Props {
  status: TaskStatus;
  title: string;
  tasks: Task[];
  onOpen: (id: number) => void;
  action?: React.ReactNode;
  /** A drag is in progress: the column either accepts the strip or recedes into the background. */
  dragging?: boolean;
  accepts?: boolean;
  /** Text in an empty column: each has its own, "drag here" is not right everywhere. */
  emptyHint?: string;
  /** The order of cards within the column can be changed by hand (see REORDERABLE in
   * Board.tsx). */
  reorderable?: boolean;
  /**
   * Show the list in batches of this many cards, adding more via the "Show more" button. Not set
   * means the column draws everything at once (this is how short working columns live).
   */
  pageSize?: number;
  /** A change of the value returns the list to the first batch: the order changed, so look from
   * the top. */
  resetKey?: string;
  /** Column summary next to the counter, e.g. the token total in "Done". */
  summary?: React.ReactNode;
  /**
   * Day label for a card: the column cuts the list into days ("Today", "Yesterday", "September
   * 21"). Set only where the order is chronological: otherwise the same day would appear in the
   * list several times.
   */
  dayOf?: (task: Task) => string;
  /**
   * Result viewing (viewing.ts): finished cards get a check mark, and unviewed ones stand as a
   * shelf at the top of the column. The "unviewed first" order is set by the board
   * (withUnviewedFirst): the column only labels the shelf.
   */
  viewing?: { onToggle: (taskId: number, viewed: boolean) => void; onMarkAll: () => void };
  /** Selection for bulk actions (see BatchToolbar). */
  selection?: { ids: ReadonlySet<number>; onToggle: (taskId: number) => void };
}

/**
 * One board "compartment". The heading is in normal case with a coloured status dot: all-caps
 * labels in a row of columns read like a fence.
 */
export function Column({ status, title, tasks, onOpen, action, dragging, accepts, emptyHint, reorderable, pageSize, resetKey, summary, dayOf, viewing, selection }: Props) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: dragging && !accepts });
  const meta = STATUS_META[status];
  const live = isOver && accepts;

  // The "Done" archive grows endlessly, and people look into it from the top: we draw the first
  // batch, the rest comes by button. That gives both a short DOM and an honest "older beyond this"
  // boundary, which endless scrolling lacks.
  //
  // The reset to the first batch is done by setting state right in render, not in an effect: an
  // effect would draw the tail of the previous list and remove it only on the next frame, while
  // React restarts the render of just this component and no flicker is visible.
  const first = pageSize ?? 0;
  const [page, setPage] = useState({ key: resetKey, visible: first });
  if (page.key !== resetKey) setPage({ key: resetKey, visible: first });
  const shown = pageSize ? tasks.slice(0, page.visible) : tasks;
  const rest = tasks.length - shown.length;

  // "Waiting for input" is a separate shelf in "In progress": such cards already stand first
  // (withWaitingFirst in Board.tsx), but without a label the column looks as if everything is
  // working. The shelf exists only when there is someone to stand on it, and only in the working
  // column: in the others there is nobody to wait for.
  const waiting = status === "in_progress" ? shown.filter((t) => t.blocker === "needs_input").length : 0;
  const shelf = (label: string, count: number, tone: string, dot: string, action?: React.ReactNode) => (
    <div className={cn("flex items-center gap-1.5 px-0.5 pt-1 text-[11px] font-medium", tone)}>
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {label}
      <span className="tnum font-normal opacity-70">{count}</span>
      {action && <span className="ml-auto flex">{action}</span>}
    </div>
  );
  // "Not viewed" is a shelf at the top of "Done": the column reads like an inbox, new on top,
  // viewed ones go lower into the archive by days. The counter covers the whole column, not the
  // visible batch: "how many more I have to look at" does not depend on how many cards are drawn.
  const unviewed = viewing ? tasks.filter(isUnviewed).length : 0;
  const pinned = viewing ? shown.filter(isUnviewed).length : 0;
  // Days in the "Done" archive: the heading shows at once where today ends and the old begins, with
  // no need to compare labels on each card. The counter covers the visible batch. The unviewed
  // shelf is not cut into days: it is short, and what matters in it is that it is new.
  const days = dayOf ? shown.map(dayOf) : null;
  const perDay = new Map<string, number>();
  days?.forEach((d, i) => i >= pinned && perDay.set(d, (perDay.get(d) ?? 0) + 1));
  const dayHeader = (day: string) => (
    <div className="flex items-center gap-1.5 px-0.5 pt-1 text-[11px] font-medium text-[var(--ink-muted)]" data-day-heading>
      {day}
      <span className="tnum font-normal text-[var(--ink-faint)]">{perDay.get(day)}</span>
      <span aria-hidden className="h-px flex-1 bg-[var(--line)]" />
    </div>
  );
  const cards = shown.map((task, i) => (
    <Fragment key={task.id}>
      {waiting > 0 && i === 0 && shelf(t("column.waitingShelf"), waiting, BLOCKER_META.needs_input.fg, BLOCKER_META.needs_input.dot)}
      {waiting > 0 && i === waiting && shelf(t("column.workingShelf"), shown.length - waiting, "text-[var(--ink-faint)]", meta.dot)}
      {pinned > 0 &&
        i === 0 &&
        viewing &&
        shelf(
          t("viewing.shelf"),
          unviewed,
          STATUS_META.done.fg,
          STATUS_META.done.dot,
          <button
            type="button"
            onClick={viewing.onMarkAll}
            title={t("viewing.markAllTitle", { count: unviewed })}
            className={cn(
              "-my-0.5 inline-flex items-center gap-1 rounded-[5px] px-1 py-0.5 font-medium text-[var(--ink-muted)] transition-colors duration-100",
              "hover:bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] hover:text-[var(--ink)]",
              focusRing,
            )}
          >
            <CheckCheck size={11} aria-hidden />
            {t("viewing.markAll")}
          </button>,
        )}
      {days && i >= pinned && (i === pinned || days[i] !== days[i - 1]) && dayHeader(days[i])}
      <TaskCard
        task={task}
        onOpen={onOpen}
        sortable={reorderable}
        selection={
          selection
            ? { selected: selection.ids.has(task.id), any: selection.ids.size > 0, onToggle: () => selection.onToggle(task.id) }
            : undefined
        }
        viewing={
          viewing && task.status === "done" && !task.archived_at
            ? { viewed: !isUnviewed(task), onToggle: (viewed) => viewing.onToggle(task.id, viewed) }
            : undefined
        }
      />
    </Fragment>
  ));

  return (
    <section
      ref={setNodeRef}
      aria-label={title}
      className={cn(
        // Columns are fluid: all compartments must fit in the window without horizontal scrolling,
        // and with a collapsed sidebar become wider rather than leave emptiness.
        "flex h-full min-w-[12.5rem] max-w-[22rem] flex-1 flex-col rounded-[var(--radius)] border bg-[var(--sunken)] transition-[border-color,opacity,background-color] duration-150",
        live ? "border-[var(--focus)] bg-[color-mix(in_oklab,var(--focus)_8%,var(--sunken))]" : "border-transparent",
        // Columns where a move is forbidden fade out: the transition rule is visible at a glance,
        // not by trial and error.
        dragging && !accepts && "opacity-40",
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 px-2.5">
        <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
        <h2 className="text-[12px] font-semibold text-[var(--ink)]">{title}</h2>
        <Count value={tasks.length} />
        {summary}
        <span className="ml-auto">{action}</span>
      </header>

      {/* The list scrolls inside the column: cards keep their natural size (shrink-0 on the
         card itself), and the excess goes under scroll instead of being squashed.
         overscroll-contain so that scrolling the column to the edge does not drag the board
         along; scrollbar-gutter always reserves room for the bar, otherwise a scrolling column
         would draw cards narrower than its neighbours'. */}
      <div
        data-column-list
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain px-2 pb-2 [scrollbar-gutter:stable]"
      >
        {reorderable ? (
          <SortableContext items={shown.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            {cards}
          </SortableContext>
        ) : (
          cards
        )}
        {rest > 0 && pageSize && (
          <button
            type="button"
            onClick={() => setPage((p) => ({ ...p, visible: p.visible + pageSize }))}
            className={cn(
              "shrink-0 rounded-[var(--radius-sm)] border border-dashed border-[var(--line)] px-2 py-1.5",
              "text-[11px] font-medium text-[var(--ink-muted)] transition-colors duration-100",
              "hover:border-[var(--line-strong)] hover:text-[var(--ink)]",
              focusRing,
            )}
          >
            {t("column.showMore", { count: Math.min(rest, pageSize), rest })}
          </button>
        )}
        {tasks.length === 0 && (
          <p
            className={cn(
              "rounded-[var(--radius-sm)] border border-dashed px-2 py-5 text-center text-[11px] transition-colors",
              live
                ? "border-[var(--focus)] text-[var(--ink-muted)]"
                : "border-[var(--line)] text-[var(--ink-faint)]",
            )}
          >
            {emptyHint ?? t("column.empty")}
          </p>
        )}
      </div>
    </section>
  );
}
