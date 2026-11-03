import { modelLabel } from "./models";
import { permissionLabel } from "./permissions";
import type { TFunction } from "./i18n";
import type { PermissionMode, Project } from "./types";

/**
 * A task's run parameters are inherited from the project: an empty field is not "nothing",
 * but a concrete project setting (see dispatcher.py: `task.model or project.default_model`).
 *
 * The label "project default" did not show this: to find out which model
 * the task would run on, you had to open the project settings. So the empty option
 * shows the value itself, and the suffix explains where it came from.
 *
 * The value is not put into the field: the task stays null and keeps
 * following the project setting if it changes. Writing the value into the task
 * silently detaches it from the project, and it looks the same.
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
export const inheritedModel = (t: TFunction, project?: Project | null): string =>
  inherited(t, project?.default_model ? modelLabel(project.default_model) : null, !!project);

export const inheritedEffort = (t: TFunction, project?: Project | null): string =>
  inherited(t, project?.default_effort ?? null, !!project);

/** For the permission mode the project default is always set, there is no "as Claude Code decides" option. */
export const inheritedPermission = (t: TFunction, project?: Project | null): string =>
  project ? t("runParams.valueFromProject", { value: permissionLabel(project.default_permission_mode) }) : t("runParams.fromProject");

/** The verify command is a free-form string, so we show it as a placeholder. */
export const inheritedVerifyCmd = (t: TFunction, project?: Project | null): string => {
  if (!project) return t("runParams.fromProject");
  return project.verify_cmd ? t("runParams.valueFromProject", { value: project.verify_cmd }) : t("runParams.verifyNotSet");
};

interface TaskParams {
  model: string | null;
  effort: string | null;
  permission_mode: PermissionMode | null;
  verify_cmd: string | null;
}

/**
 * Whether the task has its own values instead of the project's. By this flag the block
 * shows "Restore project values": it is easy to accumulate overrides, but there is no other way to return a
 * field to inheritance — the empty option in the list is easy to miss.
 */
export function hasOwnRunParams(v: TaskParams): boolean {
  return v.model !== null || v.effort !== null || v.permission_mode !== null || v.verify_cmd !== null;
}
