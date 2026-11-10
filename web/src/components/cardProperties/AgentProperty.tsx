import { useMemo } from "react";
import { UserRound } from "lucide-react";
import { agentsForProject, useAgents, useManageAgents } from "../../agents";
import { Button } from "../../ui/Button";
import { Picker, PickerTrigger, type PickerOption } from "../../ui/Picker";
import { useTranslation } from "../../i18n";
import { AgentAvatar } from "../AgentAvatar";
import type { CardPropertyContext } from "./types";

/** The face of "nobody": a card without an agent belongs to a person. */
export function PersonAvatar({ size = 18 }: { size?: number }) {
  return (
    <span aria-hidden style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-full bg-[var(--sunken)] text-[var(--ink-faint)]">
      <UserRound size={Math.round(size * 0.62)} />
    </span>
  );
}

/** Who the card is assigned to. The list holds the shared agents and those internal to the project. */
export function AgentProperty({ values, onChange, variant, locked, open, onOpenChange, projectId }: CardPropertyContext) {
  const { t } = useTranslation();
  const agents = useAgents();
  const manage = useManageAgents();
  const current = agents.find((a) => a.id === values.agent_id) ?? null;
  const options = useMemo<PickerOption<number | null>[]>(() => {
    const own = agentsForProject(agents, projectId);
    // An agent moved to another project stays visible rather than being silently replaced
    const stray = current && !own.includes(current) ? [current] : [];
    return [
      { value: null, label: t("card.agent.none"), hint: t("card.agent.noneHint"), leading: <PersonAvatar size={22} />, pinned: true },
      ...[...own, ...stray].map((a) => ({ value: a.id, label: a.name, hint: a.description || undefined, leading: <AgentAvatar agent={a} size={22} /> })),
    ];
  }, [agents, current, projectId, t]);
  const label = t("card.agent.label");
  const noAgents = agents.length === 0;
  const trigger = (
    <PickerTrigger variant={variant} locked={locked} aria-label={`${label}: ${current?.name ?? t("card.agent.none")}`} title={label}>
      {current ? <AgentAvatar agent={current} size={18} title="" /> : <PersonAvatar />}
      <span className={current ? "truncate" : "truncate text-[var(--ink-muted)]"}>{current?.name ?? t("card.agent.none")}</span>
    </PickerTrigger>
  );
  if (locked) return trigger;
  return (
    <Picker
      label={label}
      trigger={trigger}
      options={options}
      value={values.agent_id}
      onChange={(agent_id) => onChange({ agent_id })}
      searchable={options.length > 6}
      open={open}
      onOpenChange={onOpenChange}
      footer={
        noAgents ? (
          <div className="space-y-1.5 p-1.5">
            <p className="text-[11px] leading-snug text-[var(--ink-muted)]">{t("card.agent.noAgents")}</p>
            {manage && (
              <Button type="button" size="sm" onClick={manage}>
                {t("card.agent.create")}
              </Button>
            )}
          </div>
        ) : undefined
      }
    />
  );
}
