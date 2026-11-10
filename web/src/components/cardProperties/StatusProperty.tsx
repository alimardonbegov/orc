import { STATUS_META } from "../../status";
import { statusLabel } from "../../labels";
import type { TaskStatus } from "../../types";
import { Picker, PickerTrigger } from "../../ui/Picker";
import { useTranslation } from "../../i18n";
import { canMove } from "../Board";

/** The statuses a person may move a card to by hand and that the card row offers: the queue and the backlog. */
const OFFERED: readonly TaskStatus[] = ["backlog", "todo"];

/** What the picker would offer from this status: the same transitions the board allows by drag. */
function statusTargets(from: TaskStatus): TaskStatus[] {
  return OFFERED.filter((to) => canMove(from, to));
}

/**
 * The status row at the top of the card's properties. It offers what the server allows (backlog and To do) and
 * is locked while the dispatcher owns the status: a working card is moved by its session, not by a person.
 * Forcing a close stays where it was.
 */
export function StatusRow({ status, onChange, pending }: { status: TaskStatus; onChange: (to: TaskStatus) => void; pending?: boolean }) {
  const { t } = useTranslation();
  const targets = statusTargets(status);
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  const label = t("card.status.label");
  const locked = targets.length === 0 || Boolean(pending);
  const trigger = (
    <PickerTrigger variant="row" locked={locked} aria-label={`${label}: ${statusLabel(t, status)}`} title={locked && targets.length === 0 ? t("card.status.lockedHint") : label}>
      <Icon size={13} aria-hidden className={meta.fg} />
      <span className="truncate">{statusLabel(t, status)}</span>
    </PickerTrigger>
  );
  return (
    <div data-testid="status-row" className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-1">
      <span className="pt-1.5 text-[11px] text-[var(--ink-faint)]">{label}</span>
      <div className="min-w-0">
        {locked ? (
          trigger
        ) : (
          <Picker
            label={label}
            trigger={trigger}
            value={status}
            onChange={onChange}
            options={targets.map((to) => {
              const ToIcon = STATUS_META[to].icon;
              return { value: to, label: statusLabel(t, to), leading: <ToIcon size={14} aria-hidden className={STATUS_META[to].fg} /> };
            })}
          />
        )}
      </div>
    </div>
  );
}
