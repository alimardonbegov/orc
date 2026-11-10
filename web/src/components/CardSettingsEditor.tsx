import type { CardSettings } from "../cardSettings";
import { agentsForProject, useAgents } from "../agents";
import { priorityLabel } from "../labels";
import { PRIORITIES, capitalized } from "../priority";
import type { Priority } from "../types";
import { Checkbox, Field, Select } from "../ui/Field";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";
import { CARD_PROPERTIES } from "./cardProperties/registry";
import { QuickActionsEditor } from "./QuickActionsEditor";

interface Props {
  value: CardSettings;
  onChange: (next: CardSettings) => void;
  /** The project these settings are for. null means all of orc, where only shared agents fit. */
  projectId: number | null;
  disabled?: boolean;
}

/**
 * What cards show and what a new card starts with. One control for the orc settings and for a project,
 * so that it reads the same in both. The list of properties comes from the registry: a property added
 * there appears here by itself.
 */
export function CardSettingsEditor({ value, onChange, projectId, disabled }: Props) {
  const { t } = useTranslation();
  const agents = agentsForProject(useAgents(), projectId);
  const hidden = new Set(value.hidden ?? []);
  const agentId = value.default_agent_id ?? null;
  const known = agentId === null || agents.some((a) => a.id === agentId);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("card.settings.defaultAgent")} hint={t("card.settings.defaultAgentHint")}>
          <Select
            aria-label={t("card.settings.defaultAgent")}
            disabled={disabled}
            value={agentId ?? ""}
            onChange={(e) => onChange({ ...value, default_agent_id: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">{t("card.agent.none")}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
            {!known && <option value={agentId}>{t("card.settings.staleAgent", { id: agentId })}</option>}
          </Select>
        </Field>
        <Field label={t("card.settings.defaultPriority")}>
          <Select
            aria-label={t("card.settings.defaultPriority")}
            disabled={disabled}
            value={value.default_priority ?? "normal"}
            onChange={(e) => onChange({ ...value, default_priority: e.target.value as Priority })}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {capitalized(priorityLabel(t, p))}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t("card.settings.properties")} hint={t("card.settings.propertiesHint")}>
        <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
          {CARD_PROPERTIES.map((p) => (
            <label
              key={p.id}
              className={cn(
                "flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-[12px] text-[var(--ink)]",
                p.required || disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]",
              )}
            >
              <Checkbox
                aria-label={t(p.label)}
                checked={p.required || !hidden.has(p.id)}
                disabled={p.required || disabled}
                onChange={(e) =>
                  onChange({ ...value, hidden: e.target.checked ? [...hidden].filter((id) => id !== p.id) : [...hidden, p.id] })
                }
              />
              <p.icon size={13} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
              {t(p.label)}
            </label>
          ))}
        </div>
      </Field>
      <QuickActionsEditor value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}
