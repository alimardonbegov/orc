import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  GitMerge,
  Hand,
  Inbox,
  Loader,
  Moon,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { Blocker, Task, TaskStatus } from "./types";

/**
 * Visual vocabulary of statuses: one source of color and icon for the board, cards,
 * event feed and modal. Color in the interface means exactly one thing — task state
 * (see the palette comment in index.css), so all of it is collected here.
 *
 * Labels are not included: they depend on the language and are taken via statusLabel(t, status)
 * from labels.ts — here is only what does not depend on the language.
 *
 * `tone` is a CSS variable name without the prefix: the class is built as `text-[var(--st-todo)]`.
 * Tailwind cannot assemble such classes dynamically, so below they are written out
 * as whole strings — otherwise they simply would not end up in the build.
 */
export interface StatusMeta {
  icon: LucideIcon;
  /** Text/icon color. */
  fg: string;
  /** Holder stripe on the left of the card. */
  rail: string;
  /** Badge background. */
  chip: string;
  /** Marker dot. */
  dot: string;
}

export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  backlog: {
    icon: Inbox,
    fg: "text-[var(--st-backlog)]",
    rail: "bg-[var(--st-backlog)]",
    chip: "bg-[color-mix(in_oklab,var(--st-backlog)_16%,transparent)] text-[var(--st-backlog)]",
    dot: "bg-[var(--st-backlog)]",
  },
  todo: {
    icon: CircleDashed,
    fg: "text-[var(--st-todo)]",
    rail: "bg-[var(--st-todo)]",
    chip: "bg-[color-mix(in_oklab,var(--st-todo)_16%,transparent)] text-[var(--st-todo)]",
    dot: "bg-[var(--st-todo)]",
  },
  in_progress: {
    icon: Loader,
    fg: "text-[var(--st-progress)]",
    rail: "bg-[var(--st-progress)]",
    chip: "bg-[color-mix(in_oklab,var(--st-progress)_16%,transparent)] text-[var(--st-progress)]",
    dot: "bg-[var(--st-progress)]",
  },
  verifying: {
    icon: ShieldCheck,
    fg: "text-[var(--st-verifying)]",
    rail: "bg-[var(--st-verifying)]",
    chip: "bg-[color-mix(in_oklab,var(--st-verifying)_16%,transparent)] text-[var(--st-verifying)]",
    dot: "bg-[var(--st-verifying)]",
  },
  merging: {
    icon: GitMerge,
    fg: "text-[var(--st-merging)]",
    rail: "bg-[var(--st-merging)]",
    chip: "bg-[color-mix(in_oklab,var(--st-merging)_16%,transparent)] text-[var(--st-merging)]",
    dot: "bg-[var(--st-merging)]",
  },
  done: {
    icon: CheckCircle2,
    fg: "text-[var(--st-done)]",
    rail: "bg-[var(--st-done)]",
    chip: "bg-[color-mix(in_oklab,var(--st-done)_16%,transparent)] text-[var(--st-done)]",
    dot: "bg-[var(--st-done)]",
  },
  failed: {
    icon: XCircle,
    fg: "text-[var(--st-failed)]",
    rail: "bg-[var(--st-failed)]",
    chip: "bg-[color-mix(in_oklab,var(--st-failed)_16%,transparent)] text-[var(--st-failed)]",
    dot: "bg-[var(--st-failed)]",
  },
};

/** Blocks: "waiting for an answer" is the only magenta in the interface, a direct call for a human. */
export const BLOCKER_META: Record<NonNullable<Blocker>, { icon: LucideIcon; fg: string; chip: string; dot: string }> = {
  needs_input: {
    icon: Hand,
    fg: "text-[var(--st-blocked)]",
    chip: "bg-[color-mix(in_oklab,var(--st-blocked)_16%,transparent)] text-[var(--st-blocked)]",
    dot: "bg-[var(--st-blocked)]",
  },
  conflict: {
    icon: AlertTriangle,
    fg: "text-[var(--warn)]",
    chip: "bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]",
    dot: "bg-[var(--warn)]",
  },
  dirty_copy: {
    icon: AlertTriangle,
    fg: "text-[var(--warn)]",
    chip: "bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]",
    dot: "bg-[var(--warn)]",
  },
  quota: {
    icon: AlertTriangle,
    fg: "text-[var(--warn)]",
    chip: "bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]",
    dot: "bg-[var(--warn)]",
  },
  untrusted: {
    icon: ShieldCheck,
    fg: "text-[var(--warn)]",
    chip: "bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]",
    dot: "bg-[var(--warn)]",
  },
  // Asleep until a wakeup the agent asked for: no session and no worker slot, nothing for a human to do yet
  sleeping: {
    icon: Moon,
    fg: "text-[var(--ink-muted)]",
    chip: "bg-[var(--sunken)] text-[var(--ink-muted)]",
    dot: "bg-[var(--ink-faint)]",
  },
};

/**
 * Message delivery to a live session is an axis separate from task status, so
 * it gets no color of its own from the status wheel: normal delivery uses a neutral
 * badge, and only "not picked up" rises to a warning — there a human may
 * be needed to interrupt the session.
 */
export const OUTBOX_TONE: Record<NonNullable<Task["outbox_state"]>, string> = {
  queued: "bg-[var(--sunken)] text-[var(--ink-muted)]",
  sent: "bg-[var(--sunken)] text-[var(--ink-muted)]",
  stopping: "bg-[var(--sunken)] text-[var(--ink-muted)]",
  stalled: "bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]",
};

/**
 * A task "needs attention" if it will not move on without a human:
 * failed, waiting for an answer, or ran into a conflict / dirty worktree.
 * Quota and sleep are not about a human: the dispatcher returns to them itself.
 */
/**
 * Whether the task has a statement. Only the description goes into the agent prompt (orc/prompt.py),
 * the title stays in the dashboard — so an empty description means a session without an assignment,
 * and we do not send such a card to work by drag-and-drop or by button.
 */
export function hasDescription(task: Pick<Task, "description">): boolean {
  return task.description.trim() !== "";
}

/** The agent (or the dispatcher on its behalf) is busy with the card right now: work, check or merge.
 * A sleeping card is in progress but has no session until its wakeup. */
export function isRunning(task: Task): boolean {
  return (task.status === "in_progress" && task.blocker !== "sleeping") || task.status === "verifying" || task.status === "merging";
}

/** In work on the board, but asleep until a wakeup: no session, so not "running", yet not idle either. */
export function isAsleep(task: Task): boolean {
  return task.status === "in_progress" && task.blocker === "sleeping";
}

/** A card waiting for a human decision. A failed card is deliberately not here: it already sits in
 * the Done column with a red status, and repeating it in the attention strip only nagged. */
export function needsAttention(task: Task): boolean {
  if (task.status === "failed") return false;
  return task.blocker !== null && task.blocker !== "quota" && task.blocker !== "sleeping";
}

/** What keeps a card out of work: nobody to run it, or nothing to tell them. The server refuses the same.
 * A routine's run needs no agent: it carries the routine's own parameters. */
export type WorkIssue = "assignee" | "description";

export function workIssues(task: Pick<Task, "agent_id" | "description" | "routine_id">): WorkIssue[] {
  return [...(task.agent_id || task.routine_id ? [] : (["assignee"] as const)), ...(hasDescription(task) ? [] : (["description"] as const))];
}
