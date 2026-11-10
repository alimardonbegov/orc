import { describe, expect, it } from "vitest";
import { needsAttention } from "./status";
import type { Task } from "./types";

const base: Task = {
  id: 1, project_id: 1, title: "", description: "", status: "done", priority: "normal", blocker: null,
  blocker_detail: null, target_branch: null, verify_cmd: null,
  requires_review: 0, worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0,
  state_miss_count: 0, quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null,
  merge_queued_at: null, retry_after: null, report_json: null,
  created_at: "2026-01-01T00:00:00+00:00", updated_at: "2026-01-01T00:00:00+00:00",
  done_at: null, archived_at: null, position: null, usage_json: null, depends_on: [],
};

describe("needsAttention", () => {
  it("does not count a failed card: it already sits in Done with a red status", () => {
    expect(needsAttention({ ...base, status: "failed" })).toBe(false);
  });

  it("counts a card blocked on a human", () => {
    expect(needsAttention({ ...base, status: "in_progress", blocker: "needs_input" })).toBe(true);
  });

  it("ignores quota and sleeping blockers", () => {
    expect(needsAttention({ ...base, status: "in_progress", blocker: "quota" })).toBe(false);
    expect(needsAttention({ ...base, status: "in_progress", blocker: "sleeping" })).toBe(false);
  });
});
