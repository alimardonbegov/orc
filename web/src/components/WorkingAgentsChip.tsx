import { useState } from "react";
import { MessageSquare } from "lucide-react";
import type { WorkingAgent } from "../workingAgents";
import { AgentAvatar } from "./AgentAvatar";
import { Popover } from "../ui/Overlays";
import { focusRing } from "../ui/tokens";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";

interface Props {
  working: readonly WorkingAgent[];
  onOpenTask: (id: number) => void;
  onOpenChat: (id: number) => void;
}

/**
 * "Who is working now" in the header: one chip with the number of busy agents and cards, and a list
 * under it — each agent with its cards and chats, one click from the conversation. It replaces the
 * running thread under the header: the same "something is happening" signal, but with an address.
 * Nobody is working — no chip at all.
 */
export function WorkingAgentsChip({ working, onOpenTask, onOpenChat }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (working.length === 0) return null;
  const cards = working.reduce((n, w) => n + w.tasks.length, 0);
  const shown = working.slice(0, 3);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title={t("workingAgents.title")}
      trigger={
        <button
          type="button"
          data-testid="working-agents-chip"
          aria-label={t("workingAgents.chipLabel", { agents: working.length, cards })}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--line)] px-2.5 text-[12px] font-medium text-[var(--ink-muted)]",
            "transition-colors duration-100 hover:border-[var(--line-strong)] hover:text-[var(--ink)]",
            focusRing,
          )}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-[var(--live)] motion-safe:animate-pulse" />
          <span className="flex -space-x-1.5">
            {shown.map((w) => (
              <AgentAvatar key={w.agent.id} agent={w.agent} size={18} className="ring-2 ring-[var(--surface)]" />
            ))}
          </span>
          <span className="tnum">{t("workingAgents.chip", { agents: working.length, cards })}</span>
        </button>
      }
    >
      <ul className="py-1">
        {working.map((w) => (
          <li key={w.agent.id} className="px-1.5 py-1">
            <div className="flex items-center gap-2 px-1.5 py-1">
              <AgentAvatar agent={w.agent} size={20} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--ink)]">{w.agent.name}</span>
            </div>
            <ul>
              {w.tasks.map((task) => (
                <li key={`t${task.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onOpenTask(task.id);
                    }}
                    className={cn(
                      "flex h-7 w-full items-center gap-1.5 rounded-[var(--radius-sm)] pl-8 pr-1.5 text-left text-[12px] text-[var(--ink-muted)]",
                      "hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] hover:text-[var(--ink)]",
                      focusRing,
                    )}
                  >
                    <span className="tnum shrink-0 text-[11px] text-[var(--ink-faint)]">#{task.id}</span>
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  </button>
                </li>
              ))}
              {w.chats.map((chat) => (
                <li key={`c${chat.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onOpenChat(chat.id);
                    }}
                    className={cn(
                      "flex h-7 w-full items-center gap-1.5 rounded-[var(--radius-sm)] pl-8 pr-1.5 text-left text-[12px] text-[var(--ink-muted)]",
                      "hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] hover:text-[var(--ink)]",
                      focusRing,
                    )}
                  >
                    <MessageSquare size={12} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
                    <span className="min-w-0 flex-1 truncate">{chat.title || t("workingAgents.chat")}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Popover>
  );
}
