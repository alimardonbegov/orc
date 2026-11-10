import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { CardSettings } from "../cardSettings";
import { newActionId, resolveQuickActions, type QuickAction } from "../quickActions";
import { Button } from "../ui/Button";
import { Input, Textarea } from "../ui/Field";
import { useTranslation } from "../i18n";

interface Props {
  value: CardSettings;
  onChange: (next: CardSettings) => void;
  disabled?: boolean;
}

/**
 * The quick actions of the card settings: a list of a title and a text for the agent. Until the owner
 * touches it the built-in set shows; the first edit stores the whole list, and "restore" drops the key.
 */
export function QuickActionsEditor({ value, onChange, disabled }: Props) {
  const { t } = useTranslation();
  const actions = resolveQuickActions(value, t);
  const set = (next: QuickAction[]) => onChange({ ...value, quick_actions: next });
  const patch = (index: number, fields: Partial<QuickAction>) => set(actions.map((a, i) => (i === index ? { ...a, ...fields } : a)));
  const move = (index: number, by: number) => {
    const next = [...actions];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    set(next);
  };

  return (
    <div className="space-y-2">
      <div>
        <h4 className="text-[12px] font-medium text-[var(--ink)]">{t("card.quickActions.heading")}</h4>
        <p className="mt-0.5 text-[11px] leading-snug text-[var(--ink-faint)]">{t("card.quickActions.hint")}</p>
      </div>
      {actions.length === 0 && <p className="text-[12px] text-[var(--ink-faint)]">{t("card.quickActions.empty")}</p>}
      <ul className="space-y-2">
        {actions.map((a, i) => (
          <li key={a.id} className="space-y-1 rounded-[var(--radius-sm)] border border-[var(--line)] p-2">
            <div className="flex items-center gap-1">
              <Input
                aria-label={t("card.quickActions.title")}
                placeholder={t("card.quickActions.title")}
                maxLength={60}
                disabled={disabled}
                value={a.title}
                onChange={(e) => patch(i, { title: e.target.value })}
              />
              <Button size="sm" variant="ghost" icon={ArrowUp} aria-label={t("card.quickActions.up", { title: a.title })} disabled={disabled || i === 0} onClick={() => move(i, -1)} />
              <Button size="sm" variant="ghost" icon={ArrowDown} aria-label={t("card.quickActions.down", { title: a.title })} disabled={disabled || i === actions.length - 1} onClick={() => move(i, 1)} />
              <Button size="sm" variant="ghost" icon={Trash2} aria-label={t("card.quickActions.remove", { title: a.title })} disabled={disabled} onClick={() => set(actions.filter((_, j) => j !== i))} />
            </div>
            <Textarea
              aria-label={t("card.quickActions.prompt")}
              placeholder={t("card.quickActions.prompt")}
              className="min-h-16 text-[12px]"
              maxLength={4000}
              disabled={disabled}
              value={a.prompt}
              onChange={(e) => patch(i, { prompt: e.target.value })}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={Plus} disabled={disabled || actions.length >= 30} onClick={() => set([...actions, { id: newActionId(actions), title: "", prompt: "" }])}>
          {t("card.quickActions.add")}
        </Button>
        <Button size="sm" variant="ghost" icon={RotateCcw} disabled={disabled || value.quick_actions === undefined} onClick={() => onChange({ ...value, quick_actions: undefined })}>
          {t("card.quickActions.reset")}
        </Button>
      </div>
    </div>
  );
}
