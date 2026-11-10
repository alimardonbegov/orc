import { createContext, useContext } from "react";
import type { Agent, Priority, Project } from "./types";
import { agentsForProject } from "./agents";
import type { QuickAction } from "./quickActions";

/**
 * What a task card shows and what a new card starts with, set for all of orc and overridable per
 * project (orc/card_settings.py). The server stores the choice; the properties themselves are in
 * components/cardProperties/registry.tsx.
 */
export interface CardSettings {
  /** Ids of properties taken out of the form and the card. */
  hidden?: string[];
  default_agent_id?: number | null;
  default_priority?: Priority;
  /** Canned messages for the agent. Absent: the built-in set (quickActions.ts); a project that holds it replaces the list. */
  quick_actions?: QuickAction[];
}

/** App reads the orc settings with a single poll and hands them down, like the hidden models. */
export const AppCardSettingsContext = createContext<CardSettings>({});

export const useAppCardSettings = () => useContext(AppCardSettingsContext);

/** settings.card_settings is a JSON string; a broken one reads as nothing set. */
export function parseCardSettings(raw: string | null | undefined): CardSettings {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as CardSettings) : {};
  } catch {
    return {};
  }
}

/** A project overrides key by key: what it does not hold follows orc. */
export function effectiveCardSettings(project: Pick<Project, "card_settings"> | null | undefined, app: CardSettings): CardSettings {
  return { ...app, ...(project?.card_settings ?? {}) };
}

/** The agent a new card starts with. A stored choice that no longer fits this project counts as none. */
export function defaultAgentId(settings: CardSettings, agents: readonly Agent[], projectId: number): number | null {
  const id = settings.default_agent_id ?? null;
  return id !== null && agentsForProject(agents, projectId).some((agent) => agent.id === id) ? id : null;
}

/** What goes to the server: an action the owner added but left without a title or a text is dropped, the server refuses it. */
export function cleanCardSettings<T extends CardSettings | null>(settings: T): T {
  if (!settings?.quick_actions) return settings;
  const quick_actions = settings.quick_actions
    .map((a) => ({ id: a.id, title: a.title.trim(), prompt: a.prompt.trim() }))
    .filter((a) => a.title && a.prompt);
  return { ...settings, quick_actions };
}
