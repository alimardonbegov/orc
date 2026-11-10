import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, FolderGit2, ListPlus, Pin, X } from "lucide-react";
import { api } from "../api";
import { useAgents } from "../agents";
import { ACTIVE, canAutoFocus, useChatDraft } from "../chats";
import { stateOf } from "../chatsView";
import { usePolling } from "../hooks/usePolling";
import type { Agent, Chat, ChatMessage, InputDecision, Project } from "../types";
import { Button, IconButton } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { AgentAvatar } from "./AgentAvatar";
import { AgentChoice } from "./ChatChoices";
import { ChatComposer } from "./ChatComposer";
import { ChatMenu } from "./ChatMenu";
import { focusRing } from "../ui/tokens";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";
import { InputRequestPanel } from "./InputRequestPanel";
import { Linkified } from "./Linkified";
import { Markdown } from "./Markdown";
import { SpeakButton } from "./SpeakButton";

const POLL_MS = 1500;
/** Shorter messages are quicker to read than to start the voice for. */
const SPEAK_MIN_CHARS = 100;

function Proposal({ chat, message, onDone, onOpenTask }: { chat: Chat; message: ChatMessage; onDone: () => void; onOpenTask: (id: number) => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const proposal = message.proposal;
  if (!proposal) return null;
  const act = (run: () => Promise<unknown>) => {
    setError(null);
    run().then(onDone).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface)] p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)]">{t("chats.proposalHeading")}</p>
      <p className="mt-1 text-[13px] font-semibold text-[var(--ink)]">{proposal.title}</p>
      {proposal.description && <p className="mt-1 whitespace-pre-wrap text-[12px] leading-snug text-[var(--ink-muted)]">{proposal.description}</p>}
      {proposal.agent && <p className="mt-1 text-[11px] text-[var(--ink-faint)]">{t("chats.proposalAgent", { name: proposal.agent })}</p>}
      {proposal.waits_for && proposal.waits_for.length > 0 && (
        <p className="mt-1 text-[11px] text-[var(--ink-faint)]">{t("chats.proposalWaitsFor", { tasks: proposal.waits_for.join("; ") })}</p>
      )}
      {message.state === "open" && proposal.depends_on_messages && proposal.depends_on_messages.length > 0 && (
        <p className="mt-1 text-[11px] text-[var(--ink-faint)]">{t("chats.proposalAcceptsChain")}</p>
      )}
      {message.state === "open" ? (
        <div className="mt-2 flex items-center gap-1.5">
          <Button size="sm" variant="secondary" icon={ListPlus} onClick={() => act(() => api.acceptProposal(chat.id, message.id))}>
            {t("chats.accept")}
          </Button>
          <Button size="sm" variant="ghost" icon={X} onClick={() => act(() => api.dismissProposal(chat.id, message.id))}>
            {t("chats.dismiss")}
          </Button>
        </div>
      ) : message.state === "accepted" && proposal.task_id ? (
        <button
          type="button"
          className={cn("mt-2 flex items-center gap-1 rounded-[var(--radius-sm)] text-[12px] text-[var(--ink-muted)] underline-offset-2 hover:underline", focusRing)}
          onClick={() => onOpenTask(proposal.task_id as number)}
        >
          <Check size={12} aria-hidden />
          {t("chats.accepted", { id: proposal.task_id })}
        </button>
      ) : (
        <p className="mt-2 text-[12px] text-[var(--ink-faint)]">{t("chats.dismissed")}</p>
      )}
      {error && <p className="mt-1 text-[12px] text-[var(--danger)]">{error}</p>}
    </div>
  );
}

/** Consecutive tool calls fold into one line: the owner reads the replies, the steps are there if needed. */
function groupMessages(messages: ChatMessage[]): (ChatMessage | ChatMessage[])[] {
  const out: (ChatMessage | ChatMessage[])[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (m.role === "activity" && Array.isArray(last)) last.push(m);
    else out.push(m.role === "activity" ? [m] : m);
  }
  return out;
}

/** What the session waits for. While open the owner decides here; afterwards it stays as one quiet line. */
function InputRequestMessage({ chat, message, onDone }: { chat: Chat; message: ChatMessage; onDone: () => void }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = message.request;
  if (!request) return null;
  if (message.state !== "open") {
    return (
      <p className="text-center text-[11px] text-[var(--ink-faint)]">
        {t(message.state === "answered" ? "chats.inputAnswered" : "chats.inputCancelled", { summary: request.summary })}
      </p>
    );
  }
  const decide = async (decision: InputDecision) => {
    setPending(true);
    setError(null);
    try {
      await api.answerChatInput(chat.id, message.id, decision);
      onDone();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-1">
      <InputRequestPanel request={request} pending={pending} onDecide={decide} />
      {error && <p className="text-[12px] text-[var(--danger)]">{error}</p>}
    </div>
  );
}

function Conversation({ chat, agent, messages, onRefresh, onOpenTask }: { chat: Chat; agent: Agent | undefined; messages: ChatMessage[]; onRefresh: () => void; onOpenTask: (id: number) => void }) {
  const { t } = useTranslation();
  const bottom = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1]?.id;
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [last, chat.status]);

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
      {groupMessages(messages).map((item) => {
        if (Array.isArray(item)) {
          return (
            <details key={item[0].id} className="text-[11px] text-[var(--ink-faint)]">
              <summary className="cursor-pointer select-none">{t("chats.steps", { count: item.length })}</summary>
              <ul className="mt-1 space-y-0.5 border-l border-[var(--line)] pl-2 font-mono">
                {item.map((m) => (
                  <li key={m.id} className="break-all">
                    {m.body}
                  </li>
                ))}
              </ul>
            </details>
          );
        }
        if (item.role === "proposal") {
          return <Proposal key={item.id} chat={chat} message={item} onDone={onRefresh} onOpenTask={onOpenTask} />;
        }
        if (item.role === "input_request") {
          return <InputRequestMessage key={item.id} chat={chat} message={item} onDone={onRefresh} />;
        }
        if (item.role === "system") {
          return (
            <p key={item.id} className="text-center text-[11px] text-[var(--ink-faint)]">
              {item.body}
            </p>
          );
        }
        if (item.role === "user") {
          return (
            <div key={item.id} className="ml-auto w-fit max-w-[80%]">
              <p className="whitespace-pre-wrap rounded-[var(--radius-md)] bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] px-3 py-2 text-[13px] leading-relaxed text-[var(--ink)]">
                <Linkified text={item.body} />
              </p>
              {item.state !== "sent" && (
                <p className={cn("mt-0.5 text-right text-[11px]", item.state === "failed" ? "text-[var(--danger)]" : "text-[var(--ink-faint)]")}>
                  {t(`chats.messageState.${item.state}`)}
                </p>
              )}
            </div>
          );
        }
        return (
          <div key={item.id} className="flex max-w-[90%] gap-2.5">
            {agent && <AgentAvatar agent={agent} size={24} className="mt-0.5" />}
            <div className="min-w-0">
              {item.body.length >= SPEAK_MIN_CHARS && <SpeakButton text={item.body} className="-ml-1.5 mb-0.5" />}
              <Markdown text={item.body} className="text-[13px] leading-relaxed text-[var(--ink)]" />
            </div>
          </div>
        );
      })}
      {chat.status === "waiting" && messages.some((m) => m.role === "input_request" && m.state === "open") ? null : chat.status === "waiting" ? (
        <p className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--warn)_14%,transparent)] px-3 py-2 text-[12px] leading-snug text-[var(--warn)]">
          {t("chats.statusWaiting", { detail: chat.waiting_detail ?? "" })}
        </p>
      ) : ACTIVE.has(chat.status) ? (
        <p className="animate-pulse text-[12px] text-[var(--ink-faint)]">
          {chat.status === "queued" ? t("chats.statusQueued") : t("chats.statusRunning", { name: agent?.name ?? "" })}
        </p>
      ) : null}
      <div ref={bottom} />
    </div>
  );
}

/** The field a title turns into: Enter keeps the new name, Escape and a click away keep the old one. */
function TitleField({ initial, onDone }: { initial: string; onDone: (next: string | null) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  // Enter closes the field and the blur that follows must not send the name a second time
  const closed = useRef(false);
  const finish = (commit: boolean) => {
    if (closed.current) return;
    closed.current = true;
    const next = draft.trim();
    onDone(commit && next && next !== initial ? next : null);
  };
  return (
    <input
      autoFocus
      aria-label={t("chats.rename")}
      value={draft}
      maxLength={200}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") {
          // The window closes on Escape; here it only leaves the field
          e.stopPropagation();
          finish(false);
        }
      }}
      className="h-6 w-full min-w-0 rounded-[var(--radius-sm)] border border-[var(--focus)] bg-[var(--sunken)] px-1.5 text-[13px] font-semibold text-[var(--ink)] focus:outline-none"
    />
  );
}

/** The title of a chat, renamed in place: a click (or "Rename" in the menu) turns it into a field. */
function ChatTitle({ chat, fallback, editing, setEditing, onRename }: { chat: Chat; fallback: string; editing: boolean; setEditing: (editing: boolean) => void; onRename: (title: string) => void }) {
  const { t } = useTranslation();
  const title = chat.title || fallback;
  if (editing) {
    return (
      <TitleField
        initial={title}
        onDone={(next) => {
          setEditing(false);
          if (next) onRename(next);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      title={t("chats.rename")}
      onClick={() => setEditing(true)}
      className={cn("block max-w-full truncate rounded-[var(--radius-sm)] text-left text-[13px] font-semibold text-[var(--ink)] hover:text-[var(--ink-muted)]", focusRing)}
    >
      {title}
    </button>
  );
}

export function ChatPane({ chatId, projects, onChanged, onDeleted, onLeave, onOpenTask, onBack, onNewChatWith }: { chatId: number; projects: Project[]; onChanged: () => void; onDeleted: () => void; onLeave: () => void; onOpenTask: (id: number) => void; onBack?: () => void; onNewChatWith?: (agent: Agent) => void }) {
  const { t } = useTranslation();
  const agents = useAgents();
  const { data: chat, refresh } = usePolling(() => api.chat(chatId), POLL_MS, [chatId]);
  const [text, setText] = useChatDraft(chatId);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const lastId = chat?.messages[chat.messages.length - 1]?.id ?? 0;
  const lastRead = chat?.last_read_message_id;

  // The chat is on screen, so what it holds has been seen
  useEffect(() => {
    if (lastRead !== undefined && lastId > lastRead) {
      void api.markChatRead(chatId, lastId).then(onChanged).catch(() => undefined);
    }
  }, [chatId, lastId, lastRead, onChanged]);

  if (!chat || chat.id !== chatId) return <div className="flex-1" />;
  const agent = agents.find((a) => a.id === chat.agent_id);
  const project = projects.find((p) => p.id === chat.project_id);
  const busy = ACTIVE.has(chat.status);
  const state = stateOf(chat);

  async function send() {
    const body = text.trim();
    if (!body) return;
    setText("");
    setError(null);
    try {
      await api.sendChatMessage(chatId, body);
      await refresh();
      onChanged();
    } catch (e) {
      setText(body);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function rename(title: string) {
    setError(null);
    try {
      await api.renameChat(chatId, title);
      await refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] py-2 pl-3 pr-2">
        {onBack && <IconButton icon={ArrowLeft} label={t("chats.back")} size="sm" onClick={onBack} />}
        {agent && <AgentAvatar agent={agent} size={28} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {chat.pinned > 0 && <Pin size={11} aria-label={t("chats.list.pinned")} className="shrink-0 text-[var(--ink-faint)]" />}
            <div className="min-w-0 flex-1">
              <ChatTitle chat={chat} fallback={agent?.name ?? t("chats.untitled")} editing={renaming} setEditing={setRenaming} onRename={(title) => void rename(title)} />
            </div>
          </div>
          <p className="flex items-center gap-1 truncate text-[11px] text-[var(--ink-faint)]">
            {(state === "waiting" || state === "working") && (
              <span className={cn("flex shrink-0 items-center gap-1 font-medium", state === "waiting" ? "text-[var(--warn)]" : "text-[var(--focus)]")}>
                {busy && <span className="orc-pulse size-1.5 rounded-full bg-current" aria-hidden />}
                {t(`chats.list.state.${state}`)}
                {" · "}
              </span>
            )}
            {chat.archived_at && <span className="shrink-0">{t("chats.list.archivedBadge")}{" · "}</span>}
            <span className="truncate">
              {agent?.name}
              {project && ` · ${project.name}`}
            </span>
            {chat.branch && (
              <span className="flex min-w-0 items-center gap-1 font-mono" title={t("chats.isolationHint", { branch: chat.branch })}>
                <FolderGit2 size={11} aria-hidden className="shrink-0" />
                <span className="truncate">{chat.branch}</span>
              </span>
            )}
          </p>
        </div>
        <ChatMenu
          chat={chat}
          open
          onChanged={() => {
            void refresh();
            onChanged();
          }}
          onLeave={onLeave}
          onError={setError}
          onRename={() => setRenaming(true)}
          onDelete={() => setConfirmDelete(true)}
        />
      </header>

      {chat.messages.length === 0 ? (
        <div className="m-auto max-w-sm px-5 text-center text-[12px] leading-snug text-[var(--ink-muted)]">
          {project ? t("chats.startHintProject", { project: project.name }) : t("chats.startHintScratch")}
        </div>
      ) : (
        <Conversation chat={chat} agent={agent} messages={chat.messages} onRefresh={() => void refresh()} onOpenTask={onOpenTask} />
      )}

      <ChatComposer
        value={text}
        onChange={setText}
        onSubmit={() => void send()}
        running={busy}
        onStop={() => void api.stopChat(chatId).then(() => refresh())}
        placeholder={t("chats.placeholder")}
        error={error}
        autoFocus={canAutoFocus()}
        leading={agent && onNewChatWith ? <AgentChoice agents={agents} projects={projects} value={agent} onChange={(next) => next.id !== agent.id && onNewChatWith(next)} /> : undefined}
      />

      <Confirm
        open={confirmDelete}
        title={t("chats.deleteTitle")}
        confirmLabel={t("common.delete")}
        confirmVariant="danger"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void api.deleteChat(chatId).then(onDeleted);
        }}
      >
        {chat.branch ? t("chats.deleteBodyBranch", { branch: chat.branch }) : t("chats.deleteBody")}
      </Confirm>
    </div>
  );
}
