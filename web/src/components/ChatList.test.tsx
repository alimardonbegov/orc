import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentsContext } from "../agents";
import { api } from "../api";
import type { Agent, Chat, Project } from "../types";
import { ChatList } from "./ChatList";

vi.mock("../api", () => ({
  api: {
    updateChat: vi.fn(async () => ({})),
    renameChat: vi.fn(async () => ({})),
    deleteChat: vi.fn(async () => ({ deleted: 1 })),
    markChatRead: vi.fn(async () => ({ last_read_message_id: 1 })),
    markChatUnread: vi.fn(async () => ({})),
    markAllChatsRead: vi.fn(async () => ({ chats: 1 })),
  },
  ApiError: class extends Error {},
}));

const agent = (id: number, name: string): Agent => ({
  id, name, description: "", avatar: null, model: null, effort: null, permission_mode: null, prompt: "",
  project_id: null, memory_enabled: false, created_at: "", updated_at: "", tasks: { active: 0, total: 0 },
});
const project = { id: 1, name: "Demo", archived_at: null, path_ok: true } as Project;

const chat = (id: number, over: Partial<Chat> = {}): Chat => ({
  id, agent_id: 1, project_id: null, title: `Chat ${id}`, status: "idle", cwd: null, branch: null, job_id: null,
  session_id: null, turn_started_at: null, waiting_detail: null, last_read_message_id: 0, created_at: "", updated_at: "",
  last_message: null, unread: 0, pinned: 0, archived_at: null, ...over,
});

function renderList(chats: Chat[], props: Partial<Parameters<typeof ChatList>[0]> = {}) {
  const onChanged = vi.fn();
  const onSelect = vi.fn();
  render(
    <AgentsContext.Provider value={[agent(1, "Ann"), agent(2, "Bob")]}>
      <ChatList chats={chats} projects={[project]} selectedId={null} onSelect={onSelect} onChanged={onChanged} {...props} />
    </AgentsContext.Provider>,
  );
  return { onChanged, onSelect };
}

const titles = () => screen.getAllByRole("button", { name: /^Chat \d/ }).map((b) => within(b).getByText(/^Chat \d/).textContent);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

it("hides archived chats until the Archived chip is picked, and counts the chips", async () => {
  renderList([chat(1), chat(2, { archived_at: "2026-01-01" }), chat(3, { unread: 2 })]);
  expect(titles()).toEqual(["Chat 1", "Chat 3"]);
  expect(screen.getByRole("radio", { name: /Unread/ })).toHaveTextContent("1");
  await userEvent.click(screen.getByRole("radio", { name: /Archived/ }));
  expect(titles()).toEqual(["Chat 2"]);
});

it("filters by status and remembers the choice", async () => {
  renderList([chat(1), chat(2, { status: "waiting" }), chat(3, { status: "running" })]);
  await userEvent.click(screen.getByRole("radio", { name: /Needs you/ }));
  expect(titles()).toEqual(["Chat 2"]);
  expect(JSON.parse(localStorage.getItem("orc.chats.view") ?? "{}").filter).toBe("waiting");
});

it("searches and offers a way out when nothing matches", async () => {
  renderList([chat(1, { title: "Login" }), chat(2, { title: "Billing" })]);
  await userEvent.type(screen.getByRole("searchbox", { name: "Search chats" }), "bill");
  expect(screen.queryByText("Login")).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search chats" }), "zzz");
  expect(screen.getByText("No chats match these filters.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  expect(screen.getByText("Login")).toBeInTheDocument();
});

it("groups by agent under headings", async () => {
  renderList([chat(1), chat(2, { agent_id: 2 })]);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Group chats" }), "agent");
  expect(screen.getByRole("heading", { name: /Ann/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Bob/ })).toBeInTheDocument();
});

it("pins and archives from the row menu", async () => {
  const { onChanged } = renderList([chat(1)]);
  await userEvent.click(screen.getByRole("button", { name: "Chat actions" }));
  await userEvent.click(screen.getByRole("button", { name: "Pin to the top" }));
  expect(api.updateChat).toHaveBeenCalledWith(1, { pinned: true });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "Chat actions" }));
  await userEvent.click(screen.getByRole("button", { name: "Archive" }));
  expect(api.updateChat).toHaveBeenCalledWith(1, { archived: true });
});

it("marks read or unread depending on the chat, and leaves an open chat marked unread", async () => {
  const { onSelect } = renderList([chat(1, { unread: 2 }), chat(2)], { selectedId: 2 });
  const rows = screen.getAllByRole("listitem");
  await userEvent.click(within(rows[0]).getByRole("button", { name: "Chat actions" }));
  await userEvent.click(screen.getByRole("button", { name: "Mark as read" }));
  expect(api.markChatRead).toHaveBeenCalledWith(1);
  await userEvent.click(within(rows[1]).getByRole("button", { name: "Chat actions" }));
  await userEvent.click(screen.getByRole("button", { name: "Mark as unread" }));
  expect(api.markChatUnread).toHaveBeenCalledWith(2);
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
});

it("renames in place", async () => {
  renderList([chat(1)]);
  await userEvent.click(screen.getByRole("button", { name: "Chat actions" }));
  await userEvent.click(screen.getByRole("button", { name: "Rename" }));
  const field = screen.getByRole("textbox", { name: "Rename chat" });
  await userEvent.clear(field);
  await userEvent.type(field, "Plan{Enter}");
  expect(api.renameChat).toHaveBeenCalledTimes(1);
  expect(api.renameChat).toHaveBeenCalledWith(1, "Plan");
});

it("deletes only after confirmation", async () => {
  const { onChanged } = renderList([chat(1, { branch: "orc/chat-1" })]);
  await userEvent.click(screen.getByRole("button", { name: "Chat actions" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(api.deleteChat).not.toHaveBeenCalled();
  expect(await screen.findByText(/orc\/chat-1/)).toBeInTheDocument();
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(api.deleteChat).toHaveBeenCalledWith(1));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it("marks everything read in one click", async () => {
  renderList([chat(1, { unread: 1 }), chat(2, { unread: 3, archived_at: "2026-01-01" })]);
  await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
  expect(api.markAllChatsRead).toHaveBeenCalled();
});
