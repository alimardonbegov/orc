import { Hourglass } from "lucide-react";
import { Badge } from "../../ui/Badge";
import { PickerPanel, PickerTrigger } from "../../ui/Picker";
import { useTranslation } from "../../i18n";
import { DependsOnPicker } from "../DependsOnPicker";
import type { CardPropertyContext } from "./types";

/**
 * What the card waits for, in this repository or another one. The checkbox list stays what it was,
 * with its groups by project; the property only gives it a compact closed state.
 */
export function DependsOnProperty({ values, onChange, variant, locked, open, onOpenChange, projectId, projects, allTasks, taskId, onOpenTask }: CardPropertyContext) {
  const { t } = useTranslation();
  const label = t("card.dependsOn.label");
  const value = values.depends_on;
  const candidates = allTasks.filter((task) => task.id !== taskId);
  // In a row the blockers are listed right below as links, so naming them in the trigger too says it twice
  const summary =
    value.length === 0
      ? t("card.dependsOn.none")
      : variant === "row"
        ? t("dependsOnPicker.selectedCount", { count: value.length })
        : value.slice(0, 3).map((id) => `#${id}`).join(", ") + (value.length > 3 ? ` +${value.length - 3}` : "");
  const trigger = (
    <PickerTrigger variant={variant} locked={locked} aria-label={`${label}: ${summary}`} title={label}>
      <Hourglass size={13} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
      <span className={value.length === 0 || variant === "row" ? "truncate text-[var(--ink-muted)]" : "tnum truncate font-mono text-[11px]"}>{summary}</span>
    </PickerTrigger>
  );
  return (
    <>
      {locked ? (
        trigger
      ) : (
        <PickerPanel trigger={trigger} open={open} onOpenChange={onOpenChange} className="w-[26rem] max-w-[calc(100vw-2rem)]">
          <div className="min-h-0 overflow-y-auto p-2.5">
            <DependsOnPicker candidates={candidates} projectId={projectId} projects={projects} value={value} onChange={(depends_on) => onChange({ depends_on })} />
          </div>
        </PickerPanel>
      )}
      {/* In the card each blocker is a link: "what are we waiting for" is most often asked right from
         here. One from another repository names its project, otherwise someone else's #12 reads as yours. */}
      {variant === "row" && value.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1.5 pb-1 pt-0.5">
          {value.map((id) => {
            const dep = allTasks.find((task) => task.id === id);
            const foreign = dep && dep.project_id !== projectId ? projects?.find((p) => p.id === dep.project_id) : null;
            return (
              <Badge
                key={id}
                mono
                title={foreign ? t("taskModal.openDepTitleForeign", { id, project: foreign.name }) : t("taskModal.openDepTitle", { id })}
                label={foreign ? t("taskModal.dependsOnForeignLabel", { id, project: foreign.name }) : undefined}
                onClick={onOpenTask ? () => onOpenTask(id) : undefined}
              >
                {t("taskCard.dependsOn", { id })}
                {foreign && <span className="ml-1 font-sans text-[var(--ink-faint)]">· {foreign.name}</span>}
              </Badge>
            );
          })}
        </div>
      )}
    </>
  );
}
