import { describe, expect, it } from "vitest";
import {
  ancestorsOf, attachCandidates, comesNext, dependencyTree, groupByStage, progressOf, subtaskProgress, subtasksOf, treeSize, waitsFor,
  type TreeNode,
} from "./relations";
import type { Task, TaskStatus } from "./types";

const base: Task = {
  id: 1, project_id: 1, title: "", description: "", status: "backlog", priority: "normal", blocker: null,
  blocker_detail: null, target_branch: null, verify_cmd: null,
  requires_review: 0, worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0,
  state_miss_count: 0, quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null,
  merge_queued_at: null, retry_after: null, report_json: null,
  created_at: "2026-01-01T00:00:00+00:00", updated_at: "2026-01-01T00:00:00+00:00",
  done_at: null, archived_at: null, position: null, usage_json: null, depends_on: [],
};

const task = (id: number, depends_on: number[] = [], extra: Partial<Task> = {}): Task => ({ ...base, id, title: `T${id}`, depends_on, ...extra });

/** The tree as indented lines: "  3*" is card 3 one level down, highlighted; "(r)" a repeat, "(c)" a ring. */
function draw(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => [
    `${"  ".repeat(n.depth)}${n.id}${n.current ? "*" : ""}${n.cycle ? " (c)" : n.repeat ? " (r)" : ""}${n.task ? "" : " (gone)"}`,
    ...draw(n.children),
  ]);
}

// A → B → D and A → C → D: a chain with a diamond, as 1 → 2 → 4, 1 → 3 → 4, and 5 after 4.
const diamond = [task(1), task(2, [1]), task(3, [1]), task(4, [2, 3]), task(5, [4])];

describe("relations of a card", () => {
  it("waits for, comes next, and a blocker off the board stays a number", () => {
    expect(waitsFor(diamond[3], diamond).map((r) => r.id)).toEqual([2, 3]);
    expect(waitsFor(task(9, [1, 77]), diamond).map((r) => r.task?.id ?? null)).toEqual([1, null]);
    expect(comesNext(1, diamond).map((t) => t.id)).toEqual([2, 3]);
    expect(comesNext(5, diamond)).toEqual([]);
  });

  it("subtasks and their progress", () => {
    const all = [task(1), task(2, [], { parent_task_id: 1, status: "done" }), task(3, [], { parent_task_id: 1 }), task(4, [], { parent_task_id: 3 })];
    expect(subtasksOf(1, all).map((t) => t.id)).toEqual([2, 3]);
    expect(progressOf(subtasksOf(1, all))).toEqual({ done: 1, total: 2 });
    expect(subtaskProgress(all)).toEqual(new Map([[1, { done: 1, total: 2 }], [3, { done: 0, total: 1 }]]));
  });

  it("a card cannot take its own parent as a subtask, and a ring of parents does not hang", () => {
    const all = [task(1), task(2, [], { parent_task_id: 1 }), task(3, [], { parent_task_id: 2 }), task(4)];
    expect(ancestorsOf(3, all)).toEqual([2, 1]);
    expect(attachCandidates(3, all).map((t) => t.id)).toEqual([4]);
    expect(attachCandidates(1, all).map((t) => t.id)).toEqual([3, 4]);
    const ring = [task(1, [], { parent_task_id: 2 }), task(2, [], { parent_task_id: 1 })];
    expect(ancestorsOf(1, ring)).toEqual([2]);
  });
});

describe("dependency tree", () => {
  const expected = (current: number) =>
    ["1", "  2", "    4", "      5", "  3", "    4 (r)"].map((line) => (line.trim().split(" ")[0] === String(current) && !line.includes("(r)") ? line.replace(/(\d+)/, "$1*") : line));

  it.each([1, 2, 3, 4, 5])("the whole chain with its diamond, from card %i", (id) => {
    const tree = dependencyTree(id, diamond);
    // Every card of the component, whichever one the tree is drawn for, and the diamond's bottom once more as a repeat
    const lines = draw(tree).map((l) => (l.includes("(r)") ? l.replace("*", "") : l));
    expect(lines).toEqual(expected(id));
  });

  it("the path to the card stays open past the collapse depth", () => {
    const long = [task(1), task(2, [1]), task(3, [2]), task(4, [3]), task(5, [4]), task(6, [5])];
    const [root] = dependencyTree(6, long);
    let node = root;
    while (node.children.length > 0) {
      expect(node.leadsToCurrent).toBe(true);
      node = node.children[0];
    }
    expect(node.current && node.depth === 5).toBe(true);
    const fromTop = dependencyTree(1, long)[0];
    expect(fromTop.children[0].children[0].children[0].leadsToCurrent).toBe(false);
  });

  it("a ring cannot hang it: each card is expanded once and the return is marked", () => {
    const ring = [task(1, [3]), task(2, [1]), task(3, [2])];
    expect(draw(dependencyTree(2, ring))).toEqual(["2*", "  3", "    1", "      2* (c)"]);
    // A ring hanging off a root, and a self link, which is ignored
    const tail = [task(1), task(2, [1, 3]), task(3, [2, 3])];
    expect(draw(dependencyTree(1, tail))).toEqual(["1*", "  2", "    3", "      2 (c)"]);
  });

  it("an archived or deleted blocker is a leaf root, not walked through", () => {
    // 2 waits for 9, which is off the board; 3 also waits for 9, but nothing on the board links it to 2
    const all = [task(2, [9]), task(3, [9]), task(4, [2])];
    expect(draw(dependencyTree(4, all))).toEqual(["9 (gone)", "  2", "    4*"]);
  });

  it("a card of another project is part of the chain", () => {
    const all = [task(1, [], { project_id: 2 }), task(2, [1])];
    expect(draw(dependencyTree(2, all))).toEqual(["1", "  2*"]);
    expect(dependencyTree(2, all)[0].task?.project_id).toBe(2);
  });

  it("a card with no links has a tree of one", () => {
    expect(treeSize(dependencyTree(7, [task(7)]))).toBe(1);
    expect(treeSize(dependencyTree(4, diamond))).toBe(6);
  });

  it("statuses do not change the shape", () => {
    const statuses: TaskStatus[] = ["done", "failed", "in_progress", "todo", "backlog"];
    const mixed = diamond.map((t, i) => ({ ...t, status: statuses[i] }));
    expect(draw(dependencyTree(4, mixed))).toEqual(draw(dependencyTree(4, diamond)));
  });
});

describe("stages among subtasks", () => {
  // Parent 1 with stage 1 = {2, 3} and stage 2 = {4}: the server derives 4 waiting for 2 and 3.
  const staged = [
    task(1),
    task(2, [], { parent_task_id: 1, stage: 1 }),
    task(3, [], { parent_task_id: 1, stage: 1 }),
    task(4, [], { parent_task_id: 1, stage: 2, stage_blocked_by: [2, 3] }),
    task(5, [], { parent_task_id: 1 }),
  ];

  it("the stage blockers count as blockers, marked as coming from the stage", () => {
    expect(waitsFor(staged[3], staged).map((r) => [r.id, r.viaStage])).toEqual([[2, true], [3, true]]);
    expect(waitsFor(task(9, [2], { stage_blocked_by: [2, 3] }), staged).map((r) => [r.id, r.viaStage])).toEqual([[2, false], [3, true]]);
    expect(comesNext(2, staged).map((t) => t.id)).toEqual([4]);
  });

  it("the tree draws the stage the same way as links", () => {
    expect(draw(dependencyTree(4, staged))).toEqual(["2", "  4*", "3", "  4* (r)"]);
  });

  it("groups subtasks by stage in order, with the cards without one last", () => {
    expect(groupByStage(subtasksOf(1, staged)).map((g) => [g.stage, g.tasks.map((t) => t.id)])).toEqual([[1, [2, 3]], [2, [4]], [null, [5]]]);
    expect(groupByStage([task(7), task(8)]).map((g) => g.stage)).toEqual([null]);
  });
});
