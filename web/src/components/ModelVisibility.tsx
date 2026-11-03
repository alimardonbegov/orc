import { Eye } from "lucide-react";
import { getModelOptions } from "../models";
import { Checkbox } from "../ui/Field";
import { focusRing } from "../ui/tokens";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";

interface Props {
  /** ids of hidden models. */
  hidden: readonly string[];
  onChange: (hidden: string[]) => void;
  disabled?: boolean;
}

/**
 * Which models are visible in the model-selection dropdowns. Checked means the model is in the
 * list, unchecked means hidden but not deleted: it can be brought back right here with one click.
 * One control for orc settings and for a project, so that hiding looks the same everywhere.
 */
export function ModelVisibility({ hidden, onChange, disabled }: Props) {
  const { t } = useTranslation();
  const options = getModelOptions(t);
  const hiddenSet = new Set(hidden);
  const hiddenCount = options.filter((m) => hiddenSet.has(m.id)).length;

  function toggle(id: string, visible: boolean) {
    // We do not touch foreign ids (not from the model list): they could have been put into the
    // setting by a manual request
    onChange(visible ? hidden.filter((m) => m !== id) : [...hidden, id]);
  }

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        {options.map((m) => (
          <label
            key={m.id}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-[12px] transition-colors hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <Checkbox
              aria-label={m.label}
              checked={!hiddenSet.has(m.id)}
              disabled={disabled}
              onChange={(e) => toggle(m.id, e.target.checked)}
            />
            <span className={cn("text-[var(--ink)]", hiddenSet.has(m.id) && "text-[var(--ink-faint)] line-through")}>
              {m.label}
            </span>
            <span className="truncate text-[11px] text-[var(--ink-faint)]">{m.hint}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2 px-1.5 text-[11px] text-[var(--ink-faint)]">
        <span>
          {hiddenCount === 0
            ? t("modelVisibility.allVisible")
            : t("modelVisibility.hiddenCount", { hidden: hiddenCount, total: options.length })}
        </span>
        {hiddenCount > 0 && !disabled && (
          <button
            type="button"
            className={cn(
              "ml-auto flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 transition-colors hover:text-[var(--ink)]",
              focusRing,
            )}
            onClick={() => onChange(hidden.filter((id) => !options.some((m) => m.id === id)))}
          >
            <Eye size={11} aria-hidden />
            {t("modelVisibility.showAll")}
          </button>
        )}
      </div>
    </div>
  );
}
