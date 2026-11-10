import { agentsForProject, useAgents } from "../agents";
import { Field, Select } from "../ui/Field";
import { useTranslation } from "../i18n";

interface Props {
  projectId: number | null;
  value: number | null;
  onChange: (value: number | null) => void;
  label?: string;
  /** Label of the empty option. */
  noneLabel?: string;
  hint?: string;
  className?: string;
}

/**
 * Who the work is allocated to. The list holds the shared agents and those internal to the project;
 * a stored value outside it (the agent was moved to another project) stays visible rather than
 * being silently replaced.
 */
export function AgentPicker({ projectId, value, onChange, label, noneLabel, hint, className }: Props) {
  const { t } = useTranslation();
  const agents = useAgents();
  const options = agentsForProject(agents, projectId);
  const stray = value !== null && !options.some((a) => a.id === value) ? agents.find((a) => a.id === value) : undefined;
  const fieldLabel = label ?? t("agents.picker.label");
  return (
    <Field label={fieldLabel} hint={hint} className={className}>
      <Select
        aria-label={fieldLabel}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">{noneLabel ?? t("agents.picker.none")}</option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.description ? ` — ${a.description}` : ""}
          </option>
        ))}
        {stray && <option value={stray.id}>{stray.name}</option>}
      </Select>
    </Field>
  );
}
