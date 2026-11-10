import { useState } from "react";
import { Check, Plus, Tag } from "lucide-react";
import { PickerPanel, PickerTrigger } from "../../ui/Picker";
import { fieldBase, focusRing } from "../../ui/tokens";
import { cn } from "../../lib/cn";
import { useTranslation } from "../../i18n";
import { labelsByName, useLabels } from "../../hooks/useLabels";
import { LabelChip } from "../LabelChip";
import type { CardPropertyContext } from "./types";

/**
 * The labels of a card. The picker lists every label with a tick, and typing a name that does not exist
 * offers to create it on the spot, so a new label never needs a trip to a settings page.
 */
export function LabelsProperty({ values, onChange, variant, locked, open, onOpenChange }: CardPropertyContext) {
  const { t } = useTranslation();
  const { labels, create } = useLabels();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const label = t("card.labels.label");
  const chosen = new Set(values.labels.map((n) => n.toLowerCase()));
  const shown = labelsByName(values.labels, labels);

  const trigger = (
    <PickerTrigger variant={variant} locked={locked} aria-label={`${label}: ${values.labels.join(", ") || t("card.labels.none")}`} title={label}>
      {shown.length === 0 ? (
        <>
          <Tag size={13} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
          <span className="truncate text-[var(--ink-muted)]">{variant === "pill" ? label : t("card.labels.none")}</span>
        </>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {shown.map((l) => (
            <LabelChip key={l.name} label={l} />
          ))}
        </span>
      )}
    </PickerTrigger>
  );
  if (locked) return trigger;

  const needle = query.trim().toLowerCase();
  const matches = labels.filter((l) => l.name.toLowerCase().includes(needle));
  const exact = labels.some((l) => l.name.toLowerCase() === needle);

  function toggle(name: string) {
    onChange({ labels: chosen.has(name.toLowerCase()) ? values.labels.filter((n) => n.toLowerCase() !== name.toLowerCase()) : [...values.labels, name] });
  }

  async function createNew() {
    const name = query.trim();
    if (!name) return;
    setError(null);
    try {
      const made = await create(name);
      if (!chosen.has(made.name.toLowerCase())) onChange({ labels: [...values.labels, made.name] });
      setQuery("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <PickerPanel trigger={trigger} open={open} onOpenChange={onOpenChange}>
      <div className="border-b border-[var(--line)] p-2">
        <input
          autoFocus
          aria-label={t("card.labels.searchLabel")}
          placeholder={t("card.labels.searchPlaceholder")}
          value={query}
          maxLength={40}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (needle && !exact) void createNew();
              else if (matches.length === 1) toggle(matches[0].name);
            }
          }}
          className={cn(fieldBase, "h-8")}
        />
      </div>
      <ul role="listbox" aria-multiselectable aria-label={label} className="min-h-0 overflow-y-auto py-1">
        {matches.map((l) => (
          <li key={l.id} role="option" aria-selected={chosen.has(l.name.toLowerCase())}>
            <button
              type="button"
              onClick={() => toggle(l.name)}
              className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]", focusRing)}
            >
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: l.color }} />
              <span className="min-w-0 flex-1 truncate">{l.name}</span>
              {chosen.has(l.name.toLowerCase()) && <Check size={13} aria-hidden className="shrink-0 text-[var(--ink-muted)]" />}
            </button>
          </li>
        ))}
        {matches.length === 0 && !needle && <li className="px-3 py-2 text-[12px] text-[var(--ink-faint)]">{t("card.labels.empty")}</li>}
      </ul>
      {needle && !exact && (
        <button
          type="button"
          onClick={() => void createNew()}
          className={cn("flex items-center gap-2 border-t border-[var(--line)] px-3 py-2 text-left text-[12px] hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]", focusRing)}
        >
          <Plus size={13} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
          <span className="truncate">{t("card.labels.create", { name: query.trim() })}</span>
        </button>
      )}
      {error && <p role="alert" className="border-t border-[var(--line)] px-3 py-2 text-[12px] text-[var(--danger)]">{error}</p>}
    </PickerPanel>
  );
}
