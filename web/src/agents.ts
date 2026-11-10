import { createContext, useContext } from "react";
import type { Agent, Project } from "./types";

/**
 * All agents, read by App with a single poll and handed to forms and cards via context: otherwise
 * the list would have to be threaded through props down to every card on the board.
 */
export const AgentsContext = createContext<readonly Agent[]>([]);

export const useAgents = () => useContext(AgentsContext);

/** Leave for the Agents page. null where the app has not wired it, as in a window rendered alone. */
export const ManageAgentsContext = createContext<(() => void) | null>(null);

export const useManageAgents = () => useContext(ManageAgentsContext);

/** Agents a task of this project may be allocated to: its own and the shared ones (the server checks the same). */
export function agentsForProject(agents: readonly Agent[], projectId: number | null | undefined): Agent[] {
  return agents.filter((a) => a.project_id === null || a.project_id === projectId);
}

/**
 * The project a chat opened from the agent's card is about: its own, or the only one it leads, since a
 * lead only sees the board in a chat about that project. Leading several leaves the choice to the
 * project's own chat button.
 */
export function chatProjectOf(agent: Agent, projects: readonly Project[]): number | null {
  if (agent.project_id !== null) return agent.project_id;
  const led = projects.filter((p) => !p.archived_at && p.path_ok && p.lead_agent_id === agent.id);
  return led.length === 1 ? led[0].id : null;
}

/** The agent's color: stable across renders and sessions, so an agent is recognized by it on the board. */
export function agentHue(id: number): number {
  return (id * 137) % 360;
}

export const isAvatarImage = (avatar: string | null | undefined): avatar is string => !!avatar && avatar.startsWith("data:");

const AVATAR_SIZE = 128;
/** What the server accepts (orc/api/agents.py); the resized picture is always far below it. */
const AVATAR_MAX_CHARS = 200_000;

/**
 * A picture file → a small square data URL. The picture lives in the agent's row and comes with the
 * list on every poll, so a photo from a phone must not arrive as it is. SVG is not offered: as a
 * document it may carry scripts, and the server refuses it anyway.
 */
export async function avatarFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas is unavailable");
  // Cut the center square: stretching a face into a square is worse than losing the edges
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();
  const url = canvas.toDataURL("image/webp", 0.85);
  if (url.length > AVATAR_MAX_CHARS) throw new Error("the picture is too large");
  return url;
}
