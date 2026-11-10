import { useState } from "react";
import { Bookmark, Check, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PickerPanel } from "../ui/Picker";
import { Button } from "../ui/Button";
import { cn } from "../lib/cn";
import { fieldBase, focusRing } from "../ui/tokens";
import { useTranslation } from "../i18n";
import { api } from "../api";
import { sameFilters } from "../hooks/useBoardViews";
import type { BoardFilters, BoardView } from "../types";

interface Props {
  projectId: number;
  views: BoardView[];
  /** The filters the board holds right now. */
  current: BoardFilters;
  onApply: (filters: BoardFilters) => void;
  onChanged: () => void;
}

/**
 * Saved views in the board header: open one to bring its filters back, save the current filters under a name,
 * update or delete a view. A view is kept on the server per project, so it survives a reload.
 */
export function ViewsMenu({ projectId, views, current, onApply, onChanged }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const active = views.find((v) => sameFilters(v.filters, current));

  const run = async (job: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await job();
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const label = t("boardViews.tip");
  const trigger = (
    <button
      type="button"
      aria-pressed={Boolean(active)}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-8 max-w-44 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border px-2.5 text-[12px] font-medium transition-colors duration-100",
        focusRing,
        active
          ? "border-transparent bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] text-[var(--ink)]"
          : "border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]",
      )}
    >
      <Bookmark size={13} aria-hidden />
      <span className="truncate">{active ? active.name : t("boardViews.menu")}</span>
    </button>
  );

  return (
    <PickerPanel trigger={trigger} open={open} onOpenChange={setOpen} align="start">
      <ul className="flex min-h-0 flex-col overflow-y-auto p-1" aria-label={label}>
        {views.length === 0 && <li className="px-2 py-2 text-[12px] text-[var(--ink-faint)]">{t("boardViews.empty")}</li>}
        {views.map((v) => (
          <li key={v.id} className="group flex items-center gap-1 rounded-[var(--radius-sm)] hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]">
            <button
              type="button"
              onClick={() => {
                onApply(v.filters);
                setOpen(false);
              }}
              className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] text-[var(--ink)]", focusRing)}
            >
              <Check size={12} aria-hidden className={cn("shrink-0", v.id === active?.id ? "opacity-100" : "opacity-0")} />
              <span className="truncate">{v.name}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              title={t("boardViews.update")}
              aria-label={`${t("boardViews.update")}: ${v.name}`}
              onClick={() => void run(() => api.updateView(v.id, { filters: current }), t("boardViews.updatedToast"))}
              className={cn("rounded-[4px] px-1.5 py-1 text-[11px] text-[var(--ink-faint)] opacity-0 hover:text-[var(--ink)] focus-visible:opacity-100 group-hover:opacity-100", focusRing)}
            >
              <RefreshCw size={11} aria-hidden />
            </button>
            <button
              type="button"
              disabled={busy}
              title={t("boardViews.remove")}
              aria-label={`${t("boardViews.remove")}: ${v.name}`}
              onClick={() => void run(() => api.deleteView(v.id), t("boardViews.deletedToast"))}
              className={cn("mr-1 rounded-[4px] p-1 text-[var(--ink-faint)] opacity-0 hover:text-[var(--danger)] focus-visible:opacity-100 group-hover:opacity-100", focusRing)}
            >
              <Trash2 size={12} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex shrink-0 items-center gap-1.5 border-t border-[var(--line)] p-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          void run(async () => {
            await api.addView(projectId, trimmed, current);
            setName("");
          }, t("boardViews.savedToast", { name: trimmed }));
        }}
      >
        <input
          aria-label={t("boardViews.save")}
          title={t("boardViews.save")}
          placeholder={t("boardViews.namePlaceholder")}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          className={cn(fieldBase, "h-7 min-w-0 flex-1 px-2 text-[12px]")}
        />
        <Button type="submit" size="sm" disabled={busy || !name.trim()}>
          {t("boardViews.saveButton")}
        </Button>
      </form>
    </PickerPanel>
  );
}
