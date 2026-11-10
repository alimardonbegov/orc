import type { Agent, Chat, Task } from "./types";
import { isRunning } from "./status";

/** One agent and everything it is busy with right now. */
export interface WorkingAgent {
  agent: Agent;
  tasks: Task[];
  chats: Chat[];
}

/**
 * Agents that are working at this moment, with their cards and chats: the header chip aggregates this.
 * A card counts while the agent (or the dispatcher on its behalf) runs it; a chat counts while a turn
 * is queued or running. A chat that only waits for the person is not work and is left out.
 * Archived cards and chats of unknown agents are skipped. Agents keep the order of the agent list.
 */
export function workingAgents(agents: readonly Agent[], tasks: readonly Task[], chats: readonly Chat[]): WorkingAgent[] {
  const result: WorkingAgent[] = [];
  for (const agent of agents) {
    const own = tasks.filter((t) => t.agent_id === agent.id && !t.archived_at && isRunning(t));
    const talking = chats.filter((c) => c.agent_id === agent.id && !c.archived_at && (c.status === "running" || c.status === "queued"));
    if (own.length > 0 || talking.length > 0) result.push({ agent, tasks: own, chats: talking });
  }
  return result;
}
