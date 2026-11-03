import { getEffortOptions, isKnownEffort } from "../effort";
import { Field, Select } from "../ui/Field";
import { useTranslation } from "../i18n";

interface Props {
  /** null means effort is not set, the default value applies (see defaultLabel). */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Label of the empty option: what is substituted if no level is selected. */
  defaultLabel: string;
  /** Hint under the field while nothing is selected: what the empty value turns into. */
  defaultHint?: string;
  /** Field label; "Effort" by default. */
  label?: string;
  className?: string;
}

/**
 * Effort level selection: a dropdown with a fixed list (see EFFORT_OPTIONS). One control for
 * project settings and for task parameters: the list must be the same in both places. A value
 * outside the list (left over from the former free-input field) is added to the list as a separate
 * option: silently replacing a saved setting is not allowed.
 */
export function EffortPicker({ value, onChange, defaultLabel, defaultHint, label, className }: Props) {
  const { t } = useTranslation();
  const options = getEffortOptions(t);
  const fieldLabel = label ?? t("effortPicker.label");
  const legacy = value !== null && !isKnownEffort(value) ? value : null;
  const hint = value === null ? defaultHint : options.find((e) => e.id === value)?.hint;

  return (
    <Field label={fieldLabel} hint={hint} className={className}>
      <Select aria-label={fieldLabel} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{defaultLabel}</option>
        {options.map((e) => (
          <option key={e.id} value={e.id}>
            {e.id}
          </option>
        ))}
        {legacy && <option value={legacy}>{t("effortPicker.legacy", { value: legacy })}</option>}
      </Select>
    </Field>
  );
}
