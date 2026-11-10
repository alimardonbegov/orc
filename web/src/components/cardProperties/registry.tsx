import { Bot, CalendarCheck, CalendarClock, Flag, GitBranch, Hourglass, Tag } from "lucide-react";
import type { CardSettings } from "../../cardSettings";
import type { TaskStatus } from "../../types";
import { AgentProperty } from "./AgentProperty";
import { BranchProperty } from "./BranchProperty";
import { DependsOnProperty } from "./DependsOnProperty";
import { DueDateProperty, StartDateProperty } from "./DateProperty";
import { LabelsProperty } from "./LabelsProperty";
import { PriorityProperty } from "./PriorityProperty";
import type { CardPropertyDef, CardPropertyValues } from "./types";

// A session already got its assignment, its base and its place in the queue: changing them now would
// show one thing and do another. The same list as TARGET_BRANCH_EDITABLE in orc/api/common.py.
const BEFORE_WORK: readonly TaskStatus[] = ["backlog", "todo", "failed"];

/**
 * Every property of a task card, in display order. The creation form, the card and the settings all
 * read this list, so a new property is one entry here plus its control. Whether a property is shown is
 * a setting (orc/card_settings.py), and the server does not need to know the list.
 */
export const CARD_PROPERTIES: CardPropertyDef[] = [
  {
    id: "agent",
    label: "card.agent.label",
    icon: Bot,
    required: true,
    editableIn: BEFORE_WORK,
    isSet: (v) => v.agent_id !== null,
    Control: AgentProperty,
  },
  {
    id: "priority",
    label: "card.priority.label",
    icon: Flag,
    editableIn: BEFORE_WORK,
    isSet: (v) => v.priority !== "normal",
    Control: PriorityProperty,
  },
  {
    id: "branch",
    label: "card.branch.label",
    icon: GitBranch,
    editableIn: BEFORE_WORK,
    // A base is always set, so it says nothing about whether someone chose it
    isSet: () => false,
    Control: BranchProperty,
  },
  {
    id: "depends_on",
    label: "card.dependsOn.label",
    icon: Hourglass,
    editableIn: BEFORE_WORK,
    formOnly: true,
    isSet: (v) => v.depends_on.length > 0,
    Control: DependsOnProperty,
  },
  // Planning. Editable in every status: they describe the plan, not the session's assignment.
  {
    id: "labels",
    label: "card.labels.label",
    icon: Tag,
    optional: true,
    isSet: (v) => v.labels.length > 0,
    Control: LabelsProperty,
  },
  {
    id: "start_date",
    label: "card.startDate.label",
    icon: CalendarClock,
    optional: true,
    isSet: (v) => v.start_date !== null,
    Control: StartDateProperty,
  },
  {
    id: "due_date",
    label: "card.dueDate.label",
    icon: CalendarCheck,
    optional: true,
    isSet: (v) => v.due_date !== null,
    Control: DueDateProperty,
  },
];

/**
 * What the card shows. A required property always; one that is not hidden in the settings; whatever holds a
 * value, which must never be invisible. An optional property shows only once it holds a value or was added from the menu,
 * and the settings can still keep it out of the menu altogether.
 */
export function visibleProperties(
  settings: CardSettings,
  values: CardPropertyValues,
  properties: CardPropertyDef[] = CARD_PROPERTIES,
  added: readonly string[] = [],
): CardPropertyDef[] {
  const hidden = new Set(settings.hidden ?? []);
  return properties.filter((p) => {
    if (p.required || p.isSet(values)) return true;
    if (hidden.has(p.id)) return false;
    return !p.optional || added.includes(p.id);
  });
}

/** What the "+ Add property" menu offers: optional, not hidden in the settings, not on the card yet. */
export function addableProperties(
  settings: CardSettings,
  values: CardPropertyValues,
  properties: CardPropertyDef[] = CARD_PROPERTIES,
  added: readonly string[] = [],
): CardPropertyDef[] {
  const hidden = new Set(settings.hidden ?? []);
  const shown = new Set(visibleProperties(settings, values, properties, added).map((p) => p.id));
  return properties.filter((p) => p.optional && !hidden.has(p.id) && !shown.has(p.id));
}

export function isLocked(property: CardPropertyDef, status: TaskStatus): boolean {
  return property.editableIn !== undefined && !property.editableIn.includes(status);
}
