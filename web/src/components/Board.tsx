import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { Plus } from "lucide-react";
import type { Task, TaskStatus } from "../types";
import { Column } from "./Column";
import { ColumnTokens } from "./ColumnTokens";
import { DoneSortMenu } from "./DoneSortMenu";
import { TaskCard } from "./TaskCard";
import { statusLabel } from "../labels";
import { useTranslation, type TFunction } from "../i18n";
import { DEFAULT_DONE_SORT, finishedAt, sortDone, type DoneSort } from "../sort";
import { dayHeading } from "../dates";
import { useNow } from "../hooks/useNow";
import { needsAttention, workIssues, type WorkIssue } from "../status";
import { withUnviewedFirst } from "../viewing";
import { IconButton } from "../ui/Button";
import { Tip } from "../ui/Overlays";

// key is the status code, sent to the API as is; title/empty are on-screen labels, translated
// through t(). There are four columns: the result matters (waiting / in progress / finished), not
// the stage within the work. A function, not a module constant: it must be recomputed when the
// language changes.
export function getColumns(t: TFunction): { key: TaskStatus; title: string; empty: string }[] {
  return [
    { key: "backlog", title: statusLabel(t, "backlog"), empty: t("board.backlogEmpty") },
    { key: "todo", title: statusLabel(t, "todo"), empty: t("board.todoEmpty") },
    { key: "in_progress", title: statusLabel(t, "in_progress"), empty: t("board.inProgressEmpty") },
    { key: "done", title: statusLabel(t, "done"), empty: t("board.doneEmpty") },
  ];
}

// Which column a status lives in. The dispatcher's intermediate statuses have no columns of their
// own: verifying (checking) and merging (the task waits in the FIFO merge queue) stay on the
// backend as they are, but on the board they sit in "In progress": the stage is visible from the
// badge on the card (TaskCard) and the colour of the strip holder. failed lives in "Done" with a
// "Failed" badge.
const COLUMN_OF: Record<TaskStatus, TaskStatus> = {
  backlog: "backlog",
  todo: "todo",
  in_progress: "in_progress",
  verifying: "in_progress",
  merging: "in_progress",
  done: "done",
  failed: "done",
};

// Manual transitions allowed are exactly the same as on the backend (orc/api.py, MANUAL_MOVES):
// backlog->todo, todo->backlog, failed->todo (manual retry), done->backlog (return to work).
// failed->backlog is NOT allowed: failed cards live in the Done column, but they can only be
// dragged to Todo (this calls dispatcher.retry and cleans the worktree/branch/session).
const MANUAL_MOVES = new Set(["backlog>todo", "todo>backlog", "failed>todo", "done>backlog"]);

// Columns where the order within is the human's decision, not a side effect of status: backlog and
// "To do" are a queue, and what is higher usually means "do earlier". "In progress" is not a queue
// but several parallel sessions, so there is nothing to reorder. "Done" is an archive: cards there
// are not moved by hand, but the order is chosen as a whole (see sort.ts).
const REORDERABLE = new Set<TaskStatus>(["backlog", "todo"]);

// How many "Done" cards are shown at once and how many the "Show more" button adds. The archive is
// the only column that grows without a ceiling: after a month of work there are hundreds of strips,
// and drawing them all for the sake of the top two is pointless. The batch is noticeably bigger
// than a screen, so on an ordinary day nobody will ever see the button.
export const DONE_PAGE_SIZE = 25;

// Emergency exit from work (orc/api.py, FORCE_MOVES): a stuck card can be closed by hand by
// dragging it from "In progress" to "Done". The task then goes to done bypassing verification and
// merge, and its session is stopped, so the move is not executed silently: the interface first asks
// for confirmation (see App.tsx), and the API requires force=true.
const FORCE_MOVES = new Set(["in_progress>done", "verifying>done", "merging>done"]);

/** Pure check of the transition rule, factored out so it can be tested without simulating a
 * real drag via @dnd-kit. */
export function canMove(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  return MANUAL_MOVES.has(`${from}>${to}`) || FORCE_MOVES.has(`${from}>${to}`);
}

/** Sending to "To do" hands the card to the dispatcher, which starts its agent's session from the
 * description. So a card with nobody assigned or nothing written is not let into this column.
 *
 * Separate from canMove: the column stays accepting and the person can drop the card, and instead
 * of a silent rollback gets a dialog explaining what exactly is wrong. A prohibition hidden in the
 * column highlight cannot explain itself. */
export function moveIssues(task: Task, to: TaskStatus): WorkIssue[] {
  return to === "todo" ? workIssues(task) : [];
}

/** Whether the move requires human confirmation. Separate from canMove: the column is
 * highlighted as accepting in both cases, but dropping the card has different consequences. */
export function isForceMove(from: TaskStatus, to: TaskStatus): boolean {
  return from !== to && FORCE_MOVES.has(`${from}>${to}`);
}

/** Cards waiting for a human's answer float to the top of the column: otherwise the question
 * gets lost at the tail of a long list, and the board looks as if everything is going on its own.
 * The order of the rest is preserved: Array.prototype.sort is stable. */
export function withWaitingFirst(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => Number(b.blocker === "needs_input") - Number(a.blocker === "needs_input"));
}

/** Manual order within a column: tasks with a position come first by ascending value, followed
 * by never-reordered ones (position=null) in id order (the way the board was always sorted). This
 * way a column nobody has touched by hand looks exactly as before, and a new task does not jump
 * above already arranged ones: it just joins the tail. Stable: serves as the base under
 * withWaitingFirst. */
export function byPosition(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pa = a.position ?? Infinity;
    const pb = b.position ?? Infinity;
    return pa !== pb ? pa - pb : a.id - b.id;
  });
}

interface Props {
  projectId: number;
  tasks: Task[];
  /** force: the move is an emergency one (closing a stuck task by hand) and requires
   * confirmation. */
  onMove: (taskId: number, status: TaskStatus, force: boolean) => void;
  /** Manual reordering within a column (see REORDERABLE): the new order of ids from top to
   * bottom. */
  onReorder: (status: TaskStatus, orderedIds: number[]) => void;
  /** A card with an empty description is not sent to work: instead of the move we call for an
   * explanation. */
  onNotReady: (task: Task) => void;
  onOpen: (taskId: number) => void;
  onCreate: () => void;
  /** Search by number and title. */
  search?: string;
  /** Keep only tasks that will not go any further without a human. */
  attentionOnly?: boolean;
  /** Keep only cards with this label (its id). */
  labelId?: number | null;
  /** Show the "Done" column. */
  showDone?: boolean;
  /** Order of cards in the "Done" column (see sort.ts). */
  doneSort?: DoneSort;
  onDoneSortChange?: (value: DoneSort) => void;
  /** Archived view: instead of live tasks the board shows only those moved to the archive. */
  showArchived?: boolean;
  /** Result viewing (viewing.ts). Not set means the project does not track it: "Done" looks as
   * before, without marks and the unviewed shelf. */
  viewing?: { onToggle: (taskId: number, viewed: boolean) => void; onMarkAll: () => void };
  /** Selection for bulk actions. `onVisible` reports the ids the board shows after its filters, so the selection can
   * drop cards the owner no longer sees: a toolbar must never act on cards that are out of sight. */
  selection?: { ids: ReadonlySet<number>; onToggle: (taskId: number) => void; onVisible: (ids: number[]) => void };
}

/** Project kanban board: four column compartments, strips moved by the rules of manual
 * transitions. */
export function Board({ projectId, tasks, onMove, onReorder, onNotReady, onOpen, onCreate, search = "", attentionOnly = false, labelId = null, showDone = true, showArchived = false, doneSort = DEFAULT_DONE_SORT, onDoneSortChange, viewing, selection }: Props) {
  const { t, language } = useTranslation();
  const now = useNow();
  // Click on a card must not count as a drag: activate drag after a 6px shift
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragged, setDragged] = useState<Task | null>(null);

  // A flag on body keeps the "grabbing" cursor over the whole window (see index.css). If the board
  // unmounts right during a drag, we clear it ourselves, otherwise the cursor would stay a fist
  // over the entire app.
  useEffect(() => () => document.body.removeAttribute("data-dragging"), []);

  const needle = search.trim().toLowerCase();
  const own = tasks.filter((t) => {
    if (t.project_id !== projectId) return false;
    // The archive is a separate view, not mixed into the board: either live tasks or archived ones.
    // Otherwise the board would contain cards the dispatcher does not move, visible only by the
    // badge.
    if (Boolean(t.archived_at) !== showArchived) return false;
    if (attentionOnly && !needsAttention(t)) return false;
    if (labelId !== null && !t.labels?.some((l) => l.id === labelId)) return false;
    if (needle && !`#${t.id} ${t.title}`.toLowerCase().includes(needle)) return false;
    return true;
  });

  // The selection follows what is on the board: a card that leaves it (a filter, the archive view, a project switch)
  // leaves the selection too. Keyed by the ids, so the five-second poll that rebuilds the array does not fire it.
  const visibleKey = own.map((t) => t.id).join(",");
  // The callback goes through a ref: a caller that passes a fresh function each render must not re-fire the report.
  const onVisible = useRef(selection?.onVisible);
  onVisible.current = selection?.onVisible;
  const reports = selection !== undefined;
  useEffect(() => {
    if (reports) onVisible.current?.(visibleKey ? visibleKey.split(",").map(Number) : []);
  }, [visibleKey, reports]);

  // In the archive we do not hide the "Done" column: most archived cards end up there, and the
  // "Done" filter from the board would leave an empty screen here. Viewing is not tracked in the
  // archive: an archived card no longer waits for a glance.
  const doneViewing = showArchived ? undefined : viewing;
  const allColumns = getColumns(t);
  const columns = showDone || showArchived ? allColumns : allColumns.filter((c) => c.key !== "done");
  // "Done" is an archive: no manual order there, but there is a sort chosen by the human (see
  // sort.ts). The other columns live as before: manual order, cards waiting for an answer on top.
  const byColumn = (key: TaskStatus) => {
    const mine = own.filter((t) => COLUMN_OF[t.status] === key);
    if (key !== "done") return withWaitingFirst(byPosition(mine));
    // Unviewed results go to the top, over the chosen order: within their shelf and below it the
    // cards go the way the person asked them to be ordered.
    const sorted = sortDone(mine, doneSort);
    return doneViewing ? withUnviewedFirst(sorted) : sorted;
  };

  // The "Done" archive is cut into days while it is ordered by time. "Failures first" is not
  // chronology: days are mixed in it, and the headings would repeat.
  const doneDayOf = doneSort === "failed" ? undefined : (task: Task) => dayHeading(t, finishedAt(task), language, now);

  function handleDragEnd(e: DragEndEvent) {
    setDragged(null);
    document.body.removeAttribute("data-dragging");
    const task = own.find((t) => t.id === e.active.id);
    const overId = e.over?.id;
    if (!task || overId === undefined) return;
    // over is either the column itself (empty space) or a card inside it (only where reordering is
    // enabled, see reorderable in Column/TaskCard): in both cases we care about the destination
    // column, not what exactly the cursor landed on.
    const overTask = own.find((t) => t.id === overId);
    const to = (overTask ? COLUMN_OF[overTask.status] : overId) as TaskStatus;

    if (to === COLUMN_OF[task.status]) {
      // A move within the same column is a reorder, not a status change.
      if (!REORDERABLE.has(to) || !overTask || overTask.id === task.id) return;
      const ids = byColumn(to).map((t) => t.id);
      const from = ids.indexOf(task.id);
      const at = ids.indexOf(overTask.id);
      if (from !== -1 && at !== -1 && from !== at) onReorder(task.status, arrayMove(ids, from, at));
      return;
    }

    if (!canMove(task.status, to)) return;
    if (moveIssues(task, to).length > 0) {
      onNotReady(task);
      return;
    }
    onMove(task.id, to, isForceMove(task.status, to));
  }

  function handleDragStart(e: DragStartEvent) {
    setDragged(own.find((t) => t.id === e.active.id) ?? null);
    document.body.setAttribute("data-dragging", "true");
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setDragged(null);
        document.body.removeAttribute("data-dragging");
      }}
    >
      <div className="flex h-full gap-2.5 overflow-x-auto pb-1">
        {columns.map((c) => (
          <Column
            key={c.key}
            status={c.key}
            title={c.title}
            tasks={byColumn(c.key)}
            onOpen={onOpen}
            emptyHint={showArchived ? t("board.archiveEmpty") : c.empty}
            reorderable={REORDERABLE.has(c.key)}
            dragging={dragged !== null}
            accepts={dragged !== null && canMove(dragged.status, c.key)}
            pageSize={c.key === "done" ? DONE_PAGE_SIZE : undefined}
            // A change of project or order returns the archive to the first batch: otherwise after
            // switching the person would be looking at the tail of someone else's list.
            resetKey={`${projectId}:${doneSort}:${showArchived}`}
            summary={c.key === "done" ? <ColumnTokens tasks={byColumn(c.key)} /> : undefined}
            dayOf={c.key === "done" ? doneDayOf : undefined}
            viewing={c.key === "done" ? doneViewing : undefined}
            selection={selection}
            action={
              c.key === "backlog" && !showArchived ? (
                <Tip text={t("board.newTaskTip")}>
                  <IconButton icon={Plus} label={t("app.newTaskTitle")} size="sm" onClick={onCreate} />
                </Tip>
              ) : c.key === "done" && onDoneSortChange ? (
                <DoneSortMenu value={doneSort} onChange={onDoneSortChange} />
              ) : undefined
            }
          />
        ))}
      </div>

      {/* Drag layer: the strip follows the cursor over everything instead of pushing the
         layout. */}
      <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}>
        {dragged && (
          <div className="w-[16.5rem]">
            <TaskCard task={dragged} onOpen={() => {}} overlay />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
