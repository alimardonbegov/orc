import { modelLabel } from "./models";
import { permissionLabel } from "./permissions";
import type { TFunction } from "./i18n";
import type { Agent, Project } from "./types";

/**
 * Run parameters belong to the agent, not to the card: an empty field of an agent is not "nothing",
 * but a concrete project setting (see orc/agents.py: `agent value or project default`). The empty option
 * shows that value, and the suffix explains where it came from. The value is not written into the agent,
 * so it keeps following the project setting if it changes.
 */

/**
 * Since empty fields show a value, the main thing must be said: it is not pinned
 * to the task. Otherwise "Opus 5 — from project" reads like a frozen choice.
 * One string for the whole block: under each field it would be the same text three times.
 */
export const inheritNote = (t: TFunction): string => t("runParams.inheritNote");

/**
 * Label of the empty option: the value comes first, and "from project" explains where it is from.
 * The suffix is short on purpose — the fields sit in three columns, and a long tail gets cut off
 * exactly where the value itself is written.
 *
 * value — the already human-readable label of the inherited value
 * or null if the project does not set the parameter either (then Claude Code decides).
 * known=false — the project is unknown to the calling code, so we must not lie about the value.
 */
function inherited(t: TFunction, value: string | null, known: boolean): string {
  if (!known) return t("runParams.fromProject");
  return value ? t("runParams.valueFromProject", { value }) : t("runParams.decidesItself");
}

/**
 * Returns only the label of the empty option, without an explanation of the project value:
 * in the task form the parameters are always open, and a hint under each inherited
 * field would bloat the block exactly when the person has chosen nothing.
 * The pickers show the explanation of the value themselves — when it was chosen by hand.
 */
export const inheritedModel = (t: TFunction, project?: Project | null, agent?: Agent | null): string =>
  agent?.model
    ? t("runParams.valueFromAgent", { value: modelLabel(agent.model) })
    : inherited(t, project?.default_model ? modelLabel(project.default_model) : null, !!project);

export const inheritedEffort = (t: TFunction, project?: Project | null, agent?: Agent | null): string =>
  agent?.effort ? t("runParams.valueFromAgent", { value: agent.effort }) : inherited(t, project?.default_effort ?? null, !!project);

/** For the permission mode the project default is always set, there is no "as Claude Code decides" option. */
export const inheritedPermission = (t: TFunction, project?: Project | null, agent?: Agent | null): string => {
  if (agent?.permission_mode) return t("runParams.valueFromAgent", { value: permissionLabel(agent.permission_mode) });
  return project ? t("runParams.valueFromProject", { value: permissionLabel(project.default_permission_mode) }) : t("runParams.fromProject");
};

/** The verify command is a free-form string, so we show it as a placeholder. */
export const inheritedVerifyCmd = (t: TFunction, project?: Project | null): string => {
  if (!project) return t("runParams.fromProject");
  return project.verify_cmd ? t("runParams.valueFromProject", { value: project.verify_cmd }) : t("runParams.verifyNotSet");
};
