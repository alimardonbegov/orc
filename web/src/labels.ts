import type { TFunction } from "./i18n";
import type { Blocker, InputKind, OutboxState, Priority, TaskStatus } from "./types";

// Labels for statuses, priorities and block badges — all translated via t() from the
// i18n/*.ts dictionaries (keys labels.*). STATUS_LABEL covers all backend statuses (their
// set has not changed), but there are only four columns on the board (see COLUMNS in Board.tsx):
// verifying/merging have no column of their own and are shown by the stageLabel badge on the card
// in the "In progress" column.
export function statusLabel(t: TFunction, status: TaskStatus): string {
  return t(`labels.status.${status}`);
}

// Stage inside the "In progress" column: verifying/merging have no separate column,
// but it is still useful to understand whether verification is running or the task is waiting in the merge queue.
export function stageLabel(t: TFunction, status: TaskStatus): string | undefined {
  return status === "verifying" || status === "merging" ? t(`labels.stage.${status}`) : undefined;
}

export function priorityLabel(t: TFunction, priority: Priority): string {
  return t(`labels.priority.${priority}`);
}

export function blockerLabel(t: TFunction, blocker: NonNullable<Blocker>): string {
  return t(`labels.blocker.${blocker}`);
}

// What exactly the agent is waiting for — more precise than the generic "waiting for an answer" when the request came through a hook
// and its kind is known (the same dictionary as KIND_LABEL in orc/inputs.py).
export function inputKindLabel(t: TFunction, kind: InputKind): string {
  return t(`labels.inputKind.${kind}`);
}

/** Waiting label on the card: by request kind if known, otherwise the generic badge. */
export function waitingLabel(
  t: TFunction,
  task: { blocker: Blocker; input_request?: { kind: InputKind } | null },
): string {
  if (task.input_request) return inputKindLabel(t, task.input_request.kind);
  return blockerLabel(t, "needs_input");
}

// Delivery state of a message to the task session. It does not change the column: the session is all along
// alive and holds a worker slot, so this is a badge, not a status.
export function outboxLabel(t: TFunction, state: NonNullable<OutboxState>): string {
  return t(`labels.outbox.${state}`);
}
