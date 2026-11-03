import type { TFunction } from "./i18n";
import type { PermissionMode } from "./types";

/**
 * Claude Code permission modes. Names are as in claude itself (`claude --permission-mode <id>`,
 * the mode line in its interface): translated labels like "Edits without questions"
 * had to be mentally mapped to acceptEdits from the docs and logs.
 * The mode's meaning has not gone anywhere: a short explanation sits next to it in the list row,
 * the full one is a tooltip under the field. The explanation and tooltip are translated via t(),
 * the mode id itself is not (see permissionLabel).
 * The list is closed and matches PERMISSION_MODES in orc/api.py.
 */
export interface PermissionOption {
  id: PermissionMode;
  /** Short explanation next to the name, right in the list row. */
  gloss: string;
  /** Tooltip under the field: what the mode actually does. */
  hint: string;
}

const PERMISSION_MODE_IDS: PermissionMode[] = ["auto", "acceptEdits", "dontAsk", "bypassPermissions"];

export function getPermissionOptions(t: TFunction): PermissionOption[] {
  return PERMISSION_MODE_IDS.map((id) => ({
    id,
    gloss: t(`permissions.${id}.gloss`),
    hint: t(`permissions.${id}.hint`),
  }));
}

/** List row: the mode name from the CLI and a short explanation. */
export const permissionOptionLabel = (p: PermissionOption): string => `${p.id} — ${p.gloss}`;

/** Tooltip of the selected mode; for an unknown id — nothing. */
export const permissionHint = (t: TFunction, id?: PermissionMode | null): string | undefined =>
  getPermissionOptions(t).find((p) => p.id === id)?.hint;

/**
 * Label of a mode outside the list (summary, label of an inherited value) — the mode name itself.
 * The function remains the point where this decision is visible: there used to be a translation here.
 */
export const permissionLabel = (id: PermissionMode | string): string => id;
