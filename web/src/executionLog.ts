import type { ExecutionLog, TaskCheck, TaskMerge, TaskRun } from "./types";

/** The card lists this many rows; the rest are behind "Show all". Active runs are never cut. */
export const LIST_ROWS = 3;

export type LogEntry =
  | { kind: "run"; key: string; at: number; run: TaskRun }
  | { kind: "check"; key: string; at: number; check: TaskCheck }
  | { kind: "merge"; key: string; at: number; merge: TaskMerge };

function moment(iso: string | null | undefined): number {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(value) ? 0 : value;
}

export interface LogRows {
  /** Runs still going, oldest first: they carry the stop action, so all of them show. */
  active: LogEntry[];
  /** Everything over, newest first: runs by their end, checks and merges by their moment. */
  past: LogEntry[];
}

export function logRows(log: ExecutionLog): LogRows {
  const active: LogEntry[] = [];
  const past: LogEntry[] = [];
  for (const run of log.runs) {
    const entry: LogEntry = { kind: "run", key: `run-${run.id}`, at: moment(run.ended_at ?? run.started_at), run };
    (run.active ? active : past).push(entry);
  }
  for (const check of log.checks) past.push({ kind: "check", key: `check-${check.id}`, at: moment(check.created_at), check });
  for (const merge of log.merges) past.push({ kind: "merge", key: `merge-${merge.id}`, at: moment(merge.at), merge });
  // On the same second a run ends before its check, and a check before its merge: newest first means the reverse
  const order = { merge: 0, check: 1, run: 2 } as const;
  past.sort((a, b) => b.at - a.at || order[a.kind] - order[b.kind]);
  active.sort((a, b) => a.at - b.at);
  return { active, past };
}

/** What the card shows of the past: what is left of LIST_ROWS after the active runs. */
export function visiblePast(rows: LogRows): LogEntry[] {
  return rows.past.slice(0, Math.max(0, LIST_ROWS - rows.active.length));
}

/** A live timer: 0:42, 12:05, 1:02:03. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The latest run, which alone the card's actions can act on: Stop and Retry act on the task, not on a run. */
export function latestRun(log: ExecutionLog): TaskRun | undefined {
  return log.runs[log.runs.length - 1];
}
