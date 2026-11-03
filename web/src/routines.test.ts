import { it, expect } from "vitest";
import { joinInterval, runDuration, runOutcome, scheduleText, splitInterval, successRate, untilLabel } from "./routines";
import type { RoutineRun } from "./types";

const run = (over: Partial<RoutineRun> = {}): RoutineRun => ({
  task_id: 1, run: 1, title: "R · #1", status: "done", blocker: null, blocker_detail: null,
  created_at: "2026-10-07T12:00:00+00:00", started_at: "2026-10-07T12:00:30+00:00",
  done_at: "2026-10-07T12:10:30+00:00", updated_at: "2026-10-07T12:10:30+00:00", archived_at: null,
  report: null, tokens: null, ...over,
});

it("an interval is split into the largest whole unit and assembled back", () => {
  expect(splitInterval(15)).toEqual({ value: 15, unit: "minutes" });
  expect(splitInterval(120)).toEqual({ value: 2, unit: "hours" });
  expect(splitInterval(2880)).toEqual({ value: 2, unit: "days" });
  expect(splitInterval(90)).toEqual({ value: 90, unit: "minutes" });
  expect(splitInterval(null)).toEqual({ value: 1, unit: "hours" });
  expect(joinInterval(3, "hours")).toBe(180);
  expect(joinInterval(1, "days")).toBe(1440);
});

it("run duration: up to done_at, for a failed one up to the last change", () => {
  expect(runDuration(run())).toBe(10 * 60_000);
  expect(runDuration(run({ status: "failed", done_at: null, updated_at: "2026-10-07T12:05:30+00:00" }))).toBe(5 * 60_000);
  expect(runDuration(run({ status: "in_progress", done_at: null }))).toBeNull();
  expect(runDuration(run({ started_at: null }))).toBeNull();
});

it("the run outcome is the report summary, otherwise the failure reason", () => {
  expect(runOutcome(run({ report: { status: "success", summary: " all done " } }))).toBe("all done");
  expect(runOutcome(run({ status: "failed", blocker_detail: "merge failed" }))).toBe("merge failed");
  expect(runOutcome(run())).toBe("");
});

it("the success rate counts only finished runs", () => {
  const stats = (done: number, failed: number) => ({ stats: { total: done + failed + 1, done, failed, active: 1, skipped: 0 } });
  expect(successRate(stats(3, 1))).toBe(0.75);
  expect(successRate(stats(0, 0))).toBeNull();
});

it("the next-run caption looks to the future", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  expect(untilLabel(now + 23 * 60_000, "en", now)).toBe("in 23 min.");
  expect(untilLabel(now + 5 * 3_600_000, "en", now)).toBe("in 5 hr.");
  expect(untilLabel(now - 1000, "en", now)).toBe("now");
});

it("the schedule reads in a human way", async () => {
  const { defaultT } = await import("./i18n");
  const r = (over: object) => ({ schedule_kind: "interval" as const, interval_minutes: 60, cron: null, timezone: null, ...over });
  expect(scheduleText(defaultT, r({}))).toBe("every hour");
  expect(scheduleText(defaultT, r({ interval_minutes: 15 }))).toBe("every 15 min");
  expect(scheduleText(defaultT, r({ interval_minutes: 180 }))).toBe("every 3 h");
  expect(scheduleText(defaultT, r({ interval_minutes: 1440 }))).toBe("every day");
  expect(scheduleText(defaultT, r({ schedule_kind: "cron", cron: "0 9 * * 1-5", timezone: "Europe/Moscow" })))
    .toBe("cron 0 9 * * 1-5 · Europe/Moscow");
});
