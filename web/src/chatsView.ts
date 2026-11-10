import type { Chat } from "./types";

/**
 * How the chat list is shown: a status filter, a search and a grouping. It is a per-browser
 * preference, so it lives in localStorage. Storage can be unavailable (private mode, blocked
 * data), so every access is guarded and a failure just means the default view.
 */
export type ChatFilter = "all" | "unread" | "working" | "waiting" | "archived";
export type ChatGroup = "none" | "agent" | "project" | "status";
/** Where a chat stands, most pressing first: it orders the sections of the "status" grouping. */
export type ChatState = "waiting" | "working" | "unread" | "idle";

export interface ChatView {
  filter: ChatFilter;
  group: ChatGroup;
  query: string;
}

export const DEFAULT_CHAT_VIEW: ChatView = { filter: "all", group: "none", query: "" };

export const CHAT_FILTERS: ChatFilter[] = ["all", "unread", "working", "waiting", "archived"];
export const CHAT_GROUPS: ChatGroup[] = ["none", "agent", "project", "status"];
export const CHAT_STATES: ChatState[] = ["waiting", "working", "unread", "idle"];

const VIEW_KEY = "orc.chats.view";

export function readChatView(): ChatView {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as Partial<ChatView> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_CHAT_VIEW;
    return {
      filter: CHAT_FILTERS.includes(raw.filter as ChatFilter) ? (raw.filter as ChatFilter) : DEFAULT_CHAT_VIEW.filter,
      group: CHAT_GROUPS.includes(raw.group as ChatGroup) ? (raw.group as ChatGroup) : DEFAULT_CHAT_VIEW.group,
      query: typeof raw.query === "string" ? raw.query : "",
    };
  } catch {
    return DEFAULT_CHAT_VIEW;
  }
}

export function writeChatView(view: ChatView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // The preference is not worth failing the list over.
  }
}

export const isArchived = (chat: Chat): boolean => !!chat.archived_at;

export function stateOf(chat: Chat): ChatState {
  if (chat.status === "waiting") return "waiting";
  if (chat.status === "running" || chat.status === "queued") return "working";
  return chat.unread > 0 ? "unread" : "idle";
}

function inFilter(chat: Chat, filter: ChatFilter): boolean {
  if (filter === "archived") return isArchived(chat);
  if (isArchived(chat)) return false;
  switch (filter) {
    case "unread":
      return chat.unread > 0;
    case "working":
      return chat.status === "running" || chat.status === "queued";
    case "waiting":
      return chat.status === "waiting";
    default:
      return true;
  }
}

/** How many chats each filter would show: the numbers on the chips. */
export function chatCounts(chats: readonly Chat[]): Record<ChatFilter, number> {
  const counts = { all: 0, unread: 0, working: 0, waiting: 0, archived: 0 };
  for (const filter of CHAT_FILTERS) counts[filter] = chats.filter((c) => inFilter(c, filter)).length;
  return counts;
}

/** True when anything narrows the list, so "nothing found" differs from "no chats". */
export const isChatFiltered = (view: ChatView): boolean => view.filter !== "all" || view.query.trim() !== "";

export interface ChatNames {
  agent: (id: number) => string;
  project: (id: number | null) => string;
}

/** The chats a view shows, pinned ones first; the given order (latest activity first) is kept otherwise. */
export function visibleChats(chats: readonly Chat[], view: ChatView, names: ChatNames): Chat[] {
  const q = view.query.trim().toLowerCase();
  const shown = chats.filter((c) => {
    if (!inFilter(c, view.filter)) return false;
    if (!q) return true;
    return `${c.title} ${c.last_message ?? ""} ${names.agent(c.agent_id)} ${names.project(c.project_id)}`.toLowerCase().includes(q);
  });
  // Array.sort is stable, so equal chats keep the order they came in
  return shown.sort((a, b) => b.pinned - a.pinned);
}

export interface ChatSection {
  key: string;
  /** null — no heading (the list is not grouped). */
  label: string | null;
  chats: Chat[];
}

export interface GroupLabels extends ChatNames {
  state: (state: ChatState) => string;
}

/** Splits the (already ordered) list into sections; order inside a section is kept. */
export function groupChats(chats: readonly Chat[], group: ChatGroup, labels: GroupLabels): ChatSection[] {
  if (group === "none") return [{ key: "all", label: null, chats: [...chats] }];
  const sections = new Map<string, ChatSection>();
  for (const chat of chats) {
    const [key, label] =
      group === "agent"
        ? [`a${chat.agent_id}`, labels.agent(chat.agent_id)]
        : group === "project"
          ? [`p${chat.project_id ?? "none"}`, labels.project(chat.project_id)]
          : [`s${stateOf(chat)}`, labels.state(stateOf(chat))];
    const section = sections.get(key) ?? { key, label, chats: [] };
    section.chats.push(chat);
    sections.set(key, section);
  }
  const list = [...sections.values()];
  // Statuses have a fixed order of urgency; agents and projects follow the latest activity
  return group === "status" ? list.sort((a, b) => CHAT_STATES.findIndex((s) => `s${s}` === a.key) - CHAT_STATES.findIndex((s) => `s${s}` === b.key)) : list;
}
