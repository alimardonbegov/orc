import type { TFunction } from "./i18n";

/**
 * A single list of effort levels (`claude --effort <id>`) for the project and task dropdowns.
 * The list is closed and changes together with the CLI, so — unlike models (see models.ts) —
 * there is no manual input here.
 * Order = order in the list: from lower effort to higher.
 */
export interface EffortOption {
  id: string;
  /** Short hint in the interface: when to pick this level. */
  hint: string;
}

const EFFORT_IDS = ["low", "medium", "high", "xhigh", "max"] as const;

export function getEffortOptions(t: TFunction): EffortOption[] {
  return EFFORT_IDS.map((id) => ({ id, hint: t(`effort.${id}`) }));
}

export const isKnownEffort = (id: string) => (EFFORT_IDS as readonly string[]).includes(id);
