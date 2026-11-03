import { describe, it, expect } from "vitest";
import { binLabel, bucketTitle, formatBucket, formatDay, formatDuration, formatPercent, isKnownPeriod, labelStep, niceMax, periodLabel } from "./analytics";
import { defaultT as t, defaultT } from "./i18n";

describe("formatDuration", () => {
  it("writes units a person can read, and no more than two", () => {
    expect(formatDuration(t, 42)).toBe("42 s");
    expect(formatDuration(t, 7 * 60)).toBe("7 min");
    expect(formatDuration(t, 3600)).toBe("1 h");
    expect(formatDuration(t, 4800)).toBe("1 h 20 min");
    expect(formatDuration(t, 3 * 86400 + 4 * 3600)).toBe("3 d 4 h");
  });

  it("nothing to measure is a dash, not zero", () => {
    expect(formatDuration(t, null)).toBe("—");
    expect(formatDuration(t, undefined)).toBe("—");
    expect(formatDuration(t, 0)).toBe("0 s");
  });
});

it("a share is written as a percentage, and a missing share as a dash", () => {
  expect(formatPercent(0.867)).toBe("87%");
  expect(formatPercent(1)).toBe("100%");
  expect(formatPercent(null)).toBe("—");
});

it("a date is parsed from a string, without time zones", () => {
  // new Date("2026-09-18") in a negative-offset time zone would give September 17
  expect(formatDay(t, "2026-09-18")).toBe("18 Sep");
  expect(formatBucket(t, "2026-09-01", "month")).toBe("Sep 26");
  expect(bucketTitle(t, "2026-09-14", "week")).toBe("week of 14 Sep");
  expect(bucketTitle(t, "2026-09-14", "day")).toBe("14 Sep");
});

it("the axis ceiling is rounded up to a readable number", () => {
  expect(niceMax(7)).toBe(8);
  expect(niceMax(23)).toBe(25);
  expect(niceMax(60)).toBe(60);
  expect(niceMax(140)).toBe(150);
  expect(niceMax(1)).toBe(1);
  expect(niceMax(0)).toBe(1);
});

it("axis labels are thinned out so there are no more than eight", () => {
  expect(labelStep(5)).toBe(1);
  expect(labelStep(31)).toBe(4);
  expect(labelStep(365)).toBe(46);
});

it("the period is validated against the same list as on the server", () => {
  expect(isKnownPeriod(30)).toBe(true);
  expect(isKnownPeriod(0)).toBe(true);
  expect(isKnownPeriod(13)).toBe(false);
  expect(periodLabel(t, 0)).toBe("for all time");
  expect(periodLabel(t, 7)).toBe("for 7 days");
});

describe("binLabel", () => {
  const bin = (from_sec: number, to_sec: number | null) => ({ label: "", from_sec, to_sec, count: 0 });
  it("builds the bucket label from the bounds in the interface language", () => {
    expect(binLabel(defaultT, bin(0, 300))).toBe("< 5 min");
    expect(binLabel(defaultT, bin(300, 900))).toBe("5–15 min");
    expect(binLabel(defaultT, bin(3600, 7200))).toBe("1–2 h");
    expect(binLabel(defaultT, bin(14400, null))).toBe("> 4 h");
  });
  it("different units on the bounds are both kept in full", () => {
    expect(binLabel(defaultT, bin(1800, 3600))).toBe("30 min – 1 h");
  });
});
