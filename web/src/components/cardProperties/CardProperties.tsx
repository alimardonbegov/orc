import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { CardSettings } from "../../cardSettings";
import type { TaskStatus } from "../../types";
import { useTranslation } from "../../i18n";
import { Picker, PickerTrigger } from "../../ui/Picker";
import { addableProperties, isLocked, visibleProperties } from "./registry";
import { StatusRow } from "./StatusProperty";
import type { CardPropertyContext } from "./types";

interface Props extends Omit<CardPropertyContext, "variant" | "locked" | "open" | "onOpenChange"> {
  settings: CardSettings;
  /** A property opened from outside, with its picker open. */
  openId?: string | null;
  onOpenIdChange?: (id: string | null) => void;
}

interface RowsProps extends Props {
  /** A person moves the card by hand: the status row offers this. Without it there is no status row. */
  onStatusChange?: (status: TaskStatus) => void;
  statusPending?: boolean;
}

/**
 * Progressive disclosure, as in multica: an optional property shows once it holds a value or after the
 * "+ Add property" menu picked it, and picking it opens its picker. What was added stays for as long as the
 * card is on screen, so clearing a value does not make the row vanish under the pointer.
 */
function useDisclosure(props: Props) {
  const { settings, values, taskId } = props;
  const [added, setAdded] = useState<string[]>([]);
  const [innerOpen, setInnerOpen] = useState<string | null>(null);
  // Another card in the same window starts from nothing added
  useEffect(() => setAdded([]), [taskId]);
  const openId = props.onOpenIdChange ? (props.openId ?? null) : innerOpen;
  const setOpenId = props.onOpenIdChange ?? setInnerOpen;
  const visible = visibleProperties(settings, values, undefined, added);
  const addable = addableProperties(settings, values, undefined, added);
  return {
    visible,
    addable,
    add: (id: string) => {
      setAdded((current) => [...current, id]);
      setOpenId(id);
    },
    context: (id: string): Pick<CardPropertyContext, "open" | "onOpenChange"> => ({
      open: openId === id,
      onOpenChange: (open) => setOpenId(open ? id : null),
    }),
  };
}

function AddProperty({ addable, onAdd, variant }: { addable: { id: string; label: string; icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean; className?: string }> }[]; onAdd: (id: string) => void; variant: "pill" | "row" }) {
  const { t } = useTranslation();
  if (addable.length === 0) return null;
  const label = t("card.addProperty");
  return (
    <Picker
      label={label}
      value={null}
      onChange={onAdd}
      // The picked property opens its own picker: the focus must not go back here and dismiss it
      restoreFocus={false}
      options={addable.map((p) => ({ value: p.id, label: t(p.label), leading: <p.icon size={14} aria-hidden className="text-[var(--ink-faint)]" /> }))}
      trigger={
        <PickerTrigger variant={variant} aria-label={label} title={label} className={variant === "row" ? "text-[var(--ink-muted)]" : "border-dashed text-[var(--ink-muted)]"}>
          <Plus size={13} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
          <span className="truncate">{label}</span>
        </PickerTrigger>
      }
    />
  );
}

/** The row of pills under the title in the creation form. */
export function PropertyPills(props: Props) {
  const { settings: _settings, openId: _o, onOpenIdChange: _c, ...shared } = props;
  void _settings;
  const d = useDisclosure(props);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {d.visible.map((p) => (
        <p.Control key={p.id} {...shared} variant="pill" locked={false} {...d.context(p.id)} />
      ))}
      <AddProperty addable={d.addable} onAdd={d.add} variant="pill" />
    </div>
  );
}

/** The properties column of a card: a name on the left, the editable value on the right. */
export function PropertyRows(props: RowsProps) {
  const { t } = useTranslation();
  const { settings: _settings, openId: _o, onOpenIdChange: _c, onStatusChange, statusPending, ...shared } = props;
  void _settings;
  const d = useDisclosure(props);
  const { status } = props;
  return (
    <dl className="space-y-0.5">
      {status && onStatusChange && <StatusRow status={status} onChange={onStatusChange} pending={statusPending} />}
      {d.visible.filter((p) => !p.formOnly).map((p) => (
        <div key={p.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-1">
          <dt className="pt-1.5 text-[11px] text-[var(--ink-faint)]">{t(p.label)}</dt>
          <dd className="min-w-0">
            <p.Control {...shared} variant="row" locked={status ? isLocked(p, status) : false} {...d.context(p.id)} />
          </dd>
        </div>
      ))}
      {d.addable.length > 0 && (
        <div className="pt-1">
          <AddProperty addable={d.addable} onAdd={d.add} variant="row" />
        </div>
      )}
    </dl>
  );
}
