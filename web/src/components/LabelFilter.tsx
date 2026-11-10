import { useEffect } from "react";
import { Tag, X } from "lucide-react";
import { Picker } from "../ui/Picker";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { useTranslation } from "../i18n";
import { useLabels } from "../hooks/useLabels";

interface Props {
  /** The label the board is narrowed to; null means all cards. */
  value: number | null;
  onChange: (id: number | null) => void;
}

/**
 * The board's filter by label, in the shape of the other filters of the header: a button that is pressed while it
 * holds, and here also names the label. Nothing is drawn while there are no labels yet, so a board that never
 * uses them looks as it did.
 */
export function LabelFilter({ value, onChange }: Props) {
  const { t } = useTranslation();
  const { labels } = useLabels();
  const chosen = labels.find((l) => l.id === value);
  // The label was deleted while the board was narrowed to it: leaving the filter on would show an empty board
  // with nothing to explain it. The list is empty before it first loads, and the filter is never set by then.
  const gone = value !== null && labels.length > 0 && !chosen;
  useEffect(() => {
    if (gone) onChange(null);
  }, [gone, onChange]);
  if (labels.length === 0 && value === null) return null;
  const label = t("topBar.labelFilter");
  const trigger = (
    <button
      type="button"
      aria-pressed={Boolean(chosen)}
      aria-label={chosen ? `${label}: ${chosen.name}` : label}
      title={label}
      className={cn(
        "inline-flex h-8 max-w-44 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border px-2.5 text-[12px] font-medium transition-colors duration-100",
        focusRing,
        chosen
          ? "border-transparent bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] text-[var(--ink)]"
          : "border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]",
      )}
    >
      {chosen ? <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: chosen.color }} /> : <Tag size={13} aria-hidden />}
      {/* Idle, it is only the icon: the header is full already, and the name is in the tooltip */}
      {chosen && <span className="truncate">{chosen.name}</span>}
    </button>
  );
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <Picker
        label={label}
        trigger={trigger}
        value={value}
        onChange={onChange}
        searchable={labels.length > 8}
        options={labels.map((l) => ({
          value: l.id,
          label: l.name,
          hint: l.task_count !== undefined ? t("topBar.labelCards", { count: l.task_count }) : undefined,
          leading: <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: l.color }} />,
        }))}
        empty={t("topBar.labelNone")}
      />
      {chosen && (
        <button
          type="button"
          aria-label={t("topBar.labelFilterClear")}
          title={t("topBar.labelFilterClear")}
          onClick={() => onChange(null)}
          className={cn("flex h-8 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--ink-faint)] hover:text-[var(--ink)]", focusRing)}
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </span>
  );
}
