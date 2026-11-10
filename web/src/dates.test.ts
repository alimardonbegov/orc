import { describe, expect, it } from "vitest";
import { cardMoment, dayHeading, formatDuration, momentLabel, relativeTime, timeline, timelineTitle } from "./dates";
import { defaultT } from "./i18n";
import type { Task } from "./types";

const base: Task = {
  id: 1, project_id: 1, title: "", description: "", status: "backlog", priority: "normal", blocker: null,
  blocker_detail: null, target_branch: null, verify_cmd: null,
  requires_review: 0, worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0,
  state_miss_count: 0, quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null,
  merge_queued_at: null, retry_after: null, report_json: null,
  created_at: "2026-09-20T09:00:00+00:00", updated_at: "2026-09-22T18:00:00+00:00",
  done_at: null, archived_at: null, position: null, usage_json: null, depends_on: [],
};

// Times are built in the local zone: "today" and "yesterday" are calendar days of whoever is looking,
// and the test must not depend on the machine's time zone.
const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime();
const NOW = local(23, 15);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("main date of a card", () => {
  it("in the queue, the creation moment", () => {
    expect(cardMoment(base)).toEqual({ kind: "created", at: Date.parse(base.created_at) });
    expect(cardMoment({ ...base, status: "todo" })?.kind).toBe("created");
  });

  it("in work, the moment of the first session", () => {
    const task: Task = { ...base, status: "verifying", started_at: "2026-09-21T10:00:00+00:00" };
    expect(cardMoment(task)).toEqual({ kind: "started", at: Date.parse("2026-09-21T10:00:00+00:00") });
  });

  // A session is not registered instantly after launch: there is nothing to invent a start from.
  it("in work without a session, the creation moment", () => {
    expect(cardMoment({ ...base, status: "in_progress", started_at: null })?.kind).toBe("created");
  });

  it("a finished one is done_at, a failed one is updated_at", () => {
    expect(cardMoment({ ...base, status: "done", done_at: "2026-09-22T12:00:00+00:00" })).toEqual({
      kind: "done", at: Date.parse("2026-09-22T12:00:00+00:00"),
    });
    expect(cardMoment({ ...base, status: "failed" })).toEqual({ kind: "failed", at: Date.parse(base.updated_at) });
  });
});

describe("relative time", () => {
  it("minutes and hours within a day", () => {
    expect(relativeTime(NOW - 20 * 1000, "en", NOW)).toBe("now");
    expect(relativeTime(NOW - 5 * MIN, "en", NOW)).toBe("5 min. ago");
    expect(relativeTime(NOW - 3 * HOUR, "en", NOW)).toBe("3 hr. ago");
  });

  it("yesterday by the calendar, then days, after a week a date", () => {
    expect(relativeTime(local(22, 10), "en", NOW)).toBe("yesterday");
    expect(relativeTime(local(19, 10), "en", NOW)).toBe("4 days ago");
    expect(relativeTime(local(2, 10), "en", NOW)).toBe("Sep 2");
    expect(relativeTime(new Date(2025, 11, 30).getTime(), "en", NOW)).toBe("Dec 30, 2025");
  });

  it("speaks the interface language", () => {
    expect(relativeTime(local(22, 10), "ru", NOW)).toBe("вчера");
  });
});

describe("duration", () => {
  it("the two most significant units", () => {
    expect(formatDuration(defaultT, 30 * 1000)).toBe("<1 min");
    expect(formatDuration(defaultT, 45 * MIN)).toBe("45 min");
    expect(formatDuration(defaultT, 2 * HOUR + 5 * MIN)).toBe("2 h 5 min");
    expect(formatDuration(defaultT, 3 * HOUR)).toBe("3 h");
    expect(formatDuration(defaultT, 3 * 24 * HOUR + 4 * HOUR + 30 * MIN)).toBe("3 d 4 h");
    expect(formatDuration(defaultT, 2 * 24 * HOUR)).toBe("2 d");
  });
});

describe("caption on the card", () => {
  it("with a verb, so it is clear which moment this is", () => {
    expect(momentLabel(defaultT, { kind: "done", at: NOW - 2 * HOUR }, "en", NOW)).toBe("done 2 hr. ago");
    expect(momentLabel(defaultT, { kind: "created", at: local(22, 9) }, "en", NOW)).toBe("created yesterday");
    expect(momentLabel(defaultT, { kind: "started", at: NOW - 45 * MIN }, "en", NOW)).toBe("in work 45 min");
  });
});

describe("chronology", () => {
  const done: Task = {
    ...base,
    status: "done",
    created_at: "2026-09-20T09:00:00+00:00",
    started_at: "2026-09-20T11:00:00+00:00",
    done_at: "2026-09-20T11:30:00+00:00",
  };

  it("created → taken → done, with the wait and the work time", () => {
    expect(timeline(done)).toEqual([
      { kind: "created", at: Date.parse(done.created_at) },
      { kind: "started", at: Date.parse(done.started_at!), since: 2 * HOUR },
      { kind: "done", at: Date.parse(done.done_at!), since: 30 * MIN },
    ]);
  });

  it("without a session there is no start step, and the work time is not invented", () => {
    const steps = timeline({ ...done, started_at: null });
    expect(steps.map((s) => s.kind)).toEqual(["created", "done"]);
    expect(steps[1].since).toBeUndefined();
  });

  it("an unfinished task without a final", () => {
    expect(timeline({ ...done, status: "in_progress" }).map((s) => s.kind)).toEqual(["created", "started"]);
  });

  it("the tooltip lists all steps", () => {
    expect(timelineTitle(defaultT, done, "en").split("\n").map((l) => l.split(":")[0])).toEqual(["Created", "Started", "Done"]);
  });
});

describe("day heading in \"Done\"", () => {
  it("today, yesterday, date, date with year", () => {
    expect(dayHeading(defaultT, local(23, 1), "en", NOW)).toBe("Today");
    expect(dayHeading(defaultT, local(22, 23), "en", NOW)).toBe("Yesterday");
    expect(dayHeading(defaultT, local(21, 12), "en", NOW)).toBe("September 21");
    expect(dayHeading(defaultT, new Date(2025, 11, 30).getTime(), "en", NOW)).toBe("December 30, 2025");
  });
});
