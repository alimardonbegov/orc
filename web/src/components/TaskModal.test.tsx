import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, it, expect, vi } from "vitest";
import { TaskModal } from "./TaskModal";
import { AgentsContext } from "../agents";
import { api } from "../api";

vi.mock("../api", () => ({
  api: {
    getTask: vi.fn(),
    taskDeliverables: vi.fn().mockResolvedValue([]),
    listLabels: vi.fn().mockResolvedValue([]),
    addComment: vi.fn(),
    interruptTask: vi.fn(),
    answerInput: vi.fn(),
    patchTask: vi.fn(),
    retry: vi.fn(),
    trustAndRetry: vi.fn(),
    resume: vi.fn(),
    taskActivity: vi.fn(),
    acceptTask: vi.fn(),
    stopTask: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    deleteTask: vi.fn(),
    markViewed: vi.fn(),
    taskRuns: vi.fn(async () => ({ runs: [], checks: [], merges: [], totals: { cost_usd: 0, tokens: 0, agent_sec: 0 } })),
    taskWakeups: vi.fn(async () => []),
    branches: vi.fn(async () => ({ current: "main", default_branch: null, base: "main", branches: ["main", "dev"], items: [] })),
  },
}));

// Each test says what the feed answers. Unsaid, it fails, and the card stands on its own state: the thread
// and the composer must work without the feed too.
beforeEach(() => {
  (api.taskActivity as any).mockReset();
  // The Relations view is remembered: a test that switched to the tree must not leave it for the next one
  localStorage.clear();
});

const detail = {
  id: 7, project_id: 1, title: "Port", description: "description", status: "in_progress", priority: "normal",
  blocker: "needs_input", blocker_detail: "Which port should be used?", target_branch: "main",
  verify_cmd: null, requires_review: 0, worktree_path: "/wt", branch: "orc/task-7", job_id: "ab12cd34",
  session_id: "s", auto_resume_count: 0, merge_queued_at: null, report_json: null, created_at: "", updated_at: "", done_at: null,
  depends_on: [], comments: [], outbox: [], outbox_state: null, archived_at: null, position: null, usage_json: null,
};

it("a question waits at the end of the thread, once, and the answer goes from the one composer", async () => {
  (api.getTask as any).mockResolvedValue(detail);
  (api.addComment as any).mockResolvedValue({ ...detail, blocker: null, comments: [{ id: 1, kind: "answer", body: "8080", author: "user", created_at: "", task_id: 7 }] });
  const onChanged = vi.fn();
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={onChanged} />);
  // The feed is silent here: the card's own state still puts the question in the thread
  expect(await screen.findByText("Which port should be used?")).toBeInTheDocument();
  expect(screen.getAllByText("Which port should be used?")).toHaveLength(1);
  expect(within(screen.getByRole("log")).getByText("Which port should be used?")).toBeInTheDocument();
  expect(screen.getByTestId("waiting-mark")).toBeInTheDocument();
  // The description is the task, untouched by the question
  expect(screen.getByText("description")).toBeInTheDocument();
  expect(screen.getAllByRole("textbox", { name: "Message to the agent" })).toHaveLength(1);
  await userEvent.type(screen.getByLabelText("Message to the agent"), "8080");
  await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "8080", "answer"));
  expect(onChanged).toHaveBeenCalled();
  expect(screen.getByText("claude attach ab12cd34")).toBeInTheDocument();
});

it("waiting for a reply, the work can be accepted from the composer", async () => {
  (api.getTask as any).mockResolvedValue(detail);
  (api.acceptTask as any).mockResolvedValue({ ...detail, status: "verifying", blocker: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "Accept the work" }));
  await waitFor(() => expect(api.acceptTask).toHaveBeenCalledWith(7));
});

// A request from a hook is drawn with its own form at the end of the thread, and the composer gives way:
// text sent past the request will not reach the session, which sits on a dialog and calls no tools.
it("a permission request from a hook: its form ends the thread, and the decision goes to answerInput", async () => {
  const request = { id: 3, task_id: 7, kind: "permission", tool_name: "Bash", tool_input: { command: "npm test" }, summary: "Asks for permission: Bash — npm test", state: "open", created_at: "" };
  (api.getTask as any).mockResolvedValue({ ...detail, blocker_detail: request.summary, input_request: request });
  (api.answerInput as any).mockResolvedValue({ ...detail, blocker: null, input_request: null });
  const onChanged = vi.fn();
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={onChanged} />);
  expect(await screen.findByText("Agent waiting for permission")).toBeInTheDocument();
  expect(within(screen.getByRole("log")).getByTestId("input-request")).toBeInTheDocument();
  expect(screen.getByText("npm test")).toBeInTheDocument();
  expect(screen.queryByLabelText("Message to the agent")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Allow" }));
  await waitFor(() => expect(api.answerInput).toHaveBeenCalledWith(7, 3, { behavior: "allow", scope: "once" }));
  expect(onChanged).toHaveBeenCalled();
});

it("nothing about the conversation sits above the description", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: "conflict", blocker_detail: "CONFLICT in app.py" });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  const description = await screen.findByText("description");
  const notice = await screen.findByTestId("notice");
  // The notice lives with the composer, after the task in the reading order
  expect(description.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByText("CONFLICT in app.py")).toHaveLength(1);
});

it("a blocker in Relations opens the blocking task, and one off the board stays a number", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, depends_on: [3, 9] });
  const blocker = { ...detail, id: 3, title: "Schema", depends_on: [] };
  const onOpenTask = vi.fn();
  render(<TaskModal taskId={7} allTasks={[blocker] as any} onOpenTask={onOpenTask} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: /#3 Schema/ }));
  expect(onOpenTask).toHaveBeenCalledWith(3);
  expect(screen.getByText("archived or deleted")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /#9/ })).not.toBeInTheDocument();
});

it("a blocker from another project is named after its repository", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, depends_on: [3] });
  const foreign = { ...detail, id: 3, project_id: 2, depends_on: [] };
  const projects = [
    { id: 1, name: "Console", path: "/p1", default_model: null, default_effort: null, default_permission_mode: "auto",
      default_branch: null, verify_cmd: null, verify_timeout_sec: 600, max_workers: 1, push_enabled: 0,
      archived_at: null, path_ok: true, path_error: null, created_at: "" },
    { id: 2, name: "Backend", path: "/p2", default_model: null, default_effort: null, default_permission_mode: "auto",
      default_branch: null, verify_cmd: null, verify_timeout_sec: 600, max_workers: 1, push_enabled: 0,
      archived_at: null, path_ok: true, path_error: null, created_at: "" },
  ] as any;
  render(
    <TaskModal taskId={7} allTasks={[foreign] as any} projects={projects} onOpenTask={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />,
  );
  expect(await screen.findByRole("button", { name: /#3 .*Backend/ })).toBeInTheDocument();
});

it("a failed blocker is highlighted, and what comes next is listed", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, depends_on: [3] });
  const failed = { ...detail, id: 3, title: "Schema", status: "failed", depends_on: [] };
  const after = { ...detail, id: 8, title: "UI", depends_on: [7] };
  render(<TaskModal taskId={7} allTasks={[failed, after] as any} onOpenTask={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByRole("button", { name: /#3 Schema/ })).toHaveAttribute("title", expect.stringContaining("failed"));
  expect(screen.getByText("Comes next")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /#8 UI/ })).toBeInTheDocument();
});

it("subtasks show their progress, and the tree shows the whole chain with the card highlighted", async () => {
  localStorage.clear();
  (api.getTask as any).mockResolvedValue({ ...detail, depends_on: [3] });
  const all = [
    { ...detail, id: 3, title: "Schema", status: "done", depends_on: [] },
    { ...detail, id: 7, depends_on: [3] },
    { ...detail, id: 8, title: "UI", depends_on: [7] },
    { ...detail, id: 10, title: "Part one", status: "done", parent_task_id: 7, depends_on: [] },
    { ...detail, id: 11, title: "Part two", parent_task_id: 7, depends_on: [] },
  ];
  render(<TaskModal taskId={7} allTasks={all as any} onOpenTask={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByTitle("1 of 2 subtasks done")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "Tree" }));
  const tree = screen.getByRole("tree");
  const items = within(tree).getAllByRole("treeitem");
  expect(items).toHaveLength(3);
  expect(within(tree).getByText("this card")).toBeInTheDocument();
  expect(items.find((item) => item.getAttribute("aria-current") === "true")).toHaveTextContent("#7");
});

it("a subtask is detached from the card, and the parent shows above the title", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, parent_task_id: 2 });
  (api.patchTask as any).mockResolvedValue(detail);
  const all = [
    { ...detail, id: 2, title: "Epic", depends_on: [] },
    { ...detail, id: 7, parent_task_id: 2, depends_on: [] },
    { ...detail, id: 12, title: "Child", parent_task_id: 7, depends_on: [] },
  ];
  const onOpenTask = vi.fn();
  const onCreateSubtask = vi.fn();
  render(<TaskModal taskId={7} allTasks={all as any} onOpenTask={onOpenTask} onCreateSubtask={onCreateSubtask} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: /Subtask of #2 Epic/ }));
  expect(onOpenTask).toHaveBeenCalledWith(2);
  await userEvent.click(screen.getByRole("button", { name: "Take #12 out of the subtasks" }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(12, { parent_task_id: null }));
  await userEvent.click(screen.getByRole("button", { name: "New subtask" }));
  expect(onCreateSubtask).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
});

it("a card asks to be woken when its subtasks are done", async () => {
  (api.getTask as any).mockResolvedValue(detail);
  (api.patchTask as any).mockResolvedValue(detail);
  const all = [
    { ...detail, id: 7, depends_on: [] },
    { ...detail, id: 12, title: "Child", parent_task_id: 7, depends_on: [] },
  ];
  render(<TaskModal taskId={7} allTasks={all as any} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("checkbox", { name: "Wake this card when all subtasks are done" }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { wake_on_children: 1 }));
});

it("when sending the reply fails, the text in the field is not erased", async () => {
  (api.getTask as any).mockResolvedValue(detail);
  (api.addComment as any).mockRejectedValue(new Error("server unavailable"));
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  const box = await screen.findByLabelText("Message to the agent");
  await userEvent.type(box, "my long answer");
  await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  await waitFor(() => expect(screen.getByText("server unavailable")).toBeInTheDocument());
  expect(box).toHaveValue("my long answer");
});

it("the send button is disabled while the request is in flight and does not let you send a second time", async () => {
  (api.getTask as any).mockResolvedValue(detail);
  let resolveComment: (v: unknown) => void = () => {};
  const addComment = api.addComment as any;
  const callsBefore = addComment.mock.calls.length;
  addComment.mockReturnValue(new Promise((resolve) => { resolveComment = resolve; }));
  const onChanged = vi.fn();
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={onChanged} />);
  await userEvent.type(await screen.findByLabelText("Message to the agent"), "8080");
  await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));

  const pendingButton = screen.getByRole("button", { name: "Send to agent" });
  expect(pendingButton).toBeDisabled();
  await userEvent.click(pendingButton);
  expect(addComment.mock.calls.length).toBe(callsBefore + 1);

  resolveComment({ ...detail, blocker: null, comments: [{ id: 1, kind: "answer", body: "8080", author: "user", created_at: "", task_id: 7 }] });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it("a failed card shows why in the thread, and retries or continues from the composer", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, agent_id: 4, status: "failed", blocker: null, blocker_detail: "tests are red" });
  (api.retry as any).mockResolvedValue({});
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByTestId("failure-row")).toHaveTextContent("tests are red");
  expect(screen.getAllByText("tests are red")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.retry).toHaveBeenCalledWith(7));
  expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
});

it("a failed card is closed by hand from the composer, after confirmation", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "failed", blocker: null, blocker_detail: "tests are red" });
  (api.patchTask as any).mockResolvedValue({ ...detail, status: "done" });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "Close manually" }));
  const dialog = await screen.findByRole("dialog", { name: "Close task manually?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Close manually" }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { status: "done", force: true }));
});

it("for an untrusted folder it offers to trust and run, without sending the user to a terminal", async () => {
  (api.getTask as any).mockResolvedValue({
    ...detail, agent_id: 4, status: "failed", blocker: "untrusted", session_id: null,
    blocker_detail: "Claude Code does not trust the project folder /repo.",
  });
  (api.trustAndRetry as any).mockResolvedValue({});
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("Claude Code does not trust the project folder /repo.")).toBeInTheDocument();
  await userEvent.click(screen.getByText("Trust folder and start"));
  expect(api.trustAndRetry).toHaveBeenCalledWith(7);
});

it("sends text to a running session that has no badge", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null });
  (api.addComment as any).mockResolvedValue({ ...detail, blocker: null, comments: [] });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.type(await screen.findByLabelText("Message to the agent"), "use port 8080");
  await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "use port 8080", "answer"));
});

it("a note is a quiet action of its own, labelled as invisible to the agent", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null });
  (api.addComment as any).mockResolvedValue({ ...detail, blocker: null, comments: [] });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.type(await screen.findByLabelText("Message to the agent"), "for later");
  await userEvent.click(screen.getByRole("button", { name: "Note, hidden from the agent" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "for later", "comment"));
});

it("for a finished task it sends a rework", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "done", blocker: null, blocker_detail: null });
  (api.addComment as any).mockResolvedValue({ ...detail, status: "todo", comments: [] });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.type(await screen.findByLabelText("Message to the agent"), "add a test");
  await userEvent.click(screen.getByRole("button", { name: "Rework" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "add a test", "rework"));
});

it("in the backlog a message to the session cannot be sent", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "backlog", blocker: null, blocker_detail: null, job_id: null, session_id: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Note, hidden from the agent" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send to agent" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Rework" })).not.toBeInTheDocument();
});

it("under the quota a message to the session cannot be sent", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: "quota", blocker_detail: "usage limit" });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByTestId("notice")).toHaveTextContent("usage limit");
  expect(screen.queryByRole("button", { name: "Send to agent" })).not.toBeInTheDocument();
});

it("a message on its way is a bubble in the thread with its receipt, and the session can be interrupted", async () => {
  const withOutbox = {
    ...detail, blocker: null, blocker_detail: null, outbox_state: "sent",
    outbox: [{ id: 1, task_id: 7, body: "use port 8080", mode: "soft", state: "sent", attempts: 2, created_at: "", delivered_at: null }],
  };
  (api.getTask as any).mockResolvedValue(withOutbox);
  (api.taskActivity as any).mockResolvedValue(feedPage({
    comments: [{ id: 1, task_id: 7, author: "user", kind: "answer", body: "use port 8080", created_at: "2026-11-06T10:00:30+00:00", sent_text: "use port 8080", delivery: "sent" }],
  }, { outbox_state: "sent" }));
  (api.addComment as any).mockClear();
  (api.interruptTask as any).mockClear();
  (api.interruptTask as any).mockResolvedValue(withOutbox);
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  const bubble = (await screen.findByText("use port 8080")).closest("li") as HTMLElement;
  expect(within(bubble).getByText("waiting for the agent's next step")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Interrupt" }));
  await waitFor(() => expect(api.interruptTask).toHaveBeenCalledWith(7));
  // The queued text goes as it is: sending it again would reach the agent twice.
  expect(api.addComment).not.toHaveBeenCalled();
});

it("a stuck task is closed by hand only after confirmation", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null });
  const patchTask = api.patchTask as any;
  patchTask.mockClear();
  patchTask.mockResolvedValue({ ...detail, blocker: null, status: "done" });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);

  await userEvent.click(await screen.findByRole("button", { name: "Close manually" }));
  // The dialog explains the consequences before anything goes to the server, including naming
  // the branch that will stay unmerged.
  const warning = await screen.findByRole("dialog", { name: "Close task manually?" });
  expect(within(warning).getByText(/orc\/task-7/)).toBeInTheDocument();
  expect(within(warning).getByText(/bypassing verification and merge/)).toBeInTheDocument();
  expect(patchTask).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByText("Close task manually?")).not.toBeInTheDocument());
  expect(patchTask).not.toHaveBeenCalled();

  // The second pass is with confirmation: only here does force=true go out.
  await userEvent.click(screen.getByRole("button", { name: "Close manually" }));
  const confirm = await screen.findByRole("dialog", { name: "Close task manually?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Close manually" }));
  await waitFor(() => expect(patchTask).toHaveBeenCalledWith(7, { status: "done", force: true }));
});

it("a task not in work has no \"Close manually\" button", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "todo", blocker: null, blocker_detail: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByDisplayValue("Port")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Close manually" })).not.toBeInTheDocument();
});

it("moves a task to the archive and back", async () => {
  const idle = { ...detail, status: "todo", blocker: null, blocker_detail: null };
  const inArchive = { ...idle, archived_at: "2026-09-21T10:00:00+00:00" };
  (api.getTask as any).mockResolvedValue(idle);
  // The card is re-read from the server after the action, so we substitute the getTask response too,
  // otherwise the window would keep showing the pre-archive state.
  (api.archive as any).mockImplementation(async () => {
    (api.getTask as any).mockResolvedValue(inArchive);
    return inArchive;
  });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "Archive" }));
  await waitFor(() => expect(api.archive).toHaveBeenCalledWith(7));
  expect(await screen.findByText("archived")).toBeInTheDocument();

  (api.unarchive as any).mockImplementation(async () => {
    (api.getTask as any).mockResolvedValue(idle);
    return idle;
  });
  await userEvent.click(await screen.findByRole("button", { name: "Restore from archive" }));
  await waitFor(() => expect(api.unarchive).toHaveBeenCalledWith(7));
  await waitFor(() => expect(screen.queryByText("archived")).not.toBeInTheDocument());
});

it("for a running task archiving is not offered: close it manually first", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Close manually" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
});

it("deletes a task only after confirmation and closes the window", async () => {
  const idle = { ...detail, status: "todo", blocker: null, blocker_detail: null };
  (api.getTask as any).mockResolvedValue(idle);
  const deleteTask = api.deleteTask as any;
  deleteTask.mockResolvedValue({ deleted: 7, session: false, worktree: true, branch: true, dependents: [] });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const blocked = { ...idle, id: 8, title: "Waits for the seventh", depends_on: [7] };
  render(<TaskModal taskId={7} allTasks={[blocked as any]} onClose={onClose} onChanged={onChanged} />);

  await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const confirm = await screen.findByRole("dialog", { name: "Delete task permanently?" });
  // The dialog honestly lists the consequences: irreversibility, dependent cards and the fate of the branch.
  expect(within(confirm).getByText(/can't be undone/)).toBeInTheDocument();
  expect(within(confirm).getByText(/#8/)).toBeInTheDocument();
  expect(within(confirm).getByText(/orc\/task-7/)).toBeInTheDocument();
  expect(deleteTask).not.toHaveBeenCalled();

  await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(deleteTask).toHaveBeenCalledWith(7, { force: false, dropWorktree: true }));
  expect(onChanged).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it("the \"delete branch\" checkbox can be unchecked, and a running task is deleted with force", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null });
  const deleteTask = api.deleteTask as any;
  deleteTask.mockClear();
  deleteTask.mockResolvedValue({ deleted: 7, session: true, worktree: false, branch: false, dependents: [] });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);

  await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const confirm = await screen.findByRole("dialog", { name: "Delete task permanently?" });
  expect(within(confirm).getByText(/session will be stopped mid-action/i)).toBeInTheDocument();
  await userEvent.click(within(confirm).getByRole("checkbox"));
  await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(deleteTask).toHaveBeenCalledWith(7, { force: true, dropWorktree: false }));
});

it("an image from the description is visible in the card, not a raw marker", async () => {
  (api.getTask as any).mockResolvedValue({
    ...detail,
    blocker: null,
    description: "the header is broken:\n![header](orc-image:3)\nfix it",
    comments: [{ id: 1, kind: "answer", body: "it should look like this ![mockup](orc-image:5)", author: "user", created_at: "", task_id: 7 }],
  });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByRole("img", { name: "header" })).toHaveAttribute("src", "/api/attachments/3");
  // The same parsing in the conversation: a reply with a screenshot is also shown as an image
  expect(screen.getByRole("img", { name: "mockup" })).toHaveAttribute("src", "/api/attachments/5");
  expect(screen.queryByText(/orc-image:3/)).not.toBeInTheDocument();
});

it("an image can be attached to a reply to the agent", async () => {
  (api.getTask as any).mockResolvedValue(detail);
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  const composer = await screen.findByTestId("composer");
  expect(within(composer).getByRole("button", { name: "Image" })).toBeInTheDocument();
});

it("the backlog can be sent to work with a button, without dragging", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, agent_id: 4, status: "backlog", blocker: null, blocker_detail: null });
  const patchTask = api.patchTask as any;
  patchTask.mockResolvedValue({ ...detail, status: "todo", blocker: null, blocker_detail: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "To work" }));
  await waitFor(() => expect(patchTask).toHaveBeenCalledWith(7, { status: "todo" }));
});

it("the \"To work\" button on a task without a description opens the dialog and sends nothing", async () => {
  // The session gets the description, not the title: there is nothing to send when it is empty, so the request
  // does not even fly: instead there is a dialog with an explanation (the server rejects it the same way).
  (api.getTask as any).mockResolvedValue({ ...detail, agent_id: 4, status: "backlog", description: "   ", blocker: null, blocker_detail: null });
  const patchTask = api.patchTask as any;
  patchTask.mockClear();
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "To work" }));
  expect(await screen.findByText("Task has no description")).toBeInTheDocument();
  expect(patchTask).not.toHaveBeenCalled();

  // The dialog does not just complain: the description editor opens from it.
  await userEvent.click(screen.getByRole("button", { name: /Write description/ }));
  expect(await screen.findByLabelText("Task for the agent")).toBeInTheDocument();
});

it("a task outside the backlog has no \"To work\" button", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "todo", blocker: null, blocker_detail: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("description")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "To work" })).not.toBeInTheDocument();
});


// Deferred start: "Run now" does not move the status but removes the schedule, after which
// the task goes through the shared queue.
it("a scheduled task: shows the wait, \"Start now\" removes the schedule", async () => {
  const at = new Date(Date.now() + 2 * 3_600_000 + 30_000).toISOString();
  (api.getTask as any).mockResolvedValue({ ...detail, status: "todo", blocker: null, blocker_detail: null, start_after: at, start_before: null });
  // After the schedule is removed the window re-reads the task (run → load): we return it without a deadline.
  (api.patchTask as any).mockImplementation(async () => {
    (api.getTask as any).mockResolvedValue({ ...detail, status: "todo", blocker: null, blocker_detail: null, start_after: null, start_before: null });
  });
  const onChanged = vi.fn();
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={onChanged} />);
  expect(await screen.findByText(/^Scheduled:/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Start now" }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { start_after: null, start_before: null }));
  expect(onChanged).toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByText(/^Scheduled:/)).not.toBeInTheDocument());
});

// A task in the backlog: the dispatcher will not take it until the owner moves it to "To do": the promise
// "the dispatcher will take it" and the "Start now" button would be a lie here.
it("a backlog task with a schedule: the \"not queued\" text, without \"Start now\"", async () => {
  const at = new Date(Date.now() + 2 * 3_600_000 + 30_000).toISOString();
  (api.getTask as any).mockResolvedValue({ ...detail, status: "backlog", blocker: null, blocker_detail: null, start_after: at, start_before: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText(/^Starts no earlier than .* once you send it «To do»\.$/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start now" })).not.toBeInTheDocument();
  expect(screen.queryByText(/dispatcher will take/)).not.toBeInTheDocument();
});

// Viewing results (viewing.ts): opened a finished card, it is viewed, like an email.
const doneDetail = { ...detail, status: "done", blocker: null, blocker_detail: null, done_at: "2026-03-01T10:00:00+00:00", viewed_at: null };
const tracking = [{ id: 1, name: "Demo", track_viewed: 1 }] as any;

it("opening a finished card marks it viewed", async () => {
  (api.getTask as any).mockResolvedValue(doneDetail);
  (api.markViewed as any).mockReset().mockResolvedValue({ ...doneDetail, viewed_at: "2026-03-02T00:00:00+00:00" });
  const onChanged = vi.fn();
  render(<TaskModal taskId={7} allTasks={[]} projects={tracking} onClose={vi.fn()} onChanged={onChanged} />);
  await waitFor(() => expect(api.markViewed).toHaveBeenCalledWith(7, true));
  expect(await screen.findByRole("checkbox", { name: "Viewed" })).toBeChecked();
  expect(onChanged).toHaveBeenCalled();
  expect(api.markViewed).toHaveBeenCalledTimes(1);
});

// "I'll be back later": the owner unchecked the box, the window must not put it back at once.
it("an unchecked checkbox returns the task to unviewed, and the window does not re-mark it", async () => {
  const viewed = { ...doneDetail, viewed_at: "2026-03-02T00:00:00+00:00" };
  (api.getTask as any).mockResolvedValue(viewed);
  (api.markViewed as any).mockReset().mockImplementation(async () => {
    (api.getTask as any).mockResolvedValue(doneDetail);
    return doneDetail;
  });
  render(<TaskModal taskId={7} allTasks={[]} projects={tracking} onClose={vi.fn()} onChanged={vi.fn()} />);
  const box = await screen.findByRole("checkbox", { name: "Viewed" });
  expect(box).toBeChecked();
  expect(api.markViewed).not.toHaveBeenCalled(); // already viewed, nothing to mark

  await userEvent.click(box);
  await waitFor(() => expect(api.markViewed).toHaveBeenCalledWith(7, false));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "Viewed" })).not.toBeChecked());
  expect(api.markViewed).toHaveBeenCalledTimes(1);
});

it("where viewing is not tracked there is no checkbox, and the card sends nothing", async () => {
  (api.getTask as any).mockResolvedValue(doneDetail);
  (api.markViewed as any).mockReset();
  const { unmount } = render(
    <TaskModal taskId={7} allTasks={[]} projects={[{ id: 1, name: "Demo", track_viewed: 0 }] as any} onClose={vi.fn()} onChanged={vi.fn()} />,
  );
  expect(await screen.findByText("description")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Viewed" })).not.toBeInTheDocument();
  unmount();

  // A task not finished in a project with viewing is also without a checkbox
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null });
  render(<TaskModal taskId={7} allTasks={[]} projects={tracking} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("description")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Viewed" })).not.toBeInTheDocument();
  expect(api.markViewed).not.toHaveBeenCalled();
});

// The task closed while the window was open: the report is still unread — we do not mark it.
it("a task that finished while the window was open stays unviewed", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null });
  (api.markViewed as any).mockReset();
  const live = { ...detail, blocker: null, updated_at: "1" } as any;
  const { rerender } = render(<TaskModal taskId={7} allTasks={[live]} projects={tracking} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("description")).toBeInTheDocument();

  (api.getTask as any).mockResolvedValue(doneDetail);
  rerender(<TaskModal taskId={7} allTasks={[{ ...live, status: "done", updated_at: "2" }]} projects={tracking} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByRole("checkbox", { name: "Viewed" })).not.toBeChecked();
  expect(api.markViewed).not.toHaveBeenCalled();
});

// ---------- the conversation: what the agent did is read in the card, not in its report ----------

const feedPage = (over: Record<string, unknown> = {}, nowOver: Record<string, unknown> = {}) => ({
  events: [], cursor: "1:1", earlier: null, delegations: [], stages: [], comments: [],
  now: {
    phase: "working", live: true, status: "in_progress", has_session: true, agent_id: null, waiting_detail: null, failed_detail: null,
    detail: "", current_tool: null, tempo: "active", silent_sec: 1, in_flight: 0, processes: [], todos: [], input_request: null, ...nowOver,
  },
  ...over,
});

const finished = { ...detail, status: "done", blocker: null, blocker_detail: null, report_json: JSON.stringify({ summary: "All done, 3 files changed", notes: "" }) };
const stepEvent = { id: "a:0", session: 1, offset: 0, at: "2026-11-06T10:00:00.000Z", kind: "text", text: "I changed three files", truncated: false };

it("the report is gone from the card: the agent's final message is in the thread", async () => {
  (api.getTask as any).mockResolvedValue(finished);
  (api.taskActivity as any).mockResolvedValue(feedPage({ events: [stepEvent] }, { phase: "done", live: false, status: "done" }));
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("I changed three files")).toBeInTheDocument();
  expect(screen.queryByText("All done, 3 files changed")).not.toBeInTheDocument();
});

it("a comment is marked as invisible to the agent, and sits in the thread with its stage", async () => {
  (api.getTask as any).mockResolvedValue({ ...finished, report_json: null });
  (api.taskActivity as any).mockResolvedValue(feedPage({
    events: [stepEvent],
    comments: [{ id: 1, task_id: 7, author: "user", kind: "comment", body: "the client wants it by Friday", created_at: "2026-11-06T10:00:30+00:00" }],
    stages: [{ id: 1, at: "2026-11-06T10:01:00+00:00", level: "info", text: "verification started" }],
  }, { phase: "done", live: false, status: "done" }));
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("the client wants it by Friday")).toBeInTheDocument();
  expect(screen.getByText(/Your comment · the agent does not see it/)).toBeInTheDocument();
  expect(screen.getByText("verification started")).toBeInTheDocument();
});

it("a running task can take a message softly or interrupt: the second one is a separate button", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null });
  (api.taskActivity as any).mockResolvedValue(feedPage());
  (api.addComment as any).mockClear();
  (api.addComment as any).mockResolvedValue({ ...detail, blocker: null, comments: [] });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.type(await screen.findByLabelText("Message to the agent"), "stop and use port 8080");
  await userEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "stop and use port 8080", "answer", "interrupt"));
});

it("with an empty field the same button just interrupts, like Esc in a console", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null, job_id: "abc" });
  (api.taskActivity as any).mockResolvedValue(feedPage());
  (api.addComment as any).mockClear();
  (api.interruptTask as any).mockClear();
  (api.interruptTask as any).mockResolvedValue({ ...detail, blocker: null, comments: [] });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByLabelText("Message to the agent");
  await userEvent.click(screen.getByRole("button", { name: "Interrupt" }));
  await waitFor(() => expect(api.interruptTask).toHaveBeenCalledWith(7));
  expect(api.addComment).not.toHaveBeenCalled();
});

it("a stopped task continues with the owner's message", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "failed", blocker: null, blocker_detail: "the session was stopped by the owner" });
  (api.taskActivity as any).mockResolvedValue(feedPage({}, { phase: "failed", live: false, status: "failed" }));
  (api.resume as any).mockClear();
  (api.resume as any).mockResolvedValue({ ...detail, status: "in_progress" });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.type(await screen.findByLabelText("Message to the agent"), "try the other API");
  await userEvent.click(screen.getByRole("button", { name: "Continue with this message" }));
  await waitFor(() => expect(api.resume).toHaveBeenCalledWith(7, "try the other API"));
});

it("a comment just added shows at once, not after the slow poll of a session that has nothing going on", async () => {
  let comments: unknown[] = [];
  (api.getTask as any).mockImplementation(async () => ({ ...finished, report_json: null, comments }));
  (api.taskActivity as any).mockImplementation(async () =>
    feedPage({ events: [stepEvent], comments }, { phase: "done", live: false, status: "done" }),
  );
  (api.addComment as any).mockClear();
  (api.addComment as any).mockImplementation(async (_id: number, body: string) => {
    comments = [{ id: 1, task_id: 7, author: "user", kind: "comment", body, created_at: "2026-11-06T10:00:30+00:00" }];
    return {};
  });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("I changed three files")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Message to the agent"), "a fresh fact");
  await userEvent.click(screen.getByRole("button", { name: "Note, hidden from the agent" }));
  // The idle poll is eight seconds: the default waiting time of the test is far shorter
  expect(await screen.findByText("a fresh fact", undefined, { timeout: 1500 })).toBeInTheDocument();
});

const lena = {
  id: 4, name: "Lena", description: "", avatar: null, model: "claude-haiku-4-5", effort: "low", permission_mode: null, prompt: "",
  project_id: null, memory_enabled: false, created_at: "", updated_at: "", tasks: { active: 0, total: 0 },
};
const waiting = { ...detail, status: "backlog", blocker: null, blocker_detail: null, job_id: null, session_id: null, worktree_path: null, branch: null };

const renderCard = (props: Partial<React.ComponentProps<typeof TaskModal>> = {}) =>
  render(
    <AgentsContext.Provider value={[lena]}>
      <TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} {...props} />
    </AgentsContext.Provider>,
  );

const stubCard = (card: object) => {
  (api.getTask as any).mockReset();
  (api.patchTask as any).mockReset();
  (api.getTask as any).mockResolvedValue(card);
  (api.patchTask as any).mockImplementation(async (_id: number, fields: object) => ({ ...card, ...fields }));
};

it("there is no edit button: the title is edited where it is written and saves on Enter", async () => {
  stubCard(waiting);
  const onChanged = vi.fn();
  renderCard({ onChanged });
  const title = await screen.findByRole("textbox", { name: "Title" });
  await waitFor(() => expect(title).toHaveValue("Port"));
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  await userEvent.clear(title);
  await userEvent.type(title, "Port 8080{Enter}");
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { title: "Port 8080" }));
  expect(onChanged).toHaveBeenCalled();
  expect(await screen.findByText("Saved")).toBeInTheDocument();
});

it("an emptied title is taken back instead of being saved", async () => {
  stubCard(waiting);
  renderCard();
  const title = await screen.findByRole("textbox", { name: "Title" });
  await waitFor(() => expect(title).toHaveValue("Port"));
  await userEvent.clear(title);
  await userEvent.tab();
  expect(title).toHaveValue("Port");
  expect(api.patchTask).not.toHaveBeenCalled();
});

it("a click on the description turns it into the field, and leaving it saves", async () => {
  stubCard(waiting);
  renderCard();
  await userEvent.click(await screen.findByRole("button", { name: "Edit the description" }));
  const field = await screen.findByLabelText("Task for the agent");
  await userEvent.clear(field);
  await userEvent.type(field, "new text");
  expect(api.patchTask).not.toHaveBeenCalled();
  // A press outside ends the editing and shows the text again
  await userEvent.click(screen.getByRole("textbox", { name: "Title" }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { description: "new text" }));
  expect(await screen.findByRole("button", { name: "Edit the description" })).toHaveTextContent("new text");
});

it("closing the card right after typing loses nothing", async () => {
  stubCard(waiting);
  const { unmount } = renderCard();
  await userEvent.click(await screen.findByRole("button", { name: "Edit the description" }));
  await userEvent.type(await screen.findByLabelText("Task for the agent"), " more");
  unmount();
  expect(api.patchTask).toHaveBeenCalledWith(7, { description: "description more" });
});

it("a refused edit keeps the typed text and names the reason", async () => {
  stubCard(waiting);
  renderCard();
  (api.patchTask as any).mockRejectedValue(new Error("disk is full"));
  await userEvent.click(await screen.findByRole("button", { name: "Edit the description" }));
  const field = await screen.findByLabelText("Task for the agent");
  await userEvent.type(field, " more");
  await userEvent.tab();
  expect(await screen.findByText("disk is full")).toBeInTheDocument();
  expect(screen.getByLabelText("Task for the agent")).toHaveValue("description more");
});

it("the description of a card already in work is read, not edited", async () => {
  stubCard({ ...detail, blocker: null, blocker_detail: null });
  renderCard();
  expect(await screen.findByText("description")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit the description" })).not.toBeInTheDocument();
});

it("a card refused from the board opens with the description ready to type", async () => {
  stubCard({ ...waiting, description: "" });
  renderCard({ focusOn: "description" });
  expect(await screen.findByLabelText("Task for the agent")).toBeInTheDocument();
});

it("a card refused for having no assignee opens with the agent list open", async () => {
  stubCard(waiting);
  renderCard({ focusOn: "agent" });
  expect(await screen.findByRole("listbox", { name: "Assignee" })).toBeInTheDocument();
});

it("an agent picked in the card is saved at once, on its own", async () => {
  stubCard(waiting);
  renderCard();
  await userEvent.click(await screen.findByRole("button", { name: "Assignee: Unassigned" }));
  await userEvent.click(within(await screen.findByRole("listbox")).getByRole("option", { name: /Lena/ }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { agent_id: 4 }));
  expect(await screen.findByRole("button", { name: "Assignee: Lena" })).toBeInTheDocument();
});

it("a refused property goes back to what the server holds", async () => {
  stubCard(waiting);
  renderCard();
  await userEvent.click(await screen.findByRole("button", { name: /^Priority/ }));
  (api.patchTask as any).mockRejectedValue(new Error("nope"));
  await userEvent.click(within(await screen.findByRole("listbox")).getByRole("option", { name: /High/ }));
  expect(await screen.findByText("nope")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: /^Priority: normal/i })).toBeInTheDocument());
});

it("the base branch is changed right in the card while the task is not in work", async () => {
  stubCard({ ...waiting, status: "todo" });
  renderCard();
  await userEvent.click(await screen.findByRole("button", { name: "Branch: main" }));
  await userEvent.click(within(await screen.findByRole("listbox")).getByRole("option", { name: "dev" }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { target_branch: "dev" }));
});

it("in a running task the properties stay readable and cannot be changed", async () => {
  stubCard({ ...detail, blocker: null, blocker_detail: null, agent_id: 4 });
  renderCard();
  expect(await screen.findByRole("button", { name: "Branch: main" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Assignee: Lena" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /^Priority/ })).toBeDisabled();
});

it("\"To work\" on an unassigned card asks for an agent and takes the person to the list", async () => {
  stubCard(waiting);
  renderCard();
  await userEvent.click(await screen.findByRole("button", { name: "To work" }));
  expect(await screen.findByText("The card is not ready for work")).toBeInTheDocument();
  expect(screen.getByText(/Nobody is assigned/)).toBeInTheDocument();
  expect(api.patchTask).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Fix it" }));
  expect(await screen.findByRole("listbox", { name: "Assignee" })).toBeInTheDocument();
});

it("the top of the card says who is on it and what is going on", async () => {
  stubCard(waiting);
  const { unmount } = renderCard();
  expect(await screen.findByTestId("agent-status")).toHaveTextContent("A person works on it");
  unmount();

  stubCard({ ...waiting, agent_id: 4 });
  const second = renderCard();
  expect(await screen.findByTestId("agent-status")).toHaveTextContent("Lena");
  expect(screen.getByTestId("agent-status")).toHaveTextContent("assigned");
  second.unmount();

  stubCard({ ...waiting, agent_id: 4, status: "todo" });
  renderCard();
  expect(await screen.findByTestId("agent-status")).toHaveTextContent("in the queue");
});

it("what the session will run with is shown in one line, from the agent", async () => {
  stubCard({ ...waiting, agent_id: 4 });
  renderCard();
  expect(await screen.findByText(/Runs with: Haiku 4.5 · low/)).toBeInTheDocument();
  expect(screen.queryByText("The card has parameters of its own")).not.toBeInTheDocument();
});

it("a value an old row still holds is ignored: the card shows the agent's parameters and nothing of its own", async () => {
  stubCard({ ...waiting, agent_id: 4, model: "claude-sonnet-5", effort: "max" } as any);
  renderCard();
  expect(await screen.findByText(/Runs with: Haiku 4.5 · low/)).toBeInTheDocument();
  expect(screen.queryByText(/Sonnet/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
});

it("a blocker in the card is a link to it, and another repository's names its project", async () => {
  const foreign = { id: 3, project_id: 2, title: "API", status: "todo", depends_on: [] } as any;
  const projects = [{ id: 1, name: "Web" }, { id: 2, name: "Backend" }] as any;
  stubCard({ ...waiting, depends_on: [3] });
  const onOpenTask = vi.fn();
  renderCard({ allTasks: [foreign], projects, onOpenTask });
  await userEvent.click(await screen.findByRole("button", { name: /after #3 · Backend|#3.*Backend/ }));
  expect(onOpenTask).toHaveBeenCalledWith(3);
});

it("\"To work\" waits for the description just typed: the server checks what the card holds", async () => {
  const card = { ...waiting, agent_id: 4, description: "" };
  stubCard(card);
  let release = () => {};
  const order: string[] = [];
  (api.patchTask as any).mockImplementation(async (_id: number, fields: any) => {
    if ("description" in fields) await new Promise<void>((resolve) => { release = resolve; });
    order.push(Object.keys(fields)[0]);
    return { ...card, ...fields };
  });
  renderCard();
  await userEvent.click(await screen.findByRole("button", { name: "Edit the description" }));
  await userEvent.type(await screen.findByLabelText("Task for the agent"), "do it");
  await userEvent.click(screen.getByRole("button", { name: "To work" }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { description: "do it" }));
  expect(order).toEqual([]);
  release();
  await waitFor(() => expect(order).toEqual(["description", "status"]));
});

it("opening a card does not put the cursor in the title: the first key must not change it", async () => {
  stubCard(waiting);
  renderCard();
  const title = await screen.findByRole("textbox", { name: "Title" });
  expect(document.activeElement).not.toBe(title);
  expect(screen.getByRole("button", { name: "Close" })).not.toHaveFocus();
});

it("a routine's run without an agent is retried without asking for one: it has its own parameters", async () => {
  stubCard({ ...waiting, status: "failed", blocker_detail: "tests are red", routine_id: 3, routine_run: 1 });
  (api.retry as any).mockClear();
  (api.retry as any).mockResolvedValue({});
  renderCard();
  await userEvent.click(await screen.findByText("Retry"));
  await waitFor(() => expect(api.retry).toHaveBeenCalledWith(7));
  expect(screen.queryByText("The card is not ready for work")).not.toBeInTheDocument();
});

it("a click in the middle of the description puts the caret at that place in the field", async () => {
  stubCard({ ...waiting, description: "first line\nsecond line" });
  renderCard();
  const view = await screen.findByRole("button", { name: "Edit the description" });
  const node = view.querySelector("span")!.firstChild!;
  (document as any).caretRangeFromPoint = () => ({ startContainer: node, startOffset: 14 });
  try {
    await userEvent.click(view);
  } finally {
    delete (document as any).caretRangeFromPoint;
  }
  const field = (await screen.findByLabelText("Task for the agent")) as HTMLTextAreaElement;
  expect(field).toHaveFocus();
  expect([field.selectionStart, field.selectionEnd]).toEqual([14, 14]);
});

it("a click the browser cannot place puts the caret at the end", async () => {
  stubCard({ ...waiting, description: "first line" });
  renderCard();
  await userEvent.click(await screen.findByRole("button", { name: "Edit the description" }));
  expect(((await screen.findByLabelText("Task for the agent")) as HTMLTextAreaElement).selectionStart).toBe(10);
});

it("the description is one box in the view and in the field: same border, padding and type", async () => {
  stubCard({ ...waiting, description: "text" });
  renderCard();
  const view = await screen.findByRole("button", { name: "Edit the description" });
  const same = ["border", "px-2.5", "py-1.5", "text-[13px]", "leading-relaxed", "whitespace-pre-wrap", "-mx-[11px]"];
  for (const cls of same) expect(view).toHaveClass(cls);
  expect(view).toHaveClass("border-transparent");
  await userEvent.click(view);
  const field = await screen.findByLabelText("Task for the agent");
  for (const cls of same.filter((c) => c !== "-mx-[11px]")) expect(field).toHaveClass(cls);
  // The pull-out is on the field's grid, which holds the field and its mirror together
  expect(field.parentElement).toHaveClass("-mx-[11px]");
  // And the toolbar is below the field
  const switcher = screen.getByRole("radiogroup", { name: /Task for the agent/ });
  expect(field.compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("the title wraps instead of being cut off, and a line break cannot get into it", async () => {
  stubCard(waiting);
  renderCard();
  const title = await screen.findByRole("textbox", { name: "Title" });
  expect(title.tagName).toBe("TEXTAREA");
  expect(title).not.toHaveClass("truncate");
  await userEvent.clear(title);
  await userEvent.type(title, "a very long title that goes on");
  fireEvent.change(title, { target: { value: "one\ntwo" } });
  expect(title).toHaveValue("one two");
});

it("Details is closed by default and holds who made the card, the dates and the copy rows", async () => {
  (api.getTask as any).mockResolvedValue({
    ...detail, blocker: null, blocker_detail: null, created_by_task_id: 4, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-02T10:00:00Z",
  });
  render(<TaskModal taskId={7} allTasks={[]} onOpenTask={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
  const toggle = await screen.findByRole("button", { name: /^Details/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "Agent of card #4" })).toBeInTheDocument();
  expect(screen.getByText("orc/task-7")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy task branch" })).toBeInTheDocument();
});

it("the status row of a backlog card sends it to work, and a working card's is locked", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "backlog", blocker: null, blocker_detail: null, agent_id: 1, description: "do it" });
  (api.patchTask as any).mockResolvedValue({ ...detail, status: "todo", blocker: null, blocker_detail: null, agent_id: 1, description: "do it" });
  const { unmount } = render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: /^Status:/ }));
  await userEvent.click(await screen.findByRole("option", { name: /To do/ }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { status: "todo" }));
  unmount();
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByRole("button", { name: /^Status:/ })).toBeDisabled();
});

it("a due date and a label can be set on a card that is already working", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null, due_date: "2099-01-05", labels: [{ id: 1, name: "bug", color: "#f00" }] });
  (api.patchTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null, due_date: null, labels: [{ id: 1, name: "bug", color: "#f00" }] });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: /^Due date:/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Clear date" }));
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { due_date: null }));
});

it("a quick action in the panel messages a live session, and goes to rework on a finished card", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null });
  (api.addComment as any).mockResolvedValue({ ...detail, blocker: null });
  const { unmount } = render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "Write tests" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, expect.stringContaining("Write tests"), "answer"));
  unmount();

  (api.addComment as any).mockClear();
  (api.getTask as any).mockResolvedValue({ ...detail, status: "done", blocker: null, blocker_detail: null, done_at: "2026-11-08T00:00:00Z" });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "Review" }));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, expect.stringContaining("Review"), "rework"));
});

it("the panel actions are disabled before the work starts: there is no agent to message", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "backlog", blocker: null, blocker_detail: null, session_id: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Write tests" })).toBeDisabled();
});
