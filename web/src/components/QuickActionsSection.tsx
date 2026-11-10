import { Zap } from "lucide-react";
import type { QuickAction } from "../quickActions";
import { Button } from "../ui/Button";
import { SidebarSection } from "../ui/SidebarSection";
import { useTranslation } from "../i18n";

interface Props {
  actions: readonly QuickAction[];
  /** How the text reaches the agent in the card's present state (quickActionSender); null where it cannot. */
  send: ((text: string) => Promise<unknown>) | null;
  pending: boolean;
  /** Runs the call like any other command of the card: it reports an error and refreshes the card. */
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}

/** The canned messages of the card, after multica's QuickActionsSection: one click sends the text to the agent. */
export function QuickActionsSection({ actions, send, pending, run }: Props) {
  const { t } = useTranslation();
  const usable = actions.filter((a) => a.title.trim() && a.prompt.trim());
  if (usable.length === 0) return null;
  return (
    <SidebarSection title={t("card.quickActions.heading")} count={usable.length} defaultOpen>
      {!send && <p className="mb-1.5 text-[11px] leading-snug text-[var(--ink-faint)]">{t("card.quickActions.unavailable")}</p>}
      <div className="flex flex-wrap gap-1">
        {usable.map((a) => (
          <Button
            key={a.id}
            size="sm"
            icon={Zap}
            title={a.prompt}
            disabled={pending || !send}
            onClick={() => send && void run(() => send(a.prompt))}
          >
            {a.title}
          </Button>
        ))}
      </div>
    </SidebarSection>
  );
}
