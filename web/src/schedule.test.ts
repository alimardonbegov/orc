import { describe, expect, it } from "vitest";
import { fromLocalInput, presetStart, scheduleError, scheduleState, toLocalInput } from "./schedule";

const NOW = new Date(2026, 9, 5, 14, 37, 12).getTime(); // Oct 5, 2026, 14:37:12 local

describe("datetime-local ↔ ISO conversion", () => {
  it("local time does not shift back and forth", () => {
    const local = "2026-10-05T23:15";
    const iso = fromLocalInput(local);
    expect(iso).toMatch(/Z$/);
    expect(toLocalInput(iso)).toBe(local);
  });
  it("empty and garbage", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(toLocalInput(null)).toBe("");
    expect(toLocalInput("garbage")).toBe("");
  });
});

describe("presets", () => {
  it("+1 h from the current moment, seconds truncated", () => {
    const at = new Date(presetStart("1h", NOW));
    expect(at.getHours()).toBe(15);
    expect(at.getMinutes()).toBe(37);
    expect(at.getSeconds()).toBe(0);
  });
  it("tomorrow 09:00 local", () => {
    const at = new Date(presetStart("tomorrow9", NOW));
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([6, 9, 0]);
  });
});

describe("pair errors", () => {
  const iso = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
  it("rules", () => {
    expect(scheduleError({ start_after: null, start_before: null }, NOW)).toBeNull();
    expect(scheduleError({ start_after: iso(-1), start_before: null }, NOW)).toBeNull();
    expect(scheduleError({ start_after: null, start_before: iso(1) }, NOW)).toBe("endWithoutStart");
    expect(scheduleError({ start_after: iso(2), start_before: iso(1) }, NOW)).toBe("endBeforeStart");
    expect(scheduleError({ start_after: iso(-3), start_before: iso(-1) }, NOW)).toBe("endPassed");
  });
  it("an unchanged pair with an expired end is not an error: the other field is being edited", () => {
    const v = { start_after: iso(-3), start_before: iso(-1) };
    expect(scheduleError(v, NOW, { ...v })).toBeNull();
  });
  it("the same pair in the \"+00:00\" (server) and \".000Z\" (client) forms is unchanged", () => {
    // Times are derived from NOW: the end must be in the past in any time zone, otherwise the test proves nothing
    const H = 3_600_000;
    const client = (ms: number) => new Date(ms).toISOString(); // «.000Z»
    const server = (ms: number) => client(ms).replace(".000Z", "+00:00");
    const initial = { start_after: server(NOW - 3 * H), start_before: server(NOW - H) };
    const v = { start_after: client(NOW - 3 * H), start_before: client(NOW - H) };
    expect(scheduleError(v, NOW, initial)).toBeNull();
    // Control: another expired end is already a change, and that is an error
    expect(scheduleError({ ...v, start_before: client(NOW - 2 * H) }, NOW, initial)).toBe("endPassed");
  });
});

describe("state for the card", () => {
  const iso = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
  it("waits, window, missed", () => {
    expect(scheduleState({ status: "todo", start_after: iso(2), start_before: null }, NOW)).toEqual({ kind: "waiting", at: NOW + 2 * 3_600_000 });
    expect(scheduleState({ status: "todo", start_after: iso(-1), start_before: iso(1) }, NOW)).toEqual({ kind: "window", until: NOW + 3_600_000 });
    expect(scheduleState({ status: "backlog", start_after: iso(-3), start_before: iso(-1) }, NOW)).toEqual({ kind: "missed" });
  });
  it("without a schedule, one that arrived without a window and working statuses mean nothing", () => {
    expect(scheduleState({ status: "todo", start_after: null, start_before: null }, NOW)).toBeNull();
    expect(scheduleState({ status: "todo", start_after: iso(-1), start_before: null }, NOW)).toBeNull();
    expect(scheduleState({ status: "in_progress", start_after: iso(2), start_before: null }, NOW)).toBeNull();
    expect(scheduleState({ status: "todo" }, NOW)).toBeNull(); // old server without the fields
  });
});
