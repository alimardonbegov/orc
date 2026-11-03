import { useState } from "react";
import { getModelOptions, isKnownModel } from "../models";
import { Field, Input, Select } from "../ui/Field";
import { useTranslation } from "../i18n";

interface Props {
  /** null means no model is set, the default value applies (see defaultLabel). */
  value: string | null;
  /** Called with an already "committed" value: immediately on selection from the list and on
   * blur/Enter in manual input. */
  onChange: (value: string | null) => void;
  /** Label of the empty option: what is substituted if no model is chosen. */
  defaultLabel: string;
  /** Hint under the field while nothing is selected: what the empty value turns into. */
  defaultHint?: string;
  /** Field label; "Model" by default. */
  label?: string;
  /** Models hidden from the list (see effectiveHiddenModels). An already selected one stays
   * visible. */
  hidden?: readonly string[];
  className?: string;
}

// Value of the "enter manually" option: it cannot coincide with a real model id.
const CUSTOM = "__custom__";

/**
 * Claude model selection: a dropdown with current models instead of manual input. One control for
 * project settings and for task parameters: the list of models must be the same in both places (see
 * MODEL_OPTIONS). Surplus models are hidden in orc or project settings (the hidden prop) and
 * brought back from the same place. Manual input is kept as an escape hatch: models are released
 * more often than the list is updated, and a value saved earlier by hand must not be silently lost.
 */
export function ModelPicker({ value, onChange, defaultLabel, defaultHint, label, hidden = [], className }: Props) {
  const { t } = useTranslation();
  const all = getModelOptions(t);
  // A hidden model that is already selected stays in the list: otherwise the select could not show
  // it, and a task with a hidden model would silently look like "default".
  const options = all.filter((m) => !hidden.includes(m.id) || m.id === value);
  const fieldLabel = label ?? t("modelPicker.label");
  // An unknown value (typed by hand or saved by an old UI version) switches the control to manual
  // mode: otherwise the select could not show it and would wipe it on the very first render.
  const [custom, setCustom] = useState(() => value !== null && !isKnownModel(value));
  const [draft, setDraft] = useState(value ?? "");

  const commit = () => onChange(draft.trim() || null);

  function pick(next: string) {
    if (next === CUSTOM) {
      // Switching to manual mode saves nothing: the field keeps the previous value as a starting
      // point.
      setCustom(true);
      setDraft(value ?? "");
      return;
    }
    setCustom(false);
    setDraft(next);
    onChange(next || null);
  }

  // An empty value is not "nothing": the hint must explain the inherited choice, otherwise the
  // space under the field is empty exactly when there are the most questions.
  const hint = custom ? undefined : value === null ? defaultHint : all.find((m) => m.id === value)?.hint;

  return (
    <Field label={fieldLabel} hint={hint} className={className}>
      <Select aria-label={fieldLabel} value={custom ? CUSTOM : (value ?? "")} onChange={(e) => pick(e.target.value)}>
        <option value="">{defaultLabel}</option>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {hidden.includes(m.id) ? t("modelPicker.hiddenOption", { label: m.label }) : m.label}
          </option>
        ))}
        <option value={CUSTOM}>{t("modelPicker.custom")}</option>
      </Select>
      {custom && (
        <Input
          className="mt-1 font-mono"
          placeholder="claude-…"
          aria-label={t("modelPicker.customAriaLabel", { label: fieldLabel })}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          // Enter inside a form would submit it with the old value: first we commit the input.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
      )}
    </Field>
  );
}
