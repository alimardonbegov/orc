import { useCallback, useState } from "react";
import type { TFunction } from "./i18n";
import type { Agent, Chat, Project } from "./types";
import { chatProjectOf } from "./agents";

/** A chat in one of these states is busy: the agent has a turn in progress or is stuck inside it. */
export const ACTIVE = new Set(["queued", "running", "waiting"]);

/** The key of the chat that does not exist yet: one slot for the text of the next new chat. */
export const NEW_CHAT = "new";
export type DraftKey = number | typeof NEW_CHAT;

/** Unsent text per chat. The window can be minimized mid-sentence, and the sentence must still be there. */
const drafts = new Map<DraftKey, string>();

/** For tests: drafts live outside React, so they outlive a rendered tree. */
export const clearChatDrafts = () => drafts.clear();

/** Put text into the draft of a chat from outside a component (a send that failed after the chat was made). */
export const stashChatDraft = (key: DraftKey, value: string) => {
  if (value) drafts.set(key, value);
  else drafts.delete(key);
};

export function useChatDraft(key: DraftKey): [string, (value: string) => void] {
  const [text, setTextState] = useState(() => drafts.get(key) ?? "");
  const setText = useCallback(
    (value: string) => {
      stashChatDraft(key, value);
      setTextState(value);
    },
    [key],
  );
  return [text, setText];
}

/** A chat that has not been created yet: the server learns of it with the first message. */
export interface ChatDraft {
  agentId: number;
  projectId: number | null;
  /** The chat that was selected when the draft was made: a selection from outside makes the draft stale. */
  since: number | null;
}

/** The draft for this agent: an internal agent talks about its own project, a lead about the one it leads. */
export function draftFor(agent: Agent, projects: readonly Project[], since: number | null, keepProject: number | null = null): ChatDraft {
  return { agentId: agent.id, projectId: agent.project_id ?? keepProject ?? chatProjectOf(agent, projects), since };
}

/** Who a new chat is with when the owner has not chosen yet: the agent of the latest chat, else the first one. */
export function defaultAgent(agents: readonly Agent[], chats: readonly Chat[]): Agent | null {
  for (const chat of chats) {
    const agent = agents.find((a) => a.id === chat.agent_id);
    if (agent) return agent;
  }
  return agents[0] ?? null;
}

export interface Starter {
  key: string;
  label: string;
  prompt: string;
}

/** What to offer in an empty chat. A chat about a project can look at it; one without can only think along. */
export function startersFor(t: TFunction, hasProject: boolean): Starter[] {
  const keys = hasProject ? ["capabilities", "overview", "tasks"] : ["capabilities", "plan", "decide"];
  return keys.map((key) => ({ key, label: t(`chats.starters.${key}.label`), prompt: t(`chats.starters.${key}.prompt`) }));
}

const PINNED_KEY = "orc.chat.pinnedAgents";
/** The bar stays a strip of faces, not a second list. */
export const MAX_PINNED = 5;

function readPinned(): number[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id): id is number => Number.isInteger(id)).slice(0, MAX_PINNED) : [];
  } catch {
    return [];
  }
}

/** Agents the owner talks to most, kept in this browser: a chat with them is one click away. */
export function usePinnedAgents(): { ids: number[]; pin: (id: number) => void; unpin: (id: number) => void } {
  const [ids, setIds] = useState<number[]>(readPinned);
  const save = (next: number[]) => {
    setIds(next);
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify(next));
    } catch {
      // Private mode: the bar still works until the page is closed
    }
  };
  return {
    ids,
    pin: (id) => save(ids.includes(id) || ids.length >= MAX_PINNED ? ids : [...ids, id]),
    unpin: (id) => save(ids.filter((x) => x !== id)),
  };
}

/** The mobile keyboard pops up on focus: the composer takes the focus on its own only where there is a pointer. */
export const canAutoFocus = () => typeof window === "undefined" || !window.matchMedia?.("(pointer: coarse)").matches;
