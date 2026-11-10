import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentsContext } from "../agents";
import type { Agent, Chat, ChatDetail, ChatMessage, Project } from "../types";
import { ChatOverlay } from "./ChatOverlay";
import { clearChatDrafts } from "../chats";
import { api } from "../api";

vi.mock("../api", () => ({
  api: {
    chat: vi.fn(),
    addChat: vi.fn(),
    deleteChat: vi.fn(async () => ({ deleted: 1 })),
    renameChat: vi.fn(async () => ({})),
    sendChatMessage: vi.fn(async () => ({})),
    stopChat: vi.fn(async () => ({})),
    markChatRead: vi.fn(async () => ({ last_read_message_id: 1 })),
    updateChat: vi.fn(async () => ({})),
    markChatUnread: vi.fn(async () => ({})),
    markAllChatsRead: vi.fn(async () => ({ chats: 0 })),
    acceptProposal: vi.fn(async () => ({ task_id: 9 })),
    dismissProposal: vi.fn(async () => ({ ok: true })),
    answerChatInput: vi.fn(async () => ({})),
  },
  ApiError: class extends Error {},
}));

const agent: Agent = {
  id: 1, name: "Ann", description: "", avatar: null, model: null, effort: null, permission_mode: null, prompt: "",
  project_id: null, memory_enabled: false, created_at: "", updated_at: "", tasks: { active: 0, total: 0 },
};
const inner: Agent = { ...agent, id: 2, name: "Inner", project_id: 1 };

const project = { id: 1, name: "Demo", archived_at: null, path_ok: true } as Project;

const chat = (over: Partial<Chat> = {}): Chat => ({
  id: 5, agent_id: 1, project_id: 1, title: "About login", status: "idle", cwd: null, branch: "orc/chat-5", job_id: null,
  session_id: null, turn_started_at: null, waiting_detail: null, last_read_message_id: 0, created_at: "", updated_at: "",
  last_message: "Hi", unread: 0, pinned: 0, archived_at: null, ...over,
});

const message = (id: number, role: ChatMessage["role"], body: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, chat_id: 5, role, body, state: role === "user" ? "sent" : null, created_at: "", ...over,
});

function renderPage(detail: Partial<ChatDetail> = {}, props: Partial<Parameters<typeof ChatOverlay>[0]> = {}) {
  vi.mocked(api.chat).mockResolvedValue({ ...chat(), messages: [], ...detail });
  return render(
    <AgentsContext.Provider value={[agent, inner]}>
      <ChatOverlay
        open
        onOpenChange={vi.fn()}
        expanded
        onExpandedChange={vi.fn()}
        chats={[chat()]}
        projects={[project]}
        selectedId={5}
        onSelect={vi.fn()}
        onChanged={vi.fn()}
        onOpenTask={vi.fn()}
        {...props}
      />
    </AgentsContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearChatDrafts();
  localStorage.clear();
});

it("shows the conversation and folds tool calls", async () => {
  renderPage({
    messages: [
      message(1, "user", "How does login work?"),
      message(2, "activity", "Read auth.py"),
      message(3, "activity", "Grep token"),
      message(4, "assistant", "Through a token."),
      message(5, "system", "stopped by the owner"),
    ],
  });
  expect(await screen.findByText("How does login work?")).toBeInTheDocument();
  expect(screen.getByText("Through a token.")).toBeInTheDocument();
  expect(screen.getByText("Steps: 2")).toBeInTheDocument();
  expect(screen.getByText("stopped by the owner")).toBeInTheDocument();
  // What is on screen has been seen
  await waitFor(() => expect(api.markChatRead).toHaveBeenCalledWith(5, 5));
});

it("Enter sends and clears, Shift+Enter does not", async () => {
  renderPage();
  const box = await screen.findByRole("textbox");
  await userEvent.type(box, "first{Shift>}{Enter}{/Shift}second");
  expect(api.sendChatMessage).not.toHaveBeenCalled();
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledWith(5, "first\nsecond"));
  expect(box).toHaveValue("");
});

it("a failed send gives the text back", async () => {
  vi.mocked(api.sendChatMessage).mockRejectedValueOnce(new Error("offline"));
  renderPage();
  const box = await screen.findByRole("textbox");
  await userEvent.type(box, "keep me{Enter}");
  expect(await screen.findByText("offline")).toBeInTheDocument();
  expect(box).toHaveValue("keep me");
});

it("a running turn says who is working and offers Stop", async () => {
  renderPage({ status: "running", messages: [message(1, "user", "go")] });
  await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
  expect(api.stopChat).toHaveBeenCalledWith(5);
  expect(screen.getByText("Ann is working…")).toBeInTheDocument();
});

it("a stuck session says what it is waiting for and how to get out", async () => {
  renderPage({ status: "waiting", waiting_detail: "approve Bash", messages: [message(1, "user", "go")] });
  expect(await screen.findByText(/waiting for approval: approve Bash/)).toBeInTheDocument();
});

it("a proposal becomes a card only by the owner's hand", async () => {
  const proposal = { title: "Add tests", description: "cover login", agent: "Ann" };
  renderPage({
    messages: [
      message(1, "proposal", "{}", { state: "open", proposal }),
      message(2, "proposal", "{}", { state: "accepted", proposal: { ...proposal, title: "Old", task_id: 3 } }),
      message(3, "proposal", "{}", { state: "dismissed", proposal: { ...proposal, title: "Gone" } }),
    ],
  });
  expect(await screen.findByText("Add tests")).toBeInTheDocument();
  expect(screen.getAllByText("Executor: Ann")).toHaveLength(3);
  expect(screen.getByText("Added as task #3")).toBeInTheDocument();
  expect(screen.getByText("Dismissed")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Add to backlog" }));
  expect(api.acceptProposal).toHaveBeenCalledWith(5, 1);
});

/** The menu of the open conversation: wide, the list has its own menu before it in the page. */
async function openPaneMenu() {
  const buttons = await screen.findAllByRole("button", { name: "Chat actions" });
  await userEvent.click(buttons[buttons.length - 1]);
}

it("deleting warns about the branch", async () => {
  renderPage();
  await openPaneMenu();
  await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
  expect(await screen.findByText(/branch orc\/chat-5, including any commits/)).toBeInTheDocument();
});

it("narrow, the open chat has the actions menu in its header and says what the agent is doing", async () => {
  const onSelect = vi.fn();
  renderPage({ status: "waiting", waiting_detail: "approve" }, { expanded: false, onSelect, chats: [chat({ status: "waiting" })] });
  expect(await screen.findByText(/Needs you/)).toBeInTheDocument();
  await openPaneMenu();
  await userEvent.click(await screen.findByRole("button", { name: "Archive" }));
  expect(api.updateChat).toHaveBeenCalledWith(5, { archived: true });
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
});

it("rename in the header menu opens the title field", async () => {
  renderPage({}, { expanded: false });
  await openPaneMenu();
  await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
  const field = await screen.findByRole("textbox", { name: "Rename chat" });
  await userEvent.clear(field);
  await userEvent.type(field, "New name{Enter}");
  expect(api.renameChat).toHaveBeenCalledWith(5, "New name");
});

it("marking the open chat unread takes you back to the list", async () => {
  const onSelect = vi.fn();
  renderPage({}, { expanded: false, onSelect });
  await openPaneMenu();
  await userEvent.click(await screen.findByRole("button", { name: "Mark as unread" }));
  expect(api.markChatUnread).toHaveBeenCalledWith(5);
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
});

/** The narrow window with nothing selected: the list, a New chat button, no chat on the server yet. */
async function startNewChatWith(name: RegExp, props: Partial<Parameters<typeof ChatOverlay>[0]> = {}) {
  const view = renderPage({}, { selectedId: null, expanded: false, chats: [], ...props });
  await userEvent.click(screen.getByRole("button", { name: "New chat" }));
  await userEvent.click(await screen.findByRole("option", { name }));
  return view;
}

it("a new chat is made on the server only with its first message, and an internal agent fixes the project", async () => {
  const onSelect = vi.fn();
  vi.mocked(api.addChat).mockResolvedValue(chat({ id: 8 }));
  expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();
  await startNewChatWith(/Inner/, { onSelect });
  expect(await screen.findByRole("heading", { name: "Chat with Inner" })).toBeInTheDocument();
  // The agent works on one project only: the choice is shown, not offered
  expect(screen.getByRole("button", { name: "Project" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Project" })).toHaveTextContent("Demo");
  expect(api.addChat).not.toHaveBeenCalled();
  await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
  await waitFor(() => expect(api.addChat).toHaveBeenCalledWith({ agent_id: 2, project_id: 1 }));
  await waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledWith(8, "hello"));
  expect(onSelect).toHaveBeenLastCalledWith(8);
});

it("a starter sends at once", async () => {
  vi.mocked(api.addChat).mockResolvedValue(chat({ id: 8, agent_id: 1 }));
  await startNewChatWith(/Ann/);
  await userEvent.click(await screen.findByRole("button", { name: "What can you do?" }));
  await waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledWith(8, expect.stringContaining("What can you help me with")));
});

it("a chat that could not be made keeps the text and says why", async () => {
  vi.mocked(api.addChat).mockRejectedValueOnce(new Error("project is unavailable"));
  await startNewChatWith(/Ann/);
  const box = await screen.findByRole("textbox");
  await userEvent.type(box, "keep me{Enter}");
  expect(await screen.findByText("project is unavailable")).toBeInTheDocument();
  expect(box).toHaveValue("keep me");
  expect(api.sendChatMessage).not.toHaveBeenCalled();
});

it("a message that could not be sent waits in the box of the chat that was made", async () => {
  const onSelect = vi.fn();
  vi.mocked(api.addChat).mockResolvedValue(chat({ id: 8 }));
  vi.mocked(api.sendChatMessage).mockRejectedValueOnce(new Error("offline"));
  const first = await startNewChatWith(/Ann/, { onSelect });
  await userEvent.type(await screen.findByRole("textbox"), "do not lose me{Enter}");
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(8));
  first.unmount();
  renderPage({ id: 8 }, { selectedId: 8, chats: [chat({ id: 8 })] });
  expect(await screen.findByRole("textbox")).toHaveValue("do not lose me");
});

it("wide, with nothing selected, a new chat is ready to be typed into", async () => {
  renderPage({}, { selectedId: null, chats: [chat()] });
  expect(await screen.findByRole("heading", { name: "Chat with Ann" })).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toBeInTheDocument();
  expect(api.addChat).not.toHaveBeenCalled();
});

it("switching the agent of a new chat keeps what was typed", async () => {
  await startNewChatWith(/Ann/);
  await userEvent.type(await screen.findByRole("textbox"), "half a thought");
  await userEvent.click(screen.getByRole("button", { name: "Change agent" }));
  await userEvent.click(await screen.findByRole("option", { name: /Inner/ }));
  expect(await screen.findByRole("heading", { name: "Chat with Inner" })).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("half a thought");
});

it("the project of a new chat is chosen beside the message", async () => {
  vi.mocked(api.addChat).mockResolvedValue(chat({ id: 8 }));
  await startNewChatWith(/Ann/);
  await userEvent.click(await screen.findByRole("button", { name: "Project" }));
  await userEvent.click(await screen.findByRole("option", { name: "Demo" }));
  await userEvent.type(screen.getByRole("textbox"), "hi{Enter}");
  await waitFor(() => expect(api.addChat).toHaveBeenCalledWith({ agent_id: 1, project_id: 1 }));
});

it("a chat selected from outside takes the window over from a draft, and the draft does not come back", async () => {
  const view = await startNewChatWith(/Ann/);
  expect(await screen.findByRole("heading", { name: "Chat with Ann" })).toBeInTheDocument();
  const props = { open: true, onOpenChange: vi.fn(), expanded: false, onExpandedChange: vi.fn(), chats: [chat()], projects: [project], onSelect: vi.fn(), onChanged: vi.fn(), onOpenTask: vi.fn() };
  const show = (selectedId: number | null) => (
    <AgentsContext.Provider value={[agent, inner]}>
      <ChatOverlay {...props} selectedId={selectedId} />
    </AgentsContext.Provider>
  );
  vi.mocked(api.chat).mockResolvedValue({ ...chat(), messages: [] });
  view.rerender(show(5));
  expect(await screen.findByText("About login")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Chat with Ann" })).not.toBeInTheDocument();
  view.rerender(show(null));
  expect(screen.queryByRole("heading", { name: "Chat with Ann" })).not.toBeInTheDocument();
  expect(screen.getByText("Hi")).toBeInTheDocument();
});

it("an existing chat can start a new one with another agent from its box", async () => {
  const onSelect = vi.fn();
  renderPage({}, { onSelect });
  await userEvent.click(await screen.findByRole("button", { name: "Change agent" }));
  await userEvent.click(await screen.findByRole("option", { name: /Inner/ }));
  expect(onSelect).toHaveBeenCalledWith(null);
});

it("pinned agents are one click from a new chat", async () => {
  renderPage({}, { selectedId: null, expanded: false, chats: [] });
  await userEvent.click(screen.getByRole("button", { name: "Pin an agent for one-click chats" }));
  await userEvent.click(await screen.findByRole("option", { name: /Ann/ }));
  expect(JSON.parse(localStorage.getItem("orc.chat.pinnedAgents") ?? "[]")).toEqual([1]);
  await userEvent.click(screen.getByRole("button", { name: "New chat with Ann" }));
  expect(await screen.findByRole("heading", { name: "Chat with Ann" })).toBeInTheDocument();
});

it("a pinned agent can be unpinned", async () => {
  localStorage.setItem("orc.chat.pinnedAgents", "[1,2]");
  renderPage({}, { selectedId: null, expanded: false, chats: [] });
  await userEvent.click(screen.getByRole("button", { name: "Unpin Ann" }));
  expect(screen.queryByRole("button", { name: "New chat with Ann" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New chat with Inner" })).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem("orc.chat.pinnedAgents") ?? "[]")).toEqual([2]);
});

it("the title is renamed in place", async () => {
  renderPage();
  await userEvent.click(await screen.findByRole("button", { name: "About login" }));
  const field = screen.getByRole("textbox", { name: "Rename chat" });
  await userEvent.clear(field);
  await userEvent.type(field, "Login flow{Enter}");
  await waitFor(() => expect(api.renameChat).toHaveBeenCalledWith(5, "Login flow"));
  expect(api.renameChat).toHaveBeenCalledTimes(1);
});

it("Escape in the title field leaves the field and keeps the window", async () => {
  const onOpenChange = vi.fn();
  renderPage({}, { onOpenChange });
  await userEvent.click(await screen.findByRole("button", { name: "About login" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Rename chat" }), "x{Escape}");
  expect(api.renameChat).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: "Rename chat" })).not.toBeInTheDocument();
});

it("the round button is Stop while the agent works on an empty box, and Send once there is text", async () => {
  renderPage({ status: "running", messages: [message(1, "user", "go")] });
  expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox"), "one more thing");
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
});

it("a working chat says so in the list instead of repeating its last words", () => {
  renderPage({}, { selectedId: null, expanded: false, chats: [chat({ status: "running" })] });
  expect(screen.getByText("Ann is working…")).toBeInTheDocument();
  expect(screen.queryByText("Hi")).not.toBeInTheDocument();
});

it("the list marks unread replies and running chats", () => {
  renderPage({}, { selectedId: null, chats: [chat({ unread: 3 }), chat({ id: 6, title: "Other", status: "running" })] });
  expect(screen.getByText("3")).toBeInTheDocument();
  expect(screen.getByText("Other")).toBeInTheDocument();
});

it("a linked proposal says what it waits for, and that accepting it brings those along", async () => {
  const proposal = { title: "Second", description: "", agent: null, waits_for: ["First", "#7"], depends_on_messages: [1] };
  renderPage({
    messages: [
      message(2, "proposal", "{}", { state: "open", proposal }),
      message(3, "proposal", "{}", { state: "accepted", proposal: { ...proposal, title: "Third", task_id: 9 } }),
    ],
  });
  expect(await screen.findAllByText("Waits for: First; #7")).toHaveLength(2);
  expect(screen.getAllByText("Accepting it also accepts the proposals it waits for.")).toHaveLength(1);
});

it("closed, it is one button with the unread count; a click opens the window", async () => {
  const onOpenChange = vi.fn();
  renderPage({}, { open: false, onOpenChange, chats: [chat({ unread: 2 }), chat({ id: 6, unread: 1 })] });
  const fab = screen.getByRole("button", { name: "Open chats (3 unread)" });
  expect(fab).toHaveTextContent("3");
  await userEvent.click(fab);
  expect(onOpenChange).toHaveBeenCalledWith(true);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("narrow, it shows one conversation with a way back to the list", async () => {
  const onSelect = vi.fn();
  renderPage({}, { expanded: false, onSelect });
  await userEvent.click(await screen.findByRole("button", { name: "All chats" }));
  expect(onSelect).toHaveBeenCalledWith(null);
  // The list of chats is not beside the conversation until the window is stretched
  expect(screen.queryByText("Hi")).not.toBeInTheDocument();
});

it("narrow with nothing selected shows the list; picking a chat selects it", async () => {
  const onSelect = vi.fn();
  renderPage({}, { expanded: false, selectedId: null, onSelect });
  await userEvent.click(screen.getByText("About login"));
  expect(onSelect).toHaveBeenCalledWith(5);
});

it("minimize and Escape close the window, expand stretches it", async () => {
  const onOpenChange = vi.fn();
  const onExpandedChange = vi.fn();
  renderPage({}, { onOpenChange, onExpandedChange });
  await userEvent.click(screen.getByRole("button", { name: "Shrink chats" }));
  expect(onExpandedChange).toHaveBeenCalledWith(false);
  await userEvent.click(screen.getByRole("button", { name: "Minimize chats" }));
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  await userEvent.type(await screen.findByRole("textbox"), "{Escape}");
  expect(onOpenChange).toHaveBeenCalledTimes(2);
});

it("an unsent message survives minimizing the window", async () => {
  const first = renderPage();
  await userEvent.type(await screen.findByRole("textbox"), "half a thou");
  first.unmount();
  renderPage();
  expect(await screen.findByRole("textbox")).toHaveValue("half a thou");
});

it("a permission the session waits on is answered in the chat", async () => {
  const request = { id: 7, chat_id: 5, kind: "permission" as const, tool_name: "Bash", tool_input: { command: "rm -rf build" },
    summary: "Requests permission: Bash — rm -rf build", decision: null, state: "open" as const, created_at: "" };
  renderPage({
    status: "waiting",
    waiting_detail: request.summary,
    messages: [
      message(1, "user", "clean up"),
      message(7, "input_request", "{}", { state: "open", request }),
      message(6, "input_request", "{}", { state: "answered", request: { ...request, id: 6, summary: "Earlier ask", state: "answered" } }),
    ],
  });
  expect(await screen.findByText("rm -rf build")).toBeInTheDocument();
  expect(screen.getByText(/Earlier ask/)).toBeInTheDocument();
  // the panel replaces the "stuck" banner
  expect(screen.queryByText(/Send a message to continue without it/)).not.toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: /^allow$/i })[0]);
  await waitFor(() => expect(api.answerChatInput).toHaveBeenCalledWith(5, 7, { behavior: "allow", scope: "once" }));
});
