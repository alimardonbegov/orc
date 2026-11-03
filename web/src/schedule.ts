import type { Task } from "./types";
import type { TFunction } from "./i18n";
import { fullDateTime } from "./dates";

/**
 * Deferred task start.
 *
 * On the server time is stored as ISO in UTC, while the `datetime-local` field shows and returns local
 * time without a zone — all conversion between them lives here, so the form and the card do not count
 * time zones each in their own way.
 */

export interface ScheduleValues {
  start_after: string | null;
  start_before: string | null;
}

export type SchedulePreset = "30m" | "1h" | "3h" | "tomorrow9";
export const SCHEDULE_PRESETS: SchedulePreset[] = ["30m", "1h", "3h", "tomorrow9"];

export type ScheduleError = "endWithoutStart" | "endBeforeStart" | "endPassed";

export type ScheduleState =
  | { kind: "waiting"; at: number }
  | { kind: "window"; until: number }
  | { kind: "missed" };

const MINUTE = 60_000;
const PRESET_MINUTES: Record<Exclude<SchedulePreset, "tomorrow9">, number> = { "30m": 30, "1h": 60, "3h": 180 };
// A schedule makes sense until the task is started: for working and finished ones it was already cleared at start.
const SCHEDULABLE = new Set<Task["status"]>(["backlog", "todo", "failed"]);

const parse = (raw: string | null | undefined): number | null => {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
};

// The server stores "...+00:00", the client sends "....000Z" — the same moment but different strings, so we compare milliseconds
const sameMoment = (a: string | null | undefined, b: string | null | undefined): boolean => parse(a) === parse(b);

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO → value for `<input type="datetime-local">` in local time: "2026-10-05T23:15". */
export function toLocalInput(iso: string | null | undefined): string {
  const ms = parse(iso);
  if (ms === null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value (local, no zone) → ISO UTC. Empty — null. */
export function fromLocalInput(local: string): string | null {
  if (!local) return null;
  // A string without a zone like YYYY-MM-DDTHH:mm is read by the browser as local time — what the owner sees
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Quick pick of "not earlier than" from the current moment. Seconds are trimmed: the field does not show them. */
export function presetStart(preset: SchedulePreset, now: number): string {
  const d = preset === "tomorrow9" ? new Date(now) : new Date(now + PRESET_MINUTES[preset] * MINUTE);
  if (preset === "tomorrow9") {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  } else {
    d.setSeconds(0, 0);
  }
  return d.toISOString();
}

/**
 * Pair error — the same rules as on the server (orc/schedule.py:validate). An unchanged pair
 * (initial) is not checked for "end in the past": the window could have expired while the card sat
 * in the backlog, and now the title is being edited.
 */
export function scheduleError(v: ScheduleValues, now: number, initial?: ScheduleValues): ScheduleError | null {
  if (!v.start_before) return null;
  if (!v.start_after) return "endWithoutStart";
  const end = parse(v.start_before);
  const start = parse(v.start_after);
  if (end === null || start === null) return null;
  if (end <= start) return "endBeforeStart";
  const unchanged = initial !== undefined && sameMoment(initial.start_after, v.start_after) && sameMoment(initial.start_before, v.start_before);
  if (!unchanged && end <= now) return "endPassed";
  return null;
}

/** What to show on the card: waiting for start, window in progress, window missed — or nothing. */
export function scheduleState(task: Pick<Task, "status" | "start_after" | "start_before">, now: number): ScheduleState | null {
  if (!SCHEDULABLE.has(task.status)) return null;
  const after = parse(task.start_after);
  const before = parse(task.start_before);
  if (before !== null && before <= now) return { kind: "missed" };
  if (after !== null && after > now) return { kind: "waiting", at: after };
  if (before !== null) return { kind: "window", until: before };
  return null;
}

/** Window end time: "06:00" if today, otherwise with a date — "Oct 6, 06:00". */
export function windowTime(at: number, locale: string, now: number): string {
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return d.toLocaleString(locale, {
    ...(sameDay ? {} : { day: "numeric", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Badge tooltip: the exact window boundaries line by line. */
export function scheduleTitle(t: TFunction, task: Pick<Task, "start_after" | "start_before">, locale: string): string {
  const lines: string[] = [];
  const after = parse(task.start_after);
  const before = parse(task.start_before);
  if (after !== null) lines.push(t("taskCard.schedule.notBefore", { time: fullDateTime(after, locale) }));
  if (before !== null) lines.push(t("taskCard.schedule.notAfter", { time: fullDateTime(before, locale) }));
  return lines.join("\n");
}
