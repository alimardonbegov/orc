import { PRIORITIES, PRIORITY_META, capitalized } from "../../priority";
import { priorityLabel } from "../../labels";
import type { Priority } from "../../types";
import { Picker, PickerTrigger } from "../../ui/Picker";
import { cn } from "../../lib/cn";
import { useTranslation } from "../../i18n";
import type { CardPropertyContext } from "./types";

export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  const { icon: Icon, fg } = PRIORITY_META[priority];
  return <Icon size={size} strokeWidth={2.5} aria-hidden className={cn("shrink-0", fg)} />;
}

export function PriorityProperty({ values, onChange, variant, locked, open, onOpenChange }: CardPropertyContext) {
  const { t } = useTranslation();
  const label = t("card.priority.label");
  const name = priorityLabel(t, values.priority);
  const trigger = (
    <PickerTrigger variant={variant} locked={locked} aria-label={`${label}: ${name}`} title={label}>
      <PriorityIcon priority={values.priority} />
      <span className="block truncate first-letter:uppercase">{name}</span>
    </PickerTrigger>
  );
  if (locked) return trigger;
  return (
    <Picker
      label={label}
      trigger={trigger}
      value={values.priority}
      onChange={(priority) => onChange({ priority })}
      open={open}
      onOpenChange={onOpenChange}
      options={PRIORITIES.map((p) => ({ value: p, label: capitalized(priorityLabel(t, p)), leading: <PriorityIcon priority={p} /> }))}
    />
  );
}
