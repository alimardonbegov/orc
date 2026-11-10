import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api } from "../api";
import { useAgents } from "../agents";
import { canAutoFocus, NEW_CHAT, stashChatDraft, useChatDraft, type ChatDraft } from "../chats";
import { useTranslation } from "../i18n";
import type { Agent, Chat, Project } from "../types";
import { IconButton } from "../ui/Button";
import { AgentChoice, ProjectChoice } from "./ChatChoices";
import { ChatComposer } from "./ChatComposer";
import { ChatStart } from "./ChatStart";

interface Props {
  draft: ChatDraft;
  projects: Project[];
  onAgentChange: (agent: Agent) => void;
  onProjectChange: (projectId: number | null) => void;
  /** The chat exists now and holds the first message. */
  onCreated: (chat: Chat) => void;
  onBack?: () => void;
}

/**
 * A chat that does not exist yet. The agent and the project are chosen right here, beside the message,
 * and the server hears of the chat only with the first message: so a chat opened and abandoned leaves
 * nothing behind to be deleted.
 */
export function NewChatPane({ draft, projects, onAgentChange, onProjectChange, onCreated, onBack }: Props) {
  const { t } = useTranslation();
  const agents = useAgents();
  const [text, setText] = useChatDraft(NEW_CHAT);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === draft.agentId);
  if (!agent) return <div className="flex-1" />;
  const projectId = agent.project_id ?? draft.projectId;
  const project = projects.find((p) => p.id === projectId);

  async function submit(raw: string) {
    const body = raw.trim();
    if (!body || pending || !agent) return;
    setPending(true);
    setError(null);
    let chat: Chat;
    try {
      chat = await api.addChat({ agent_id: agent.id, project_id: projectId });
    } catch (e) {
      // Nothing was made: the text stays where it was typed
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
      return;
    }
    try {
      await api.sendChatMessage(chat.id, body);
    } catch {
      // The chat exists and is empty: the text waits in its box, so that sending again is one key
      stashChatDraft(chat.id, body);
    }
    // A starter is not what was typed: the unsent sentence stays
    if (body === text.trim()) setText("");
    onCreated(chat);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-[var(--line)] px-4 py-2.5">
        {onBack && <IconButton icon={ArrowLeft} label={t("chats.back")} size="sm" onClick={onBack} />}
        <h2 className="truncate text-[13px] font-semibold text-[var(--ink)]">{t("chats.newTitle")}</h2>
      </header>
      <ChatStart agent={agent} project={project} onPick={(prompt) => void submit(prompt)} disabled={pending} />
      <ChatComposer
        value={text}
        onChange={setText}
        onSubmit={() => void submit(text)}
        submitting={pending}
        placeholder={t("chats.placeholder")}
        error={error}
        autoFocus={canAutoFocus()}
        leading={
          <>
            <AgentChoice agents={agents} projects={projects} value={agent} onChange={onAgentChange} />
            <ProjectChoice projects={projects} agent={agent} value={projectId} onChange={onProjectChange} />
          </>
        }
      />
    </div>
  );
}
