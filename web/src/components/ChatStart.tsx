import type { Agent, Project } from "../types";
import { startersFor } from "../chats";
import { useTranslation } from "../i18n";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { AgentAvatar } from "./AgentAvatar";

/**
 * What an empty chat shows: who is on the other side, what they do, and a few ways to begin. A starter
 * sends at once, as a click on a suggestion in a search box does: the point is to not face a blank box.
 */
export function ChatStart({ agent, project, onPick, disabled }: { agent: Agent; project: Project | undefined; onPick: (prompt: string) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const starters = startersFor(t, !!project);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-5 py-6">
      <AgentAvatar agent={agent} size={56} className="ring-1 ring-inset ring-[var(--line)]" />
      <div className="max-w-sm space-y-1 text-center">
        <h3 className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">{t("chats.chatWith", { name: agent.name })}</h3>
        {agent.description.trim() && <p className="text-[12px] leading-snug text-[var(--ink-muted)]">{agent.description}</p>}
        <p className="text-[11px] leading-snug text-[var(--ink-faint)]">
          {project ? t("chats.startHintProject", { project: project.name }) : t("chats.startHintScratch")}
        </p>
      </div>
      <div role="group" aria-label={t("chats.startersLabel")} className="w-full max-w-sm space-y-1.5">
        {starters.map((s) => (
          <button
            key={s.key}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s.prompt)}
            className={cn(
              "w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-left text-[13px] text-[var(--ink)] transition-colors duration-100",
              "hover:border-[var(--line-strong)] hover:bg-[color-mix(in_oklab,var(--ink)_5%,var(--surface))] disabled:pointer-events-none disabled:opacity-50",
              focusRing,
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
