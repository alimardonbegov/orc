import { useState } from "react";
import { ArrowDownWideNarrow, Check } from "lucide-react";
import { getDoneSortOptions, type DoneSort } from "../sort";
import { IconButton } from "../ui/Button";
import { Popover } from "../ui/Overlays";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { useTranslation } from "../i18n";

interface Props {
  value: DoneSort;
  onChange: (value: DoneSort) => void;
}

/**
 * Order selection in the "Done" column. An icon button in the column header, not a general board
 * switch: order is a property of one column, and the setting should sit where the result is
 * visible.
 *
 * The options are labelled not only by name but also by what ends up on top: "newest first" and
 * "oldest first" are distinguishable only by that.
 */
export function DoneSortMenu({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const options = getDoneSortOptions(t);
  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-[15rem]"
      title={t("doneSortMenu.title")}
      trigger={<IconButton icon={ArrowDownWideNarrow} label={t("doneSortMenu.triggerLabel", { label: current.label })} size="sm" />}
    >
      <div role="radiogroup" aria-label={t("doneSortMenu.groupLabel")} className="flex flex-col p-1">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={cn(
                "flex items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors duration-100",
                focusRing,
                "hover:bg-[color-mix(in_oklab,var(--ink)_7%,transparent)]",
              )}
            >
              {/* The check mark always takes up room: without it the labels would jump when
                 the selection changes. */}
              <Check
                size={13}
                aria-hidden
                className={cn("mt-0.5 shrink-0 text-[var(--ink)]", active ? "opacity-100" : "opacity-0")}
              />
              <span className="min-w-0">
                <span className={cn("block text-[12px]", active ? "font-semibold text-[var(--ink)]" : "text-[var(--ink)]")}>
                  {o.label}
                </span>
                <span className="block text-[11px] leading-snug text-[var(--ink-faint)]">{o.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
