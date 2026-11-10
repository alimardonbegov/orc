import { useMemo } from "react";
import { Plus, X } from "lucide-react";
import type { Agent, Project } from "../types";
import { MAX_PINNED, usePinnedAgents } from "../chats";
import { useTranslation } from "../i18n";
import { cn } from "../lib/cn";
import { Picker } from "../ui/Picker";
import { focusRing } from "../ui/tokens";
import { agentOptions } from "./agentOptions";
import { AgentAvatar } from "./AgentAvatar";

/**
 * A strip of the agents the owner talks to most: a face is one click to a new chat with that agent.
 * The faces are chosen by the owner, in this browser; the cross on one takes it off the strip.
 */
export function QuickAgentBar({ agents, projects, onStart }: { agents: readonly Agent[]; projects: readonly Project[]; onStart: (agent: Agent) => void }) {
  const { t } = useTranslation();
  const { ids, pin, unpin } = usePinnedAgents();
  const pinned = useMemo(() => ids.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a), [ids, agents]);
  const addable = useMemo(() => agents.filter((a) => !ids.includes(a.id)), [agents, ids]);
  const options = useMemo(
    () => agentOptions(addable, projects, (project) => t("chats.agentInternal", { project })),
    [addable, projects, t],
  );
  const canAdd = addable.length > 0 && pinned.length < MAX_PINNED;
  if (pinned.length === 0 && !canAdd) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--line)] px-3 py-2">
      {pinned.map((agent) => (
        <span key={agent.id} className="group/pin relative shrink-0">
          <button
            type="button"
            aria-label={t("chats.quickStart", { name: agent.name })}
            title={t("chats.quickStart", { name: agent.name })}
            onClick={() => onStart(agent)}
            className={cn("block rounded-full transition-transform duration-100 hover:scale-105", focusRing)}
          >
            <AgentAvatar agent={agent} size={32} title={agent.name} className="ring-1 ring-inset ring-[var(--line)]" />
          </button>
          <button
            type="button"
            aria-label={t("chats.quickRemove", { name: agent.name })}
            title={t("chats.quickRemove", { name: agent.name })}
            onClick={() => unpin(agent.id)}
            className={cn(
              "absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--raised)] text-[var(--ink-muted)]",
              "opacity-0 transition-opacity hover:text-[var(--ink)] group-focus-within/pin:opacity-100 group-hover/pin:opacity-100",
              focusRing,
            )}
          >
            <X size={9} aria-hidden />
          </button>
        </span>
      ))}
      {canAdd && (
        <Picker
          label={t("chats.quickAdd")}
          searchable
          options={options}
          value={null}
          onChange={pin}
          trigger={
            <button
              type="button"
              aria-label={t("chats.quickAdd")}
              title={t("chats.quickAdd")}
              className={cn(
                "flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full text-[var(--ink-muted)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] hover:text-[var(--ink)]",
                pinned.length === 0 ? "px-2.5 text-[12px]" : "size-8 bg-[var(--sunken)] ring-1 ring-inset ring-[var(--line)]",
                focusRing,
              )}
            >
              <Plus size={14} aria-hidden />
              {pinned.length === 0 && <span>{t("chats.quickEmpty")}</span>}
            </button>
          }
        />
      )}
    </div>
  );
}
