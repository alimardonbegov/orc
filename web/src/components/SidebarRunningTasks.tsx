import { useState } from "react";
import type { Agent, Task } from "../types";
import { needsAttention } from "../status";
import { AgentAvatar } from "./AgentAvatar";
import { focusRing } from "../ui/tokens";
import { cn } from "../lib/cn";
import type { TFunction } from "../i18n";

/** How many running cards are listed under a project before "show all". */
export const RUNNING_PREVIEW = 3;

interface Props {
  /** Running cards of one project (the caller has already filtered them). */
  tasks: Task[];
  agents: readonly Agent[];
  /** Folded by the chevron in the project row; the choice is the sidebar's, so it survives a reload. */
  folded: boolean;
  onOpenTask: (taskId: number) => void;
  t: TFunction;
}

/**
 * Cards in work under their project in the sidebar: open a card without opening the project first.
 * A card leaves the list by itself when it stops running, so the list is the live picture of who
 * is doing what. Unfolded by default: the point is to see it without a click; the chevron in the
 * project row folds it.
 */
export function SidebarRunningTasks({ tasks, agents, folded, onOpenTask, t }: Props) {
  const [showAll, setShowAll] = useState(false);
  if (tasks.length === 0 || folded) return null;
  const visible = showAll || tasks.length <= RUNNING_PREVIEW ? tasks : tasks.slice(0, RUNNING_PREVIEW);

  return (
    <div className="pb-1 pl-3">
      <ul className="border-l border-[var(--line)] pl-1">
        {visible.map((task) => {
          const agent = agents.find((a) => a.id === task.agent_id);
          const waiting = needsAttention(task);
          return (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onOpenTask(task.id)}
                title={`#${task.id} ${task.title}${agent ? ` · ${agent.name}` : ""}`}
                className={cn(
                  "flex h-7 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 text-left text-[12px] text-[var(--ink-muted)] transition-colors duration-100",
                  "hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] hover:text-[var(--ink)]",
                  focusRing,
                )}
              >
                {/* Pulses while the agent works; a card that waits for a human holds still, in the call-for-attention color. */}
                <span
                  aria-hidden
                  data-testid="running-dot"
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", waiting ? "bg-[var(--st-blocked)]" : "animate-pulse bg-[var(--st-progress)]")}
                />
                <span className="tnum shrink-0 text-[11px] text-[var(--ink-faint)]">#{task.id}</span>
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                {agent && <AgentAvatar agent={agent} size={16} />}
              </button>
            </li>
          );
        })}
        {tasks.length > RUNNING_PREVIEW && (
          <li>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className={cn(
                "flex h-6 w-full items-center rounded-[var(--radius-sm)] px-1.5 text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink-muted)]",
                focusRing,
              )}
            >
              {showAll ? t("sidebar.runningFewer") : t("sidebar.runningAll", { count: tasks.length })}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
