import type { Project, Task } from "./types";

/**
 * Viewing results: a finished task waits for the owner's glance, like an unread email.
 *
 * Agents close tasks on their own and in several projects at once, so "Done" grows
 * without a human's involvement. The viewed mark answers one question — "which results
 * have I not seen yet" — and works like mail: opened the card — viewed, and with the checkbox
 * you can also mark it without opening, and return it back to unviewed.
 *
 * This is not a task status: the dispatcher does not care about the mark, and it has no column
 * on the board — unviewed ones stand as a shelf at the top of "Done" (see Column.tsx). The rule is the same
 * as on the server (orc/viewing.py).
 */

/** Whether the task's result waits for the owner's glance. Only a live finished one: a failure calls the person
 * by itself (it is in "Waiting for me"), and an archived card has already been put out of sight. */
export function isUnviewed(task: Pick<Task, "status" | "archived_at" | "viewed_at" | "done_at">): boolean {
  if (task.status !== "done" || task.archived_at) return false;
  if (!task.viewed_at) return true;
  // A mark older than the delivery refers to a previous result: the task was sent back for rework,
  // it closed again — and it needs to be looked at anew.
  const viewed = Date.parse(task.viewed_at);
  const done = task.done_at ? Date.parse(task.done_at) : NaN;
  return !Number.isNaN(viewed) && !Number.isNaN(done) && viewed < done;
}

/** Whether the project takes part in viewing. The field may be missing (old server) — then there are no marks:
 * drawing a checkbox that has nowhere to save would be a deception. */
export function tracksViewed(project: Pick<Project, "track_viewed"> | null | undefined): boolean {
  return Boolean(project?.track_viewed);
}

/** Unviewed to the top, the rest of the order is not touched (Array.prototype.sort is stable).
 * This way "Done" reads like an inbox: new on top, viewed goes to the archive by day. */
export function withUnviewedFirst(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => Number(isUnviewed(b)) - Number(isUnviewed(a)));
}

/** How many unviewed results in each project — only in those that take part. */
export function unviewedByProject(tasks: Task[], projects: Project[]): Map<number, number> {
  const tracked = new Set(projects.filter(tracksViewed).map((p) => p.id));
  const counts = new Map<number, number>();
  for (const task of tasks) {
    if (tracked.has(task.project_id) && isUnviewed(task)) counts.set(task.project_id, (counts.get(task.project_id) ?? 0) + 1);
  }
  return counts;
}
