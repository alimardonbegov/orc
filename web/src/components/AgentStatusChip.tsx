import { useAgents } from "../agents";
import type { ActivityNow, ActivityPhase, Agent, Task } from "../types";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";
import { AgentAvatar } from "./AgentAvatar";
import { PersonAvatar } from "./cardProperties/AgentProperty";
import { phaseLabel, phaseTone } from "./ActivityPanel";

const BUSY: ActivityPhase[] = ["starting", "working", "delivering", "verifying", "merging"];

/**
 * What the card's agent is up to, as one phrase with a face, always in view at the top of the card.
 * A session has a phase of its own, and without a session the phrase follows from the card's status.
 */
export function agentState(task: Pick<Task, "status" | "agent_id">, now: Pick<ActivityNow, "phase"> | null): { phase: ActivityPhase | null; key: string | null } {
  if (now) return { phase: now.phase, key: null };
  if (task.status === "backlog") return { phase: null, key: task.agent_id ? "card.presence.assigned" : "card.presence.person" };
  if (task.status === "todo") return { phase: "todo", key: "card.presence.queued" };
  return { phase: task.status === "in_progress" ? "working" : task.status, key: null };
}

function Face({ agent, busy }: { agent: Agent | undefined; busy: boolean }) {
  return (
    <span className="relative shrink-0">
      {agent ? <AgentAvatar agent={agent} size={20} title="" /> : <PersonAvatar size={20} />}
      {busy && <span aria-hidden className="absolute -bottom-0.5 -right-0.5 h-2 w-2 animate-pulse rounded-full bg-[var(--st-progress)] ring-2 ring-[var(--surface)]" />}
    </span>
  );
}

export function AgentStatusChip({ task, now }: { task: Task; now: ActivityNow | null }) {
  const { t } = useTranslation();
  const agent = useAgents().find((a) => a.id === task.agent_id);
  const { phase, key } = agentState(task, now);
  const label = key ? t(key) : phase ? phaseLabel(t, phase) : "";
  // A card without an agent that runs anyway (a routine with its own parameters, an old card)
  const name = agent?.name ?? (phase && !key ? t("card.presence.noAgentName") : null);
  const busy = phase !== null && BUSY.includes(phase);
  return (
    <span
      role="status"
      data-testid="agent-status"
      title={agent?.description || undefined}
      className={cn(
        "flex max-w-64 items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-[12px]",
        (phase && phaseTone(phase)) ?? "bg-[var(--sunken)] text-[var(--ink-muted)]",
      )}
    >
      <Face agent={agent} busy={busy} />
      {name && <span className="truncate font-medium text-[var(--ink)]">{name}</span>}
      <span className="shrink-0">{label}</span>
    </span>
  );
}
