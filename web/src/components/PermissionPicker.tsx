import { getPermissionOptions, permissionHint, permissionOptionLabel } from "../permissions";
import type { PermissionMode } from "../types";
import { Field, Select } from "../ui/Field";
import { useTranslation } from "../i18n";

interface Props {
  /** null means the mode is not set, the project value applies (see defaultLabel). */
  value: PermissionMode | null;
  onChange: (value: PermissionMode | null) => void;
  /**
   * Label of the empty option: what is substituted if no mode is chosen. Not set means there is no
   * empty option: in project settings a mode is always present.
   */
  defaultLabel?: string;
  /** Hint under the field while nothing is selected: what the empty value turns into. */
  defaultHint?: string;
  label?: string;
  className?: string;
}

/**
 * Permission mode selection: one control for project settings and for task parameters; the list and
 * wording must be the same in both places. The list row shows the mode name from the CLI, and what
 * it means is given by a short note beside it and the full hint under the field (see
 * permissions.ts).
 */
export function PermissionPicker({ value, onChange, defaultLabel, defaultHint, label, className }: Props) {
  const { t } = useTranslation();
  const fieldLabel = label ?? t("permissionPicker.label");
  const hint = value === null ? defaultHint : permissionHint(t, value);

  return (
    <Field label={fieldLabel} hint={hint} className={className}>
      <Select
        aria-label={fieldLabel}
        value={value ?? ""}
        onChange={(e) => onChange((e.target.value || null) as PermissionMode | null)}
      >
        {defaultLabel !== undefined && <option value="">{defaultLabel}</option>}
        {getPermissionOptions(t).map((p) => (
          <option key={p.id} value={p.id}>
            {permissionOptionLabel(p)}
          </option>
        ))}
      </Select>
    </Field>
  );
}
