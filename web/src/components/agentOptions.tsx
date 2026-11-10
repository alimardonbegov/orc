import type { Agent, Project } from "../types";
import type { PickerOption } from "../ui/Picker";
import { AgentAvatar } from "./AgentAvatar";

/** Shared agents first, then those internal to a project: the second line says which. */
export function agentOptions(agents: readonly Agent[], projects: readonly Project[], internalLabel: (project: string) => string): PickerOption<number>[] {
  const projectName = (id: number | null) => projects.find((p) => p.id === id)?.name ?? "";
  const option = (a: Agent): PickerOption<number> => ({
    value: a.id,
    label: a.name,
    hint: a.description.trim() || (a.project_id !== null ? internalLabel(projectName(a.project_id)) : undefined),
    leading: <AgentAvatar agent={a} size={24} />,
  });
  return [...agents.filter((a) => a.project_id === null), ...agents.filter((a) => a.project_id !== null)].map(option);
}
