import { describe, expect, it } from "vitest";
import { DEFAULT_DONE_SORT, finishedAt, isDoneSort, sortDone } from "./sort";
import type { Task } from "./types";

const base: Task = {
  id: 1, project_id: 1, title: "", description: "", status: "done", priority: "normal", blocker: null,
  blocker_detail: null, target_branch: null, model: null, effort: null, permission_mode: null, verify_cmd: null,
  requires_review: 0, worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0,
  state_miss_count: 0, quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null,
  merge_queued_at: null, retry_after: null, report_json: null,
  created_at: "2026-01-01T00:00:00+00:00", updated_at: "2026-01-01T00:00:00+00:00",
  done_at: null, archived_at: null, position: null, usage_json: null, depends_on: [],
};

const done = (id: number, at: string): Task => ({ ...base, id, done_at: at });
const ids = (tasks: Task[]) => tasks.map((t) => t.id);

describe("archive sort key", () => {
  it("takes done_at when it exists", () => {
    expect(finishedAt(done(1, "2026-03-05T10:00:00+00:00"))).toBe(Date.parse("2026-03-05T10:00:00+00:00"));
  });

  // The dispatcher does not set done_at on a failure (orc/dispatcher.py): without a fallback key
  // all failed tasks would stick together at one point in time and surface in a heap.
  it("for a failure without done_at it falls back to updated_at", () => {
    const failed: Task = { ...base, status: "failed", updated_at: "2026-04-01T09:00:00+00:00" };
    expect(finishedAt(failed)).toBe(Date.parse("2026-04-01T09:00:00+00:00"));
  });

  it("an unreadable time does not break the sort", () => {
    expect(finishedAt({ ...base, done_at: "not a date", updated_at: "", created_at: "" })).toBe(0);
  });
});

describe("order of the \"Done\" column", () => {
  const tasks = [
    done(1, "2026-01-10T00:00:00+00:00"),
    done(2, "2026-03-20T00:00:00+00:00"),
    done(3, "2026-02-15T00:00:00+00:00"),
  ];

  it("by default the most recently closed are on top", () => {
    expect(DEFAULT_DONE_SORT).toBe("recent");
    expect(ids(sortDone(tasks, "recent"))).toEqual([2, 3, 1]);
  });

  it("the reverse order shows the oldest on top", () => {
    expect(ids(sortDone(tasks, "oldest"))).toEqual([1, 3, 2]);
  });

  it("failure mode lifts the failed ones, leaves the rest by recency", () => {
    const withFailed = [...tasks, { ...done(4, "2026-01-01T00:00:00+00:00"), status: "failed" as const }];
    expect(ids(sortDone(withFailed, "failed"))).toEqual([4, 2, 3, 1]);
  });

  // The board re-sorts the same array on every server poll:
  // mutating the input would shuffle the data under the other columns.
  it("does not touch the source array", () => {
    const input = [...tasks];
    sortDone(input, "oldest");
    expect(ids(input)).toEqual([1, 2, 3]);
  });

  // Without a tie-break, tasks closed in the same second would swap places between polls.
  it("the same time is separated by the task number", () => {
    const same = [done(5, "2026-05-01T00:00:00+00:00"), done(9, "2026-05-01T00:00:00+00:00")];
    expect(ids(sortDone(same, "recent"))).toEqual([9, 5]);
    expect(ids(sortDone(same, "oldest"))).toEqual([5, 9]);
  });

  it("a foreign value from storage is not considered an order", () => {
    expect(isDoneSort("recent")).toBe(true);
    expect(isDoneSort("alphabetical")).toBe(false);
    expect(isDoneSort(undefined)).toBe(false);
  });
});
