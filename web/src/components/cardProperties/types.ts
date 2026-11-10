import type { LucideIcon } from "lucide-react";
import type { Priority, Project, Task, TaskStatus } from "../../types";

/** What the properties of a card edit: the part of a task they are allowed to change. */
export interface CardPropertyValues {
  agent_id: number | null;
  priority: Priority;
  target_branch: string | null;
  depends_on: number[];
  /** Label names: a card takes names, and a missing label is created by the server. */
  labels: string[];
  /** Planning days, `YYYY-MM-DD`. null means none. */
  start_date: string | null;
  due_date: string | null;
}

/** Everything a property's control may need. A new property adds to this rather than to its callers. */
export interface CardPropertyContext {
  values: CardPropertyValues;
  onChange: (patch: Partial<CardPropertyValues>) => void;
  variant: "pill" | "row";
  /** The value is shown but cannot be changed in the card's current status. */
  locked: boolean;
  /** Open the picker from outside: the "assign an agent" fix. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  projectId: number;
  projects?: Project[];
  /** Tasks of all projects: a blocker may live in another repository. */
  allTasks: Task[];
  /** The card itself, in the card: it cannot wait for itself. */
  taskId?: number;
  /** The card's status; none while a card is being created. A due date turns red when it passed on an open card. */
  status?: TaskStatus;
  branches: BranchesState;
  onOpenTask?: (id: number) => void;
}

export interface BranchesState {
  branches: string[];
  /** A branch was just created: the server answered with the fresh list. */
  setBranches: (branches: string[]) => void;
}

export interface CardPropertyDef {
  id: string;
  /** i18n key of the name. */
  label: string;
  icon: LucideIcon;
  /** Cannot be hidden in the settings: without it the card cannot do its job. */
  required?: boolean;
  /**
   * Shown only when it holds a value, or when it was added from the "+ Add property" menu (as in multica).
   * A hidden one is not offered there at all.
   */
  optional?: boolean;
  /**
   * Only a pill in the creation form. In the card the property lives elsewhere: what a card waits for is shown and
   * edited in its Relations section, next to what comes after it.
   */
  formOnly?: boolean;
  /** Statuses in which it can be changed; omitted means always. */
  editableIn?: readonly TaskStatus[];
  /** Holds something other than the default: a hidden property with a value stays on the card. */
  isSet: (values: CardPropertyValues) => boolean;
  Control: (context: CardPropertyContext) => React.ReactNode;
}
