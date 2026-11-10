import { useState } from "react";
import { CalendarCheck, CalendarClock, X, type LucideIcon } from "lucide-react";
import { PickerPanel, PickerTrigger } from "../../ui/Picker";
import { fieldBase, focusRing } from "../../ui/tokens";
import { Button } from "../../ui/Button";
import { cn } from "../../lib/cn";
import { useTranslation } from "../../i18n";
import { formatDay, isOverdue, todayKey } from "../../planDates";
import type { CardPropertyContext, CardPropertyValues } from "./types";

type DateField = "start_date" | "due_date";

/**
 * A planning day. The dispatcher never reads it: it is the plan, for people. The deferred start that
 * does hold the queue is the separate "Start" row.
 */
function DateControl({ field, icon: Icon, labelKey, context }: { field: DateField; icon: LucideIcon; labelKey: string; context: CardPropertyContext }) {
  const { values, onChange, variant, locked, open, onOpenChange, status } = context;
  const { t, language } = useTranslation();
  const label = t(labelKey);
  const value = values[field];
  const overdue = field === "due_date" && status !== undefined && isOverdue(value, status, todayKey());
  const text = value ? formatDay(value, language) : "—";
  const set = (next: string | null) => onChange({ [field]: next } as Partial<CardPropertyValues>);
  // Enter closes the panel, so the panel keeps its own open state when the caller does not hold it
  const [ownOpen, setOwnOpen] = useState(false);
  const panelOpen = open ?? ownOpen;
  const setPanelOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  // The server refuses a due date before the start date: the browser's picker offers only valid days
  const bounds = field === "due_date" ? { min: values.start_date ?? undefined } : { max: values.due_date ?? undefined };

  const trigger = (
    <PickerTrigger variant={variant} locked={locked} aria-label={`${label}: ${text}${overdue ? ` (${t("card.dueDate.overdue")})` : ""}`} title={overdue ? t("card.dueDate.overdue") : label}>
      <Icon size={13} aria-hidden className={cn("shrink-0", overdue ? "text-[var(--danger)]" : "text-[var(--ink-faint)]")} />
      <span className={cn("tnum truncate", overdue ? "font-medium text-[var(--danger)]" : !value && "text-[var(--ink-muted)]")}>
        {value ? text : variant === "pill" ? label : text}
      </span>
    </PickerTrigger>
  );
  if (locked) return trigger;
  return (
    <PickerPanel trigger={trigger} open={panelOpen} onOpenChange={setPanelOpen} className="w-60">
      <div className="space-y-2 p-2.5">
        <input
          type="date"
          autoFocus
          aria-label={label}
          value={value ?? ""}
          {...bounds}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setPanelOpen(false);
            }
          }}
          // An empty value is a cleared field: a half-typed date never reaches here
          onChange={(e) => set(e.target.value || null)}
          className={cn(fieldBase, "h-8", focusRing)}
        />
        {value && (
          <Button size="sm" variant="ghost" icon={X} onClick={() => set(null)}>
            {t("card.date.clear")}
          </Button>
        )}
      </div>
    </PickerPanel>
  );
}

export const StartDateProperty = (context: CardPropertyContext) => (
  <DateControl field="start_date" icon={CalendarClock} labelKey="card.startDate.label" context={context} />
);

export const DueDateProperty = (context: CardPropertyContext) => (
  <DateControl field="due_date" icon={CalendarCheck} labelKey="card.dueDate.label" context={context} />
);
