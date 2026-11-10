import { expect, it } from "vitest";
import { formatDay, isOverdue, todayKey } from "./planDates";

it("today is the local calendar day", () => {
  expect(todayKey(new Date(2026, 10, 7, 23, 59).getTime())).toBe("2026-11-07");
  expect(todayKey(new Date(2026, 0, 2, 0, 1).getTime())).toBe("2026-01-02");
});

it("a due date is overdue until the card is done", () => {
  expect(isOverdue("2026-11-06", "todo", "2026-11-07")).toBe(true);
  expect(isOverdue("2026-11-06", "in_progress", "2026-11-07")).toBe(true);
  expect(isOverdue("2026-11-06", "done", "2026-11-07")).toBe(false);
  expect(isOverdue("2026-11-07", "todo", "2026-11-07")).toBe(false);
  expect(isOverdue(null, "todo", "2026-11-07")).toBe(false);
});

it("a day shows the year only when it is not this one", () => {
  const now = new Date(2026, 5, 1).getTime();
  expect(formatDay("2026-11-07", "en", now)).not.toContain("2026");
  expect(formatDay("2027-01-03", "en", now)).toContain("2027");
  expect(formatDay("junk", "en", now)).toBe("junk");
});
