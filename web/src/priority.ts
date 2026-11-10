import { ChevronsUp, Equal, ChevronDown, type LucideIcon } from "lucide-react";
import type { Priority } from "./types";

/**
 * Priority is read by color and shape before the word: red chevrons pointing up need no reading. Every
 * place that shows a priority takes it from here, so adding a level is one row.
 */
export const PRIORITY_META: Record<Priority, { icon: LucideIcon; fg: string }> = {
  high: { icon: ChevronsUp, fg: "text-[var(--danger)]" },
  normal: { icon: Equal, fg: "text-[var(--st-todo)]" },
  low: { icon: ChevronDown, fg: "text-[var(--ink-faint)]" },
};

/** Highest first: the order of the picker. */
export const PRIORITIES: Priority[] = ["high", "normal", "low"];

/** The labels are lower case, for use inside a phrase on the board. Alone in a list they read as a name. */
export const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
