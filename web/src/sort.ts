import type { Task } from "./types";
import type { TFunction } from "./i18n";

/**
 * Card order in the "Done" column.
 *
 * Backlog and "To do" are a queue, and the person arranges the order in them by hand
 * (see REORDERABLE in Board.tsx), "In progress" is several parallel sessions, where
 * order means nothing. And "Done" is the archive of results: it grows endlessly,
 * and it is almost always looked at from the end, "what closed last". That is why
 * a configurable order exists for exactly this column.
 */
export type DoneSort = "recent" | "oldest" | "failed";

export const DEFAULT_DONE_SORT: DoneSort = "recent";

const DONE_SORT_VALUES: DoneSort[] = ["recent", "oldest", "failed"];

export function getDoneSortOptions(t: TFunction): { value: DoneSort; label: string; hint: string }[] {
  return DONE_SORT_VALUES.map((value) => ({
    value,
    label: t(`sort.${value}.label`),
    hint: t(`sort.${value}.hint`),
  }));
}

export function isDoneSort(value: unknown): value is DoneSort {
  return DONE_SORT_VALUES.includes(value as DoneSort);
}

/**
 * The moment a task completed, in milliseconds — the archive sort key.
 *
 * done_at is set by the dispatcher when closing a task, but failures do not have it
 * (see orc/dispatcher.py): there the nearest truth is updated_at. created_at is
 * the last resort, so a task without a single timestamp does not fly off arbitrarily.
 */
export function finishedAt(task: Task): number {
  for (const raw of [task.done_at, task.updated_at, task.created_at]) {
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

/** Newest on top; with equal time — by number, so the order does not wobble between polls. */
const newestFirst = (a: Task, b: Task): number => finishedAt(b) - finishedAt(a) || b.id - a.id;

/** Sorting of the "Done" column. Does not mutate the input: the board sorts the same arrays it renders. */
export function sortDone(tasks: Task[], sort: DoneSort): Task[] {
  const out = [...tasks];
  if (sort === "oldest") return out.sort((a, b) => finishedAt(a) - finishedAt(b) || a.id - b.id);
  if (sort === "failed") {
    return out.sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed") || newestFirst(a, b));
  }
  return out.sort(newestFirst);
}
