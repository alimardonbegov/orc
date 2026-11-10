import { useMemo, useState } from "react";
import { api } from "../api";
import { CheckCheck, MessageCircle, Minus, Maximize2, Minimize2 } from "lucide-react";
import type { Agent, Chat, Project } from "../types";
import { useAgents } from "../agents";
import { ACTIVE, defaultAgent, draftFor, type ChatDraft } from "../chats";
import { IconButton } from "../ui/Button";
import { NewChatButton } from "./ChatChoices";
import { ChatList } from "./ChatList";
import { ChatPane } from "./ChatPanel";
import { NewChatPane } from "./NewChatPane";
import { QuickAgentBar } from "./QuickAgentBar";
import { focusRing } from "../ui/tokens";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";

interface Props {
  chats: Chat[];
  projects: Project[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onChanged: () => void;
  onOpenTask: (taskId: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

/** Replies the owner has not read yet, across every chat. */
function unreadOf(chats: Chat[]): number {
  // An archived chat was put away on purpose: its news does not call for the badge
  return chats.reduce((sum, c) => (c.archived_at ? sum : sum + c.unread), 0);
}

/**
 * Chats as a button over the whole app: one click from any page opens a window in the corner.
 * Narrow, it shows either the list or one conversation; stretched wide, the list stands beside
 * the conversation, and where nothing is selected a new chat is ready to be typed into. The window
 * is unmounted when minimized, so a hidden chat neither polls nor marks anything as read.
 */
export function ChatOverlay({ chats, projects, selectedId, onSelect, onChanged, onOpenTask, open, onOpenChange, expanded, onExpandedChange }: Props) {
  const { t } = useTranslation();
  const agents = useAgents();
  const [started, setStarted] = useState<ChatDraft | null>(null);
  // A chat made a moment ago is not in the list until the next poll, yet it is already the one to show
  const [created, setCreated] = useState<number | null>(null);
  const unread = unreadOf(chats);
  const running = chats.some((c) => ACTIVE.has(c.status));
  const paneId = selectedId !== null && (selectedId === created || chats.some((c) => c.id === selectedId)) ? selectedId : null;

  // A draft belongs to the moment it was made in: a chat opened from elsewhere (a routine run, an
  // agent's card) takes the window over, and the draft must not come back when that chat is left
  if (started && started.since !== selectedId) setStarted(null);
  const draft = started && started.since === selectedId ? started : null;
  // Wide, with nothing selected, the window is not an empty pane: it is a new chat with the agent last talked to
  const ready = useMemo(() => {
    const agent = defaultAgent(agents, chats);
    return agent && !draft && paneId === null && expanded ? draftFor(agent, projects, selectedId) : null;
  }, [agents, chats, projects, draft, paneId, expanded, selectedId]);
  const composing = draft ?? ready;

  const select = (id: number | null) => {
    setStarted(null);
    onSelect(id);
  };
  const startWith = (agent: Agent) => {
    onSelect(null);
    setStarted(draftFor(agent, projects, null));
  };

  if (!open) {
    const label = unread > 0 ? t("chats.openUnread", { count: unread }) : running ? t("chats.openRunning") : t("chats.open");
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => onOpenChange(true)}
        className={cn(
          "fixed bottom-4 right-4 z-30 flex size-12 items-center justify-center rounded-full",
          "border border-[var(--line-strong)] bg-[var(--raised)] text-[var(--ink)] shadow-[var(--shadow-pop)]",
          "transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--ink)_10%,var(--raised))]",
          focusRing,
        )}
      >
        <MessageCircle size={20} aria-hidden />
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-[var(--focus)] px-1 text-center text-[11px] font-semibold leading-5 text-[var(--canvas)]">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : (
          running && <span className="orc-pulse absolute right-0.5 top-0.5 size-2.5 rounded-full bg-[var(--live)]" aria-hidden />
        )}
      </button>
    );
  }

  const showList = expanded || (paneId === null && !composing);

  return (
    <section
      aria-label={t("chats.title")}
      onKeyDown={(e) => {
        // Only keys pressed inside the window: dialogs it opens live in a portal and handle Escape themselves
        if (e.key === "Escape" && e.currentTarget.contains(e.target as Node) && !e.nativeEvent.isComposing) {
          onOpenChange(false);
        }
      }}
      className={cn(
        "orc-chat-window fixed bottom-4 right-4 z-30 flex flex-col overflow-hidden",
        "rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-pop)]",
        expanded
          ? "h-[min(46rem,calc(100vh-2rem))] w-[min(60rem,calc(100vw-2rem))]"
          : "h-[min(36rem,calc(100vh-2rem))] w-[min(26rem,calc(100vw-2rem))]",
      )}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-[var(--line)] py-2 pl-4 pr-2">
        <h1 className="flex-1 text-[14px] font-semibold tracking-tight text-[var(--ink)]">{t("chats.title")}</h1>
        {unread > 0 && !showList && (
          <IconButton icon={CheckCheck} label={t("chats.list.action.markAllRead")} size="sm" onClick={() => void api.markAllChatsRead().then(onChanged).catch(() => undefined)} />
        )}
        <NewChatButton agents={agents} projects={projects} onStart={startWith} />
        <IconButton
          icon={expanded ? Minimize2 : Maximize2}
          label={expanded ? t("chats.shrink") : t("chats.expand")}
          size="sm"
          onClick={() => onExpandedChange(!expanded)}
        />
        <IconButton icon={Minus} label={t("chats.minimize")} size="sm" onClick={() => onOpenChange(false)} />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* min-w-0 on the list: a flex item never shrinks below its content, so one long title would
            push the right edge of the list (menu buttons, time) out of the window */}
        {showList && (
          <aside className={cn("flex min-h-0 min-w-0 flex-col", expanded ? "w-72 shrink-0 border-r border-[var(--line)]" : "flex-1")}>
            <QuickAgentBar agents={agents} projects={projects} onStart={startWith} />
            <ChatList chats={chats} projects={projects} selectedId={composing ? null : selectedId} onSelect={select} onChanged={onChanged} />
          </aside>
        )}
        {paneId !== null ? (
          <ChatPane
            key={paneId}
            chatId={paneId}
            projects={projects}
            onChanged={onChanged}
            onDeleted={() => {
              select(null);
              onChanged();
            }}
            onLeave={() => select(null)}
            onOpenTask={onOpenTask}
            onBack={expanded ? undefined : () => select(null)}
            onNewChatWith={startWith}
          />
        ) : (
          composing && (
            <NewChatPane
              draft={composing}
              projects={projects}
              onAgentChange={(agent) => setStarted(draftFor(agent, projects, selectedId, composing.projectId))}
              onProjectChange={(projectId) => setStarted({ ...composing, projectId })}
              onCreated={(chat) => {
                onChanged();
                setCreated(chat.id);
                select(chat.id);
              }}
              onBack={expanded ? undefined : () => select(null)}
            />
          )
        )}
      </div>
    </section>
  );
}
