import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import type { ActivityNow, ActivityPage } from "../types";
import { AgentsContext } from "../agents";
import { ActivityPanel } from "./ActivityPanel";

vi.mock("../api", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import("../api")>()).ApiError,
  api: {
    taskActivity: vi.fn(),
    taskActivityResult: vi.fn(),
    taskProcesses: vi.fn(),
    chatActivity: vi.fn(),
    stopTask: vi.fn(async () => ({})),
    interruptTask: vi.fn(async () => ({})),
    stopChat: vi.fn(async () => ({})),
    addComment: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
    sendChatMessage: vi.fn(async () => ({})),
    answerInput: vi.fn(async () => ({})),
    acceptTask: vi.fn(async () => ({})),
    patchTask: vi.fn(async () => ({})),
    retry: vi.fn(async () => ({})),
    trustAndRetry: vi.fn(async () => ({})),
  },
}));

const now = (over: Partial<ActivityNow> = {}): ActivityNow => ({
  phase: "working", live: true, status: "in_progress", has_session: true, waiting_detail: null, failed_detail: null, detail: "Running the tests", current_tool: null,
  tempo: "active", silent_sec: 1, in_flight: 0, processes: [], todos: [], input_request: null, ...over,
});

const page = (over: Partial<ActivityPage> = {}, nowOver: Partial<ActivityNow> = {}): ActivityPage => ({
  events: [], cursor: "1:100", earlier: null, now: now(nowOver), ...over,
});

const base = { session: 1, offset: 0, at: "2026-11-06T10:00:00Z" };
const source = { kind: "task" as const, id: 7 };

beforeEach(() => vi.clearAllMocks());

it("says what the agent is doing, and pairs a call with its result across polls", async () => {
  const taskActivity = api.taskActivity as ReturnType<typeof vi.fn>;
  taskActivity.mockResolvedValueOnce(page({
    events: [{ ...base, id: "a", kind: "tool_use", tool_use_id: "t", name: "Bash", summary: "npm test", description: null, input: "{}", truncated: false }],
  }));
  taskActivity.mockResolvedValue(page({
    events: [{ ...base, id: "b", kind: "tool_result", tool_use_id: "t", text: "all green", is_error: false, truncated: false }],
  }));
  render(<ActivityPanel source={source} />);
  expect(await screen.findByText("npm test")).toBeInTheDocument();
  expect(screen.getByText("Running the tests")).toBeInTheDocument();
  expect(screen.getByLabelText("Running")).toBeInTheDocument();
  await waitFor(() => expect(taskActivity.mock.calls.length).toBeGreaterThan(1), { timeout: 3000 });
  expect(taskActivity.mock.calls[1][1]).toEqual({ cursor: "1:100" });
  await waitFor(() => expect(screen.queryByLabelText("Running")).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
  expect(screen.getByText("all green")).toBeInTheDocument();
});

it("names the running command when there is one, as the daemon's words are often empty", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { detail: "", current_tool: { name: "Bash", summary: "make build", at: null } }));
  render(<ActivityPanel source={source} />);
  expect(await screen.findByText("Bash: make build")).toBeInTheDocument();
});

it("stops a task only after confirmation", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page());
  const onChanged = vi.fn();
  render(<ActivityPanel source={source} onChanged={onChanged} />);
  await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
  expect(api.stopTask).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(api.stopTask).toHaveBeenCalledWith(7));
  expect(onChanged).toHaveBeenCalled();
});

it("a message goes softly by default, and interrupting is a separate choice", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page());
  render(<ActivityPanel source={source} />);
  const box = await screen.findByLabelText("Message to the agent");
  await userEvent.type(box, "use port 8080");
  await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "use port 8080", "answer"));
  await waitFor(() => expect(box).toHaveValue(""));
  await userEvent.type(box, "stop that");
  await userEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "stop that", "answer", "interrupt"));
});

it("an empty field interrupts without sending anything", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page());
  render(<ActivityPanel source={source} />);
  await screen.findByLabelText("Message to the agent");
  await userEvent.click(screen.getByRole("button", { name: "Interrupt" }));
  await waitFor(() => expect(api.interruptTask).toHaveBeenCalledWith(7));
});

it("a stopped task continues with a message, and there is nothing left to stop", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { phase: "failed", live: false, status: "failed", detail: "" }));
  render(<ActivityPanel source={source} />);
  const box = await screen.findByLabelText("Message to the agent");
  expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  await userEvent.type(box, "try the other API");
  await userEvent.click(screen.getByRole("button", { name: "Continue with this message" }));
  await waitFor(() => expect(api.resume).toHaveBeenCalledWith(7, "try the other API"));
});

it("a finished task is sent for rework, not messaged: its session is over", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { phase: "done", live: false, status: "done", detail: "" }));
  render(<ActivityPanel source={source} />);
  const box = await screen.findByLabelText("Message to the agent");
  expect(screen.queryByRole("button", { name: "Send to agent" })).not.toBeInTheDocument();
  await userEvent.type(box, "also rename it");
  await userEvent.click(screen.getByRole("button", { name: "Rework" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "also rename it", "rework"));
});

it("a request is the last row of the thread and takes the composer's place; the call behind it is not shown twice", async () => {
  const request = { id: 3, task_id: 7, kind: "permission", tool_name: "Bash", tool_input: { command: "rm -rf build" }, summary: "Bash", state: "open", created_at: "" };
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({
    events: [{ ...base, id: "a", kind: "tool_use", tool_use_id: "t", name: "Bash", summary: "rm -rf build", description: null, input: "{}", truncated: false }],
  }, { phase: "waiting_input", waiting_detail: "Bash", input_request: request as never }));
  render(<ActivityPanel source={source} />);
  const form = await screen.findByTestId("input-request");
  expect(screen.getAllByText("rm -rf build")).toHaveLength(1);
  const log = screen.getByRole("log");
  expect(within(log).getByTestId("input-request")).toBe(form);
  expect(screen.queryByTestId("composer")).not.toBeInTheDocument();
  await userEvent.click(within(form).getByRole("button", { name: "Allow" }));
  await waitFor(() => expect(api.answerInput).toHaveBeenCalledWith(7, 3, { behavior: "allow", scope: "once" }));
});

it("waiting for a reply: the question is marked where the agent asked it, and the work can be accepted", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({
    events: [{ ...base, id: "q", kind: "text", text: "Which port should be used?", truncated: false }],
  }, { phase: "waiting_reply", waiting_detail: "Which port should be used?", blocker: "needs_input", blocker_detail: "Which port should be used?" }));
  render(<ActivityPanel source={source} />);
  expect(await screen.findByTestId("waiting-mark")).toBeInTheDocument();
  expect(screen.getAllByText("Which port should be used?")).toHaveLength(1);
  await waitFor(() => expect(screen.getByLabelText("Message to the agent")).toHaveFocus());
  expect(screen.getByRole("button", { name: "Send to agent" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Accept the work" }));
  await waitFor(() => expect(api.acceptTask).toHaveBeenCalledWith(7));
});

it("accepting on a server older than the page says to restart it", async () => {
  const { ApiError } = await import("../api");
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { phase: "waiting_reply", waiting_detail: "Which port?" }));
  (api.acceptTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(404, "Not Found"));
  render(<ActivityPanel source={source} />);
  await userEvent.click(await screen.findByRole("button", { name: "Accept the work" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The server is older than this page");
});

it("waiting for a reply with a message still on its way: the work cannot be accepted yet", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { phase: "waiting_reply", waiting_detail: "Which port?", outbox_state: "waiting" }));
  render(<ActivityPanel source={source} />);
  await screen.findByLabelText("Message to the agent");
  expect(screen.queryByRole("button", { name: "Accept the work" })).not.toBeInTheDocument();
});

it("under the quota only a note can be written, and the notice says why", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { phase: "quota", blocker: "quota", blocker_detail: "the limit resets at 18:00" }));
  render(<ActivityPanel source={source} />);
  const notice = await screen.findByTestId("notice");
  expect(within(notice).getByText("the limit resets at 18:00")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Message to the agent"), "check the logs later");
  expect(screen.queryByRole("button", { name: "Send to agent" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Note, hidden from the agent" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "check the logs later", "comment"));
});

it("a failed task continues, retries, is accepted or closed from the composer, with the failure in the thread", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { phase: "failed", live: false, status: "failed", detail: "", failed_detail: "the session crashed" }));
  const startWork = vi.fn((action: () => Promise<unknown>) => void action());
  const onForceClose = vi.fn();
  render(<ActivityPanel source={source} startWork={startWork} onForceClose={onForceClose} />);
  expect(await screen.findByTestId("failure-row")).toHaveTextContent("the session crashed");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(startWork).toHaveBeenCalled();
  expect(api.retry).toHaveBeenCalledWith(7);
  await userEvent.click(screen.getByRole("button", { name: "Close manually" }));
  expect(onForceClose).toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Accept the work" }));
  await waitFor(() => expect(api.acceptTask).toHaveBeenCalledWith(7));
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(api.resume).toHaveBeenCalledWith(7, undefined));
});

it("a card that failed before any session ran offers a retry, not the agent's work", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { phase: "failed", live: false, status: "failed", has_session: false, detail: "", failed_detail: "not trusted" }));
  render(<ActivityPanel source={source} startWork={vi.fn()} onForceClose={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Accept the work" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
});

it("verifying or merging: the agent is done with it, a note or a manual close is what is left", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { phase: "verifying", live: false, status: "verifying", detail: "" }));
  render(<ActivityPanel source={source} onForceClose={vi.fn()} />);
  await screen.findByLabelText("Message to the agent");
  expect(screen.getByRole("button", { name: "Note, hidden from the agent" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close manually" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send to agent" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Rework" })).not.toBeInTheDocument();
});

it("not started: a note, and the backlog goes to work through the card's check", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { phase: "backlog", live: false, status: "backlog", has_session: false, detail: "" }));
  const startWork = vi.fn();
  render(<ActivityPanel source={source} startWork={startWork} />);
  await userEvent.click(await screen.findByRole("button", { name: "To work" }));
  expect(startWork).toHaveBeenCalled();
  expect(api.patchTask).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Send to agent" })).not.toBeInTheDocument();
});

it("a conflict is a notice with its one action, and an untrusted folder starts through the card's check", async () => {
  const taskActivity = api.taskActivity as ReturnType<typeof vi.fn>;
  taskActivity.mockResolvedValue(page({}, { phase: "working", blocker: "conflict", blocker_detail: "CONFLICT in app.py" }));
  const { unmount } = render(<ActivityPanel source={source} />);
  const notice = await screen.findByTestId("notice");
  expect(within(notice).getByText("CONFLICT in app.py")).toBeInTheDocument();
  await userEvent.click(within(notice).getByRole("button", { name: "Conflict resolved, merge again" }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { blocker: null }));
  unmount();
  taskActivity.mockResolvedValue(page({}, { phase: "failed", live: false, status: "failed", blocker: "untrusted", blocker_detail: "untrusted" }));
  const startWork = vi.fn();
  render(<ActivityPanel source={source} startWork={startWork} />);
  await userEvent.click(within(await screen.findByTestId("notice")).getByRole("button", { name: "Trust folder and start" }));
  expect(startWork).toHaveBeenCalled();
});

it("shows the plan and the background work, and asks for system processes only when opened", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, {
    todos: [{ label: "Write tests", status: "done" }, { label: "Ship", status: "in_progress" }],
    processes: [{ id: "a", kind: "agent", label: "Review", status: "running", started_at_ms: 1, done_at_ms: null }],
  }));
  (api.taskProcesses as ReturnType<typeof vi.fn>).mockResolvedValue({ pid: 5, processes: [{ pid: 5, ppid: 1, elapsed_sec: 10, cpu_pct: 12, rss_kb: 2048, command: "npm test", depth: 0 }] });
  render(<ActivityPanel source={source} />);
  expect(await screen.findByText("Plan: 1 of 2")).toBeInTheDocument();
  expect(screen.getByText("Review")).toBeInTheDocument();
  expect(api.taskProcesses).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "System processes" }));
  expect(await screen.findByText("npm test")).toBeInTheDocument();
});

it("a chat stops without a confirmation and sends through the chat queue", async () => {
  (api.chatActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, { status: "running" }));
  render(<ActivityPanel source={{ kind: "chat", id: 4 }} />);
  await userEvent.type(await screen.findByLabelText("Message to the agent"), "hello");
  await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  await waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledWith(4, "hello"));
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(api.stopChat).toHaveBeenCalledWith(4));
});

it("a failed poll is said out loud and does not erase the log", async () => {
  const taskActivity = api.taskActivity as ReturnType<typeof vi.fn>;
  taskActivity.mockResolvedValueOnce(page({ events: [{ ...base, id: "x", kind: "text", text: "kept", truncated: false }] }));
  taskActivity.mockRejectedValue(new Error("server gone"));
  render(<ActivityPanel source={source} />);
  expect(await screen.findByText("kept")).toBeInTheDocument();
  expect(await screen.findByText(/The log is not updating: server gone/, undefined, { timeout: 3000 })).toBeInTheDocument();
  expect(screen.getByText("kept")).toBeInTheDocument();
});

it("in the thread the agent's words carry its face and name, the owner's say who wrote them", async () => {
  const lena = { id: 4, name: "Lena", description: "", avatar: "🦊", model: null, effort: null, permission_mode: null, prompt: "", project_id: null, memory_enabled: false, created_at: "", updated_at: "", tasks: { active: 0, total: 0 } };
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({
    events: [{ ...base, id: "t", kind: "text", text: "Tests are green", truncated: false }],
    comments: [{ id: 1, task_id: 7, author: "user", kind: "answer", body: "Ship it", created_at: base.at }],
  } as never, { agent_id: 4, live: false, phase: "done" }));
  render(
    <AgentsContext.Provider value={[lena]}>
      <ActivityPanel source={source} />
    </AgentsContext.Provider>,
  );
  const message = (await screen.findByText("Tests are green")).closest("li") as HTMLElement;
  expect(within(message).getByText("Lena")).toBeInTheDocument();
  expect(within(message).getByText("🦊")).toBeInTheDocument();
  const owner = (await screen.findByText("Ship it")).closest("li") as HTMLElement;
  expect(within(owner).getByText(/You, to the agent/)).toBeInTheDocument();
});

it("a session without an agent still names who is speaking", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({
    events: [{ ...base, id: "t", kind: "text", text: "Finished it", truncated: false }],
  }, { live: false, phase: "done" }));
  render(<ActivityPanel source={source} />);
  const message = (await screen.findByText("Finished it")).closest("li") as HTMLElement;
  expect(within(message).getByText("Claude")).toBeInTheDocument();
});

const actions = [
  { id: "review", title: "Review", prompt: "Review it." },
  { id: "tests", title: "Tests", prompt: "Write tests." },
];
const withActions = (phase: Partial<ActivityNow>) => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(page({}, phase));
  render(<ActivityPanel source={source} quickActions={actions} />);
  return screen.findByLabelText("Message to the agent");
};

it("/ opens the quick actions; arrows move, Enter sends the action's text to a live session, the field is cleared", async () => {
  const box = await withActions({});
  await userEvent.type(box, "/");
  expect(screen.getByRole("listbox", { name: "Quick actions" })).toBeInTheDocument();
  expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowUp}{Enter}");
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "Write tests.", "answer"));
  await waitFor(() => expect(box).toHaveValue(""));
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("typing after / narrows the list; Esc closes it and the text stays; nothing matching says so", async () => {
  const box = await withActions({});
  await userEvent.type(box, "/te");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(box).toHaveValue("/te");
  expect(api.addComment).not.toHaveBeenCalled();
  await userEvent.type(box, "zz");
  expect(screen.getByText("No matching action")).toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  expect(api.addComment).not.toHaveBeenCalled();
});

it("a click on an action sends it; ordinary text with a space or a slash inside opens nothing", async () => {
  const box = await withActions({});
  await userEvent.type(box, "see /usr/bin");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await userEvent.clear(box);
  await userEvent.type(box, "/ x");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await userEvent.clear(box);
  await userEvent.type(box, "/");
  await userEvent.click(screen.getByRole("option", { name: /Review/ }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "Review it.", "answer"));
});

it("a finished card takes an action as rework, a stopped session as a continuation, a failed card without a session not at all", async () => {
  let box = await withActions({ phase: "done", live: false, status: "done", detail: "" });
  await userEvent.type(box, "/");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "Review it.", "rework"));
  cleanup();

  box = await withActions({ phase: "failed", live: false, status: "failed", detail: "", has_session: true });
  await userEvent.type(box, "/");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(api.resume).toHaveBeenCalledWith(7, "Review it."));
  cleanup();

  vi.clearAllMocks();
  box = await withActions({ phase: "failed", live: false, status: "failed", detail: "", has_session: false });
  await userEvent.type(box, "/");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  expect(api.addComment).not.toHaveBeenCalled();
  expect(api.resume).not.toHaveBeenCalled();
});

it("a card not yet started has no menu", async () => {
  const box = await withActions({ phase: "todo", live: false, status: "todo", detail: "", has_session: false });
  await userEvent.type(box, "/");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("a coded conflict notice says the reason in words and keeps the technical text behind the click", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(
    page({}, { phase: "working", blocker: "conflict", blocker_detail: "CONFLICT in app.py", detail_code: "conflict_unresolved" }),
  );
  render(<ActivityPanel source={source} />);
  const notice = await screen.findByTestId("notice");
  expect(within(notice).getByText("The branch conflicts with the target and could not be reconciled.")).toBeInTheDocument();
  expect(within(notice).queryByText(/CONFLICT in app.py/)).not.toBeInTheDocument();
  await userEvent.click(within(notice).getByText("The branch conflicts with the target and could not be reconciled."));
  expect(within(notice).getByTestId("notice-more")).toHaveTextContent("Reconcile the branches by hand");
  expect(within(notice).getByTestId("notice-more")).toHaveTextContent("CONFLICT in app.py");
});

it("a failed card carries its code into the thread's failure row", async () => {
  (api.taskActivity as ReturnType<typeof vi.fn>).mockResolvedValue(
    page({}, { phase: "failed", live: false, status: "failed", detail: "", failed_detail: "the session was stopped by the owner", detail_code: "stopped_by_owner" }),
  );
  render(<ActivityPanel source={source} />);
  const failure = await screen.findByTestId("failure-row");
  expect(within(failure).getByTestId("failure-reason")).toHaveTextContent("You stopped the agent.");
  expect(within(failure).queryByText("the session was stopped by the owner")).not.toBeInTheDocument();
});
