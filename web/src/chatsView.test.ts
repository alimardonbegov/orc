import { beforeEach, describe, expect, it } from "vitest";
import type { Chat } from "./types";
import {
  DEFAULT_CHAT_VIEW, chatCounts, groupChats, readChatView, stateOf, visibleChats, writeChatView, type ChatView,
} from "./chatsView";

const chat = (id: number, over: Partial<Chat> = {}): Chat => ({
  id, agent_id: 1, project_id: null, title: `Chat ${id}`, status: "idle", cwd: null, branch: null, job_id: null,
  session_id: null, turn_started_at: null, waiting_detail: null, last_read_message_id: 0, created_at: "", updated_at: "",
  last_message: null, unread: 0, pinned: 0, archived_at: null, ...over,
});

const names = { agent: (id: number) => (id === 1 ? "Ann" : "Bob"), project: (id: number | null) => (id === null ? "No project" : `P${id}`) };
const view = (over: Partial<ChatView> = {}): ChatView => ({ ...DEFAULT_CHAT_VIEW, ...over });

beforeEach(() => localStorage.clear());

describe("filters", () => {
  const all = [
    chat(1, { unread: 2 }),
    chat(2, { status: "running" }),
    chat(3, { status: "queued" }),
    chat(4, { status: "waiting" }),
    chat(5, { archived_at: "2026-01-01", unread: 1 }),
    chat(6),
  ];

  it("keeps archived chats out of every list but their own", () => {
    expect(visibleChats(all, view(), names).map((c) => c.id)).toEqual([1, 2, 3, 4, 6]);
    expect(visibleChats(all, view({ filter: "archived" }), names).map((c) => c.id)).toEqual([5]);
    expect(visibleChats(all, view({ filter: "unread" }), names).map((c) => c.id)).toEqual([1]);
  });

  it("separates working from waiting for the owner", () => {
    expect(visibleChats(all, view({ filter: "working" }), names).map((c) => c.id)).toEqual([2, 3]);
    expect(visibleChats(all, view({ filter: "waiting" }), names).map((c) => c.id)).toEqual([4]);
  });

  it("counts what each chip would show", () => {
    expect(chatCounts(all)).toEqual({ all: 5, unread: 1, working: 2, waiting: 1, archived: 1 });
  });

  it("searches title, last message, agent and project", () => {
    const list = [chat(1, { title: "Login bug" }), chat(2, { last_message: "see the migration" }), chat(3, { agent_id: 2 }), chat(4, { project_id: 7 })];
    expect(visibleChats(list, view({ query: "login" }), names).map((c) => c.id)).toEqual([1]);
    expect(visibleChats(list, view({ query: "MIGRATION" }), names).map((c) => c.id)).toEqual([2]);
    expect(visibleChats(list, view({ query: "bob" }), names).map((c) => c.id)).toEqual([3]);
    expect(visibleChats(list, view({ query: "p7" }), names).map((c) => c.id)).toEqual([4]);
  });
});

it("puts pinned chats first and otherwise keeps the order", () => {
  const list = [chat(1), chat(2, { pinned: 1 }), chat(3), chat(4, { pinned: 1 })];
  expect(visibleChats(list, view(), names).map((c) => c.id)).toEqual([2, 4, 1, 3]);
});

describe("grouping", () => {
  const labels = { ...names, state: (s: string) => s };

  it("does not group by default", () => {
    expect(groupChats([chat(1), chat(2)], "none", labels)).toEqual([{ key: "all", label: null, chats: [chat(1), chat(2)] }]);
  });

  it("groups by agent in order of appearance", () => {
    const sections = groupChats([chat(1, { agent_id: 2 }), chat(2), chat(3, { agent_id: 2 })], "agent", labels);
    expect(sections.map((s) => [s.label, s.chats.map((c) => c.id)])).toEqual([["Bob", [1, 3]], ["Ann", [2]]]);
  });

  it("groups by project, with a section for chats outside any", () => {
    const sections = groupChats([chat(1, { project_id: 3 }), chat(2)], "project", labels);
    expect(sections.map((s) => s.label)).toEqual(["P3", "No project"]);
  });

  it("orders status sections by urgency, not by recency", () => {
    const sections = groupChats([chat(1), chat(2, { unread: 1 }), chat(3, { status: "running" }), chat(4, { status: "waiting" })], "status", labels);
    expect(sections.map((s) => s.label)).toEqual(["waiting", "working", "unread", "idle"]);
  });
});

it("reads a state that beats the rest: waiting over working over unread", () => {
  expect(stateOf(chat(1, { status: "waiting", unread: 3 }))).toBe("waiting");
  expect(stateOf(chat(1, { status: "queued", unread: 3 }))).toBe("working");
  expect(stateOf(chat(1, { unread: 3 }))).toBe("unread");
});

describe("saved view", () => {
  it("round-trips and ignores garbage", () => {
    writeChatView({ filter: "unread", group: "agent", query: "x" });
    expect(readChatView()).toEqual({ filter: "unread", group: "agent", query: "x" });
    localStorage.setItem("orc.chats.view", JSON.stringify({ filter: "nope", group: 5, query: 1 }));
    expect(readChatView()).toEqual(DEFAULT_CHAT_VIEW);
    localStorage.setItem("orc.chats.view", "{broken");
    expect(readChatView()).toEqual(DEFAULT_CHAT_VIEW);
  });
});
