import { useMemo, useRef, useState } from "react";
import { CheckCheck, MessageSquare, Pin, Search } from "lucide-react";
import { api } from "../api";
import { useAgents } from "../agents";
import { ACTIVE } from "../chats";
import {
  CHAT_FILTERS, CHAT_GROUPS, chatCounts, groupChats, isArchived, isChatFiltered, readChatView, stateOf, visibleChats, writeChatView,
  type ChatFilter, type ChatGroup, type ChatState, type ChatView,
} from "../chatsView";
import { relativeTime } from "../dates";
import { useNow } from "../hooks/useNow";
import { useTranslation } from "../i18n";
import { cn } from "../lib/cn";
import type { Agent, Chat, Project } from "../types";
import { Button } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { Input, Select } from "../ui/Field";
import { focusRing } from "../ui/tokens";
import { AgentAvatar } from "./AgentAvatar";
import { ChatMenu } from "./ChatMenu";

interface Props {
  chats: Chat[];
  projects: Project[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** The list changed on the server (pin, archive, read marks, rename, delete): fetch it again. */
  onChanged: () => void;
}

/** The colour of what a chat is doing: it answers "does this one want me?" before the text is read. */
const STATE_DOT: Record<ChatState, string> = {
  waiting: "bg-[var(--warn)]",
  working: "bg-[var(--focus)]",
  unread: "bg-[var(--focus)]",
  idle: "bg-transparent",
};

interface RowProps {
  chat: Chat;
  agent: Agent | undefined;
  project: Project | undefined;
  selected: boolean;
  onSelect: () => void;
  onChanged: () => void;
  onDelete: () => void;
  /** The chat has to be left after the action: an open chat marks itself read again at once. */
  onLeave: () => void;
}

function ChatRow({ chat, agent, project, selected, onSelect, onChanged, onDelete, onLeave }: RowProps) {
  const { t, language } = useTranslation();
  const now = useNow();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  // Enter closes the field and the blur that follows must not send the name a second time
  const closed = useRef(true);
  const [error, setError] = useState<string | null>(null);

  const archived = isArchived(chat);
  const state = stateOf(chat);
  const title = chat.title || agent?.name || t("chats.untitled");
  const at = Date.parse(chat.updated_at);
  // What the agent is doing outranks what it said last: the row answers "is it still on it?"
  const status =
    chat.status === "waiting" ? t("chats.listWaiting") : chat.status === "queued" ? t("chats.statusQueued") : chat.status === "running" ? t("chats.statusRunning", { name: agent?.name ?? "" }) : null;

  const rename = (next: string) => {
    setError(null);
    api.renameChat(chat.id, next).then(onChanged).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const finishRename = (commit: boolean) => {
    if (closed.current) return;
    closed.current = true;
    setRenaming(false);
    const next = draft.trim();
    if (commit && next && next !== title) rename(next);
  };

  return (
    <li className="group relative">
      {renaming ? (
        <div className="flex items-center gap-2.5 px-2 py-2">
          {agent && <AgentAvatar agent={agent} size={32} />}
          <input
            autoFocus
            aria-label={t("chats.rename")}
            value={draft}
            maxLength={200}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => finishRename(true)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") finishRename(true);
              else if (e.key === "Escape") {
                // The window closes on Escape; here it only leaves the field
                e.stopPropagation();
                finishRename(false);
              }
            }}
            className="h-7 w-full min-w-0 rounded-[var(--radius-sm)] border border-[var(--focus)] bg-[var(--sunken)] px-1.5 text-[13px] font-medium text-[var(--ink)] focus:outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          aria-current={selected ? "page" : undefined}
          onClick={onSelect}
          className={cn(
            "flex w-full items-start gap-2.5 rounded-[var(--radius-sm)] py-2 pl-2 pr-8 text-left transition-colors duration-100",
            focusRing,
            selected ? "bg-[color-mix(in_oklab,var(--ink)_10%,transparent)]" : "hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]",
            archived && "opacity-70",
          )}
        >
          {agent && <AgentAvatar agent={agent} size={32} className="mt-0.5" />}
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              {chat.pinned > 0 && <Pin size={11} aria-label={t("chats.list.pinned")} className="shrink-0 self-center text-[var(--ink-faint)]" />}
              <span className={cn("truncate text-[13px] text-[var(--ink)]", chat.unread > 0 && !selected ? "font-semibold" : "font-medium")}>{title}</span>
              {!Number.isNaN(at) && (
                <span className="ml-auto shrink-0 text-[10px] text-[var(--ink-faint)]">
                  {relativeTime(at, language, now)}
                </span>
              )}
            </span>
            <span className="flex items-center gap-1.5">
              <span className={cn("min-w-0 flex-1 truncate text-[12px]", status ? (chat.status === "waiting" ? "text-[var(--warn)]" : "text-[var(--focus)]") : "text-[var(--ink-muted)]")}>
                {status ?? chat.last_message ?? ""}
              </span>
              {ACTIVE.has(chat.status) && <span className={cn("orc-pulse size-1.5 shrink-0 rounded-full", STATE_DOT[state])} aria-hidden />}
              {chat.unread > 0 && !selected && (
                <span className="shrink-0 rounded-full bg-[var(--focus)] px-1.5 text-[10px] font-semibold leading-4 text-[var(--canvas)]">{chat.unread}</span>
              )}
            </span>
            <span className="block truncate text-[11px] text-[var(--ink-faint)]">
              {archived && `${t("chats.list.archivedBadge")} · `}
              {agent?.name}
              {project ? ` · ${project.name}` : ""}
            </span>
            {error && <span className="block truncate text-[11px] text-[var(--danger)]">{error}</span>}
          </span>
        </button>
      )}
      {!renaming && (
        <ChatMenu
          chat={chat}
          open={selected}
          onChanged={onChanged}
          onLeave={onLeave}
          onError={setError}
          onDelete={onDelete}
          onRename={() => {
            setDraft(title);
            closed.current = false;
            setRenaming(true);
          }}
          className="absolute right-1 top-1.5"
        />
      )}
    </li>
  );
}

/** Search, status chips and grouping above the list. */
function Toolbar({ view, counts, onChange, unread, onReadAll }: { view: ChatView; counts: Record<ChatFilter, number>; onChange: (patch: Partial<ChatView>) => void; unread: number; onReadAll: () => void }) {
  const { t } = useTranslation();
  // A chip with nothing behind it is noise, except "All" and the one that is on
  const filters = CHAT_FILTERS.filter((f) => f === "all" || f === view.filter || counts[f] > 0);
  return (
    <div className="shrink-0 space-y-1.5 border-b border-[var(--line)] px-2 py-2">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search size={13} aria-hidden className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-faint)]" />
          <Input
            type="search"
            aria-label={t("chats.list.search")}
            placeholder={t("chats.list.search")}
            value={view.query}
            onChange={(e) => onChange({ query: e.target.value })}
            className="h-7 pl-7 text-[12px]"
          />
        </div>
        <Select
          aria-label={t("chats.list.groupLabel")}
          value={view.group}
          onChange={(e) => onChange({ group: e.target.value as ChatGroup })}
          className="h-7 w-32 text-[12px]"
        >
          {CHAT_GROUPS.map((g) => (
            <option key={g} value={g}>
              {t(`chats.list.group.${g}`)}
            </option>
          ))}
        </Select>
      </div>
      <div role="radiogroup" aria-label={t("chats.list.filtersLabel")} className="flex flex-wrap items-center gap-1">
        {filters.map((f) => {
          const on = f === view.filter;
          return (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange({ filter: f })}
              className={cn(
                "flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors duration-100",
                focusRing,
                on
                  ? "border-transparent bg-[var(--ink)] text-[var(--canvas)]"
                  : "border-[var(--line)] text-[var(--ink-muted)] hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]",
              )}
            >
              {t(`chats.list.filter.${f}`)}
              <span className={cn("tabular-nums", on ? "opacity-70" : "text-[var(--ink-faint)]")}>{counts[f]}</span>
            </button>
          );
        })}
        {unread > 0 && (
          <button
            type="button"
            onClick={onReadAll}
            title={t("chats.list.action.markAllRead")}
            aria-label={t("chats.list.action.markAllRead")}
            className={cn("ml-auto flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--ink-muted)] hover:bg-[color-mix(in_oklab,var(--ink)_8%,transparent)]", focusRing)}
          >
            <CheckCheck size={14} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

export function ChatList({ chats, projects, selectedId, onSelect, onChanged }: Props) {
  const { t } = useTranslation();
  const agents = useAgents();
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const [view, setViewState] = useState<ChatView>(readChatView);
  const [deleting, setDeleting] = useState<Chat | null>(null);
  const setView = (patch: Partial<ChatView>) => {
    const next = { ...view, ...patch };
    setViewState(next);
    writeChatView(next);
  };

  const names = useMemo(
    () => ({
      agent: (id: number) => agentById.get(id)?.name ?? "",
      project: (id: number | null) => (id === null ? t("chats.list.noProject") : (projects.find((p) => p.id === id)?.name ?? "")),
    }),
    [agentById, projects, t],
  );
  const counts = useMemo(() => chatCounts(chats), [chats]);
  const unread = chats.reduce((sum, c) => (isArchived(c) ? sum : sum + c.unread), 0);
  const sections = useMemo(
    () => groupChats(visibleChats(chats, view, names), view.group, { ...names, state: (s) => t(`chats.list.state.${s}`) }),
    [chats, view, names, t],
  );
  const shown = sections.reduce((n, s) => n + s.chats.length, 0);

  if (chats.length === 0) {
    return (
      <div className="m-auto max-w-sm px-5 py-10 text-center">
        <MessageSquare size={22} className="mx-auto mb-2 text-[var(--ink-faint)]" aria-hidden />
        <p className="text-[14px] font-medium text-[var(--ink)]">{t("chats.empty")}</p>
        <p className="mt-1 text-[12px] leading-snug text-[var(--ink-muted)]">{agents.length === 0 ? t("chats.noAgents") : t("chats.emptyHint")}</p>
      </div>
    );
  }

  const readAll = () => void api.markAllChatsRead().then(onChanged).catch(() => undefined);

  return (
    <>
      <Toolbar view={view} counts={counts} onChange={setView} unread={unread} onReadAll={readAll} />
      {shown === 0 ? (
        <div className="m-auto max-w-xs px-5 py-8 text-center">
          <p className="text-[12px] leading-snug text-[var(--ink-muted)]">
            {view.filter === "archived" && view.query.trim() === "" ? t("chats.list.emptyArchive") : t("chats.list.noMatches")}
          </p>
          {isChatFiltered(view) && (
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => setView({ filter: "all", query: "" })}>
              {t("chats.list.resetFilters")}
            </Button>
          )}
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 py-1.5">
          {sections.map((section) => (
            <section key={section.key} aria-label={section.label ?? undefined}>
              {section.label !== null && (
                <h2 className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-faint)]">
                  {section.label} <span className="tabular-nums">{section.chats.length}</span>
                </h2>
              )}
              <ul>
                {section.chats.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    agent={agentById.get(chat.agent_id)}
                    project={projects.find((p) => p.id === chat.project_id)}
                    selected={chat.id === selectedId}
                    onSelect={() => onSelect(chat.id)}
                    onChanged={onChanged}
                    onDelete={() => setDeleting(chat)}
                    onLeave={() => onSelect(null)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <Confirm
        open={deleting !== null}
        title={t("chats.deleteTitle")}
        confirmLabel={t("common.delete")}
        confirmVariant="danger"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const chat = deleting;
          setDeleting(null);
          if (!chat) return;
          void api.deleteChat(chat.id).then(() => {
            if (chat.id === selectedId) onSelect(null);
            onChanged();
          });
        }}
      >
        {deleting?.branch ? t("chats.deleteBodyBranch", { branch: deleting.branch }) : t("chats.deleteBody")}
      </Confirm>
    </>
  );
}
