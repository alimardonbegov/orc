import { useMemo } from "react";
import { ChevronDown, FolderGit2, Plus } from "lucide-react";
import type { Agent, Project } from "../types";
import { useTranslation } from "../i18n";
import { Button } from "../ui/Button";
import { Picker, PickerTrigger, type PickerOption } from "../ui/Picker";
import { AgentAvatar } from "./AgentAvatar";
import { agentOptions } from "./agentOptions";

/**
 * The agent of a chat as a chip with a searchable list of everyone. In a new chat it switches who is
 * being talked to, keeping the text; in an existing one it starts a new chat with the pick.
 */
export function AgentChoice({ agents, projects, value, onChange }: { agents: readonly Agent[]; projects: readonly Project[]; value: Agent; onChange: (agent: Agent) => void }) {
  const { t } = useTranslation();
  const options = useMemo(
    () => agentOptions(agents, projects, (project) => t("chats.agentInternal", { project })),
    [agents, projects, t],
  );
  return (
    <Picker
      label={t("chats.pickAgent")}
      searchable
      options={options}
      value={value.id}
      onChange={(id) => {
        const next = agents.find((a) => a.id === id);
        if (next) onChange(next);
      }}
      trigger={
        <PickerTrigger aria-label={t("chats.switchAgent")} title={t("chats.switchAgent")} className="border-transparent bg-transparent hover:bg-[color-mix(in_oklab,var(--ink)_8%,transparent)]">
          <AgentAvatar agent={value} size={18} />
          <span className="truncate">{value.name}</span>
          <ChevronDown size={11} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
        </PickerTrigger>
      }
    />
  );
}

const NO_PROJECT = 0;

/** What the agent works on. An internal agent works only on its own project, so nothing is offered. */
export function ProjectChoice({ projects, agent, value, onChange }: { projects: readonly Project[]; agent: Agent; value: number | null; onChange: (id: number | null) => void }) {
  const { t } = useTranslation();
  const locked = agent.project_id !== null;
  const shown = locked ? agent.project_id : value;
  const current = projects.find((p) => p.id === shown);
  const options = useMemo<PickerOption<number>[]>(
    () => [
      { value: NO_PROJECT, label: t("chats.noProject"), pinned: true },
      ...projects.filter((p) => !p.archived_at && p.path_ok).map((p) => ({ value: p.id, label: p.name, leading: <FolderGit2 size={13} aria-hidden className="shrink-0 text-[var(--ink-faint)]" /> })),
    ],
    [projects, t],
  );
  const trigger = (
    <PickerTrigger
      locked={locked}
      aria-label={t("chats.pickProject")}
      title={locked ? t("chats.projectLocked") : t("chats.pickProjectHint")}
      className="border-transparent bg-transparent hover:bg-[color-mix(in_oklab,var(--ink)_8%,transparent)]"
    >
      <FolderGit2 size={12} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
      <span className="truncate">{current?.name ?? t("chats.noProject")}</span>
      {!locked && <ChevronDown size={11} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />}
    </PickerTrigger>
  );
  if (locked) return trigger;
  return <Picker label={t("chats.pickProject")} searchable={options.length > 6} options={options} value={shown ?? NO_PROJECT} onChange={(id) => onChange(id === NO_PROJECT ? null : id)} trigger={trigger} />;
}

/**
 * "New chat": the agent is chosen here, from a searchable list. With a single agent there is nothing to
 * choose, so the chat opens at once.
 */
export function NewChatButton({ agents, projects, onStart }: { agents: readonly Agent[]; projects: readonly Project[]; onStart: (agent: Agent) => void }) {
  const { t } = useTranslation();
  const options = useMemo(
    () => agentOptions(agents, projects, (project) => t("chats.agentInternal", { project })),
    [agents, projects, t],
  );
  if (agents.length <= 1) {
    return (
      <Button variant="secondary" size="sm" icon={Plus} disabled={agents.length === 0} title={agents.length === 0 ? t("chats.noAgents") : undefined} onClick={() => agents[0] && onStart(agents[0])}>
        {t("chats.new")}
      </Button>
    );
  }
  return (
    <Picker
      label={t("chats.pickAgent")}
      searchable
      align="end"
      options={options}
      value={null}
      onChange={(id) => {
        const agent = agents.find((a) => a.id === id);
        if (agent) onStart(agent);
      }}
      trigger={
        <Button variant="secondary" size="sm" icon={Plus}>
          {t("chats.new")}
        </Button>
      }
    />
  );
}
