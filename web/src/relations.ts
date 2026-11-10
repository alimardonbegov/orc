import type { Task } from "./types";

/**
 * How a card relates to the others, computed from the board's own task list. The server is not asked: the list
 * already carries `depends_on` and `parent_task_id` for every card it shows.
 *
 * Archived and deleted cards are not in that list. A blocker among them still sits in `depends_on`, so it shows
 * as a bare number (`task: null`) and is never walked through.
 */

/** A card in a relation, or the bare number of one the board does not show. */
export interface RelatedCard {
  id: number;
  task: Task | null;
  /** Held back by the stage of the card, not by a link of its own. */
  viaStage: boolean;
}

export interface Progress {
  done: number;
  total: number;
}

/** Every blocker of a card: its own links and the previous stage of its parent, as the server derived them (orc/stages.py). */
export function blockersOf(task: Pick<Task, "depends_on" | "stage_blocked_by">): number[] {
  return [...new Set([...task.depends_on, ...(task.stage_blocked_by ?? [])])];
}

function byIdMap(all: readonly Task[]): Map<number, Task> {
  return new Map(all.map((t) => [t.id, t]));
}

/** What the card waits for, in its own order. */
export function waitsFor(task: Pick<Task, "depends_on" | "stage_blocked_by">, all: readonly Task[]): RelatedCard[] {
  const byId = byIdMap(all);
  const own = new Set(task.depends_on);
  return blockersOf(task).map((id) => ({ id, task: byId.get(id) ?? null, viaStage: !own.has(id) }));
}

/** What starts once this card is merged: the cards that wait for it. */
export function comesNext(taskId: number, all: readonly Task[]): Task[] {
  return all.filter((t) => t.id !== taskId && blockersOf(t).includes(taskId)).sort((a, b) => a.id - b.id);
}

/** The card's subtasks on the board. */
export function subtasksOf(taskId: number, all: readonly Task[]): Task[] {
  return all.filter((t) => t.parent_task_id === taskId && t.id !== taskId).sort((a, b) => a.id - b.id);
}

export function progressOf(children: readonly Task[]): Progress {
  return { done: children.filter((t) => t.status === "done").length, total: children.length };
}

/** done/total for every card that has subtasks on the board, in one pass: the board draws many cards. */
export function subtaskProgress(all: readonly Task[]): Map<number, Progress> {
  const result = new Map<number, Progress>();
  for (const t of all) {
    if (t.parent_task_id == null || t.parent_task_id === t.id) continue;
    const entry = result.get(t.parent_task_id) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (t.status === "done") entry.done += 1;
    result.set(t.parent_task_id, entry);
  }
  return result;
}

/** The card's parents, nearest first. A ring in the data ends the walk instead of hanging it. */
export function ancestorsOf(taskId: number, all: readonly Task[]): number[] {
  const byId = byIdMap(all);
  const seen = new Set<number>([taskId]);
  const result: number[] = [];
  let parent = byId.get(taskId)?.parent_task_id ?? null;
  while (parent != null && !seen.has(parent)) {
    seen.add(parent);
    result.push(parent);
    parent = byId.get(parent)?.parent_task_id ?? null;
  }
  return result;
}

/** Cards that can be attached as subtasks: not the card itself, not one of its parents (a ring), not already its subtask. */
export function attachCandidates(taskId: number, all: readonly Task[]): Task[] {
  const excluded = new Set([taskId, ...ancestorsOf(taskId, all)]);
  return all.filter((t) => !excluded.has(t.id) && t.parent_task_id !== taskId);
}

export interface TreeNode {
  id: number;
  task: Task | null;
  depth: number;
  /** Cards that wait for this one. Empty for a repeat. */
  children: TreeNode[];
  /** Already shown higher up: a diamond in the graph. Its subtree is not drawn again. */
  repeat: boolean;
  /** Reached again on its own path: a ring, which task_deps should never hold. Drawn as a repeat. */
  cycle: boolean;
  /** The card the tree is drawn for. */
  current: boolean;
  /** The card the tree is drawn for is in this subtree: such a node is never collapsed. */
  leadsToCurrent: boolean;
}

/**
 * The connected component of `task_deps` around a card, as an indented tree read top-down: each card's children are
 * the cards that wait for it. So the card's transitive blockers stand above it, and what comes after it below.
 *
 * The graph is not always a tree. A card reached a second time (a diamond) is shown again as a repeat without its
 * subtree, and a card reached on its own path (a ring) as well. Every card of the component appears expanded
 * exactly once, so the result is linear in its size and cannot hang, whatever the data holds.
 */
export function dependencyTree(taskId: number, all: readonly Task[]): TreeNode[] {
  const byId = byIdMap(all);
  const dependents = new Map<number, number[]>();
  for (const t of all) {
    for (const d of blockersOf(t)) {
      if (d === t.id) continue;
      const list = dependents.get(d) ?? [];
      list.push(t.id);
      dependents.set(d, list);
    }
  }
  const blockersById = (id: number) => (byId.get(id) ? blockersOf(byId.get(id) as Task) : []).filter((d) => d !== id);

  // The component, undirected. A card off the board is a leaf: it is included but never walked through.
  const component = new Set<number>([taskId]);
  const queue = [taskId];
  while (queue.length > 0) {
    const id = queue.shift() as number;
    if (!byId.has(id)) continue;
    for (const next of [...blockersById(id), ...(dependents.get(id) ?? [])]) {
      if (!component.has(next)) {
        component.add(next);
        queue.push(next);
      }
    }
  }

  const childrenOf = (id: number) => (dependents.get(id) ?? []).filter((c) => component.has(c)).sort((a, b) => a - b);
  const expanded = new Set<number>();

  function visit(id: number, depth: number, path: Set<number>): TreeNode {
    const node: TreeNode = {
      id,
      task: byId.get(id) ?? null,
      depth,
      children: [],
      repeat: false,
      cycle: false,
      current: id === taskId,
      leadsToCurrent: false,
    };
    if (path.has(id)) {
      node.repeat = node.cycle = true;
      return node;
    }
    if (expanded.has(id)) {
      node.repeat = true;
      return node;
    }
    expanded.add(id);
    path.add(id);
    node.children = childrenOf(id).map((c) => visit(c, depth + 1, path));
    path.delete(id);
    node.leadsToCurrent = node.current || node.children.some((c) => c.leadsToCurrent && !c.repeat);
    return node;
  }

  const ordered = [...component].sort((a, b) => a - b);
  // Roots wait for nothing in the component. A card off the board is a root too: it waits for nothing we know of.
  const roots: TreeNode[] = ordered
    .filter((id) => blockersById(id).every((d) => !component.has(d)))
    .map((id) => visit(id, 0, new Set()));
  // A ring has no root: start it from the card itself, otherwise from its lowest number, until all are shown
  while (expanded.size < component.size) {
    const seed = !expanded.has(taskId) ? taskId : (ordered.find((id) => !expanded.has(id)) as number);
    roots.push(visit(seed, 0, new Set()));
  }
  return roots;
}

/** How many cards a tree holds, repeats included: whether the tree has anything to show besides the card itself. */
export function treeSize(nodes: readonly TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + treeSize(n.children), 0);
}

/** A subtree deeper than this starts collapsed, unless it leads to the card itself. */
export const TREE_OPEN_DEPTH = 3;

export interface StageGroup {
  /** null is the cards without a stage. */
  stage: number | null;
  tasks: Task[];
}

/**
 * The subtasks grouped by stage, in stage order, the cards without one last ("No stage"). Without any stage at
 * all it is a single group, and the list is drawn flat, as before stages existed.
 */
export function groupByStage(children: readonly Task[]): StageGroup[] {
  const groups = new Map<number | null, Task[]>();
  for (const child of children) {
    const key = child.stage ?? null;
    groups.set(key, [...(groups.get(key) ?? []), child]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([stage, tasks]) => ({ stage, tasks }));
}
