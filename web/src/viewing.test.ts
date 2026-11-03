import { describe, expect, it } from "vitest";
import { isUnviewed, tracksViewed, unviewedByProject, withUnviewedFirst } from "./viewing";
import type { Project, Task } from "./types";

const base: Task = {
  id: 1, project_id: 1, title: "", description: "", status: "done", priority: "normal", blocker: null,
  blocker_detail: null, target_branch: null, model: null, effort: null, permission_mode: null, verify_cmd: null,
  requires_review: 0, worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0,
  state_miss_count: 0, quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null,
  merge_queued_at: null, retry_after: null, report_json: null,
  created_at: "2026-01-01T00:00:00+00:00", updated_at: "2026-01-01T00:00:00+00:00",
  done_at: "2026-03-01T10:00:00+00:00", archived_at: null, position: null, usage_json: null, depends_on: [],
  viewed_at: null,
};

const project = (id: number, track_viewed?: number) => ({ id, track_viewed }) as Project;

describe("unviewed result", () => {
  it("a finished task without a mark waits to be viewed", () => {
    expect(isUnviewed(base)).toBe(true);
    expect(isUnviewed({ ...base, viewed_at: "2026-03-01T11:00:00+00:00" })).toBe(false);
  });

  // The task was viewed, sent back for rework, and closed again: the result is new,
  // and the previous mark does not apply to it.
  it("a mark older than the hand-in does not count", () => {
    expect(isUnviewed({ ...base, viewed_at: "2026-03-01T09:00:00+00:00" })).toBe(true);
    // A mark in the same second as the hand-in is already a viewing: the server's time precision is one second
    expect(isUnviewed({ ...base, viewed_at: "2026-03-01T10:00:00+00:00" })).toBe(false);
  });

  it("an old task without a hand-in moment: the mark always applies", () => {
    expect(isUnviewed({ ...base, done_at: null, viewed_at: "2020-01-01T00:00:00+00:00" })).toBe(false);
    expect(isUnviewed({ ...base, done_at: null })).toBe(true);
  });

  // A failure calls the person on its own: it is in "Waiting for me"; a second mark on top of it would be noise.
  it("unfinished, failed and archived ones do not wait for viewing", () => {
    expect(isUnviewed({ ...base, status: "in_progress" })).toBe(false);
    expect(isUnviewed({ ...base, status: "failed" })).toBe(false);
    expect(isUnviewed({ ...base, archived_at: "2026-03-02T00:00:00+00:00" })).toBe(false);
  });

  it("a field that did not come from an old server: the task counts as unviewed, but the project does not take part", () => {
    const { viewed_at: _omit, ...old } = base;
    expect(isUnviewed(old as Task)).toBe(true);
    expect(tracksViewed(project(1))).toBe(false);
    expect(unviewedByProject([old as Task], [project(1)]).size).toBe(0);
  });
});

describe("order and counters", () => {
  const tasks: Task[] = [
    { ...base, id: 1, viewed_at: "2026-03-02T00:00:00+00:00" },
    { ...base, id: 2 },
    { ...base, id: 3, status: "failed" },
    { ...base, id: 4 },
  ];

  it("unviewed ones go to the top, the rest of the order is kept", () => {
    expect(withUnviewedFirst(tasks).map((t) => t.id)).toEqual([2, 4, 1, 3]);
    expect(tasks.map((t) => t.id)).toEqual([1, 2, 3, 4]); // the input is not mutated
  });

  it("counts per project and skips those where viewing is off", () => {
    const all = [...tasks, { ...base, id: 5, project_id: 2 }, { ...base, id: 6, project_id: 3 }];
    const counts = unviewedByProject(all, [project(1, 1), project(2, 0), project(3, 1)]);
    expect([...counts.entries()]).toEqual([[1, 2], [3, 1]]);
  });
});
