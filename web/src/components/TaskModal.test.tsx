import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { TaskModal } from "./TaskModal";
import { api } from "../api";

vi.mock("../api", () => ({
  api: {
    getTask: vi.fn(),
    addComment: vi.fn(),
    answerInput: vi.fn(),
    patchTask: vi.fn(),
    retry: vi.fn(),
    trustAndRetry: vi.fn(),
    resume: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    deleteTask: vi.fn(),
    markViewed: vi.fn(),
    branches: vi.fn(async () => ({ current: "main", default_branch: null, base: "main", branches: ["main", "dev"], items: [] })),
  },
}));

const detail = {
  id: 7, project_id: 1, title: "Port", description: "description", status: "in_progress", priority: "normal",
  blocker: "needs_input", blocker_detail: "Which port should be used?", target_branch: "main", model: null, effort: null,
  permission_mode: null, verify_cmd: null, requires_review: 0, worktree_path: "/wt", branch: "orc/task-7", job_id: "ab12cd34",
  session_id: "s", auto_resume_count: 0, merge_queued_at: null, report_json: null, created_at: "", updated_at: "", done_at: null,
  depends_on: [], comments: [], outbox: [], outbox_state: null, archived_at: null, position: null, usage_json: null,
};

it("shows the session's question and sends the answer", async () => {
  (api.getTask as any).mockResolvedValue(detail);
  (api.addComment as any).mockResolvedValue({ ...detail, blocker: null, comments: [{ id: 1, kind: "answer", body: "8080", author: "user", created_at: "", task_id: 7 }] });
  const onChanged = vi.fn();
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={onChanged} />);
  expect(await screen.findByText("Which port should be used?")).toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText("Reply to Claude"), "8080");
  await userEvent.click(screen.getByText("Reply"));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "8080", "answer"));
  expect(onChanged).toHaveBeenCalled();
  expect(screen.getByText("claude attach ab12cd34")).toBeInTheDocument();
});

// A request from a hook is drawn with its own form, and the shared "reply for Claude" field is hidden: text
// sent past the request will not reach the session: it is sitting on a dialog and does not call tools.
it("a permission request from a hook: buttons instead of the reply field, the decision goes to answerInput", async () => {
  const request = { id: 3, task_id: 7, kind: "permission", tool_name: "Bash", tool_input: { command: "npm test" }, summary: "Asks for permission: Bash — npm test", state: "open", created_at: "" };
  (api.getTask as any).mockResolvedValue({ ...detail, blocker_detail: request.summary, input_request: request });
  (api.answerInput as any).mockResolvedValue({ ...detail, blocker: null, input_request: null });
  const onChanged = vi.fn();
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={onChanged} />);
  expect(await screen.findByText("Agent waiting for permission")).toBeInTheDocument();
  expect(screen.getByText("npm test")).toBeInTheDocument();
  expect(screen.queryByPlaceholderText("Reply to Claude")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Allow" }));
  await waitFor(() => expect(api.answerInput).toHaveBeenCalledWith(7, 3, { behavior: "allow", scope: "once" }));
  expect(onChanged).toHaveBeenCalled();
});

it("the \"after #N\" badge in the header opens the blocking task", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, depends_on: [3] });
  const onOpenTask = vi.fn();
  render(<TaskModal taskId={7} allTasks={[]} onOpenTask={onOpenTask} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "after #3" }));
  expect(onOpenTask).toHaveBeenCalledWith(3);
});

it("a blocker badge from another project is named after its repository", async () => {
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
  expect(await screen.findByRole("button", { name: "after #3 · Backend" })).toBeInTheDocument();
});

it("when sending the reply fails, the text in the field is not erased", async () => {
  (api.getTask as any).mockResolvedValue(detail);
  (api.addComment as any).mockRejectedValue(new Error("server unavailable"));
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("Which port should be used?")).toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText("Reply to Claude"), "my long answer");
  await userEvent.click(screen.getByText("Reply"));
  await waitFor(() => expect(screen.getByText("server unavailable")).toBeInTheDocument());
  expect(screen.getByPlaceholderText("Reply to Claude")).toHaveValue("my long answer");
});

it("the \"Reply\" button is disabled while the request is in flight and does not let you send a second time", async () => {
  (api.getTask as any).mockResolvedValue(detail);
  let resolveComment: (v: unknown) => void = () => {};
  const addComment = api.addComment as any;
  const callsBefore = addComment.mock.calls.length;
  addComment.mockReturnValue(new Promise((resolve) => { resolveComment = resolve; }));
  const onChanged = vi.fn();
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={onChanged} />);
  expect(await screen.findByText("Which port should be used?")).toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText("Reply to Claude"), "8080");
  await userEvent.click(screen.getByText("Reply"));

  // While the request is in flight the button is unavailable and shows "Sending…": a repeated click cannot send.
  const pendingButton = await screen.findByRole("button", { name: "Sending…" });
  expect(pendingButton).toBeDisabled();
  // A click on the disabled button must not produce a second addComment call.
  await userEvent.click(pendingButton);
  expect(addComment.mock.calls.length).toBe(callsBefore + 1);

  resolveComment({ ...detail, blocker: null, comments: [{ id: 1, kind: "answer", body: "8080", author: "user", created_at: "", task_id: 7 }] });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it("for failed it shows retry and resume", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "failed", blocker: null, blocker_detail: "tests are red" });
  (api.retry as any).mockResolvedValue({});
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("tests are red")).toBeInTheDocument();
  await userEvent.click(screen.getByText("Retry"));
  expect(api.retry).toHaveBeenCalledWith(7);
  expect(screen.getByText("Resume session")).toBeInTheDocument();
});

it("for an untrusted folder it offers to trust and run, without sending the user to a terminal", async () => {
  (api.getTask as any).mockResolvedValue({
    ...detail, status: "failed", blocker: "untrusted", session_id: null,
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
  expect(await screen.findByText("description")).toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText("Note"), "use port 8080");
  await userEvent.click(screen.getByText("To session"));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "use port 8080", "answer"));
});

it("the \"Add\" button still writes a note, not a message to the session", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null });
  (api.addComment as any).mockResolvedValue({ ...detail, blocker: null, comments: [] });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("description")).toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText("Note"), "for later");
  await userEvent.click(screen.getByText("Add"));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "for later", "comment"));
});

it("for a finished task it sends a rework", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "done", blocker: null, blocker_detail: null });
  (api.addComment as any).mockResolvedValue({ ...detail, status: "todo", comments: [] });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("description")).toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText("Note"), "add a test");
  await userEvent.click(screen.getByText("Rework"));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "add a test", "rework"));
});

it("in the backlog a message to the session cannot be sent", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "backlog", blocker: null, blocker_detail: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("description")).toBeInTheDocument();
  expect(screen.getByText("Add")).toBeInTheDocument();
  expect(screen.queryByText("To session")).not.toBeInTheDocument();
  expect(screen.queryByText("Rework")).not.toBeInTheDocument();
});

it("under the quota a message to the session cannot be sent", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: "quota", blocker_detail: "usage limit" });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("description")).toBeInTheDocument();
  expect(screen.queryByText("To session")).not.toBeInTheDocument();
});

it("shows that a message is waiting for delivery, and lets you interrupt the session", async () => {
  const withOutbox = {
    ...detail, blocker: null, blocker_detail: null, outbox_state: "sent",
    outbox: [{ id: 1, task_id: 7, body: "use port 8080", mode: "soft", state: "sent", attempts: 2, created_at: "", delivered_at: null }],
  };
  (api.getTask as any).mockResolvedValue(withOutbox);
  (api.addComment as any).mockResolvedValue(withOutbox);
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("waiting for the session to pick it up")).toBeInTheDocument();
  expect(screen.getByText("use port 8080")).toBeInTheDocument();
  await userEvent.click(screen.getByText("Interrupt session"));
  await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(7, "use port 8080", "answer", "interrupt"));
});

it("without messages in the queue there is no delivery block", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null, outbox: [], outbox_state: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("description")).toBeInTheDocument();
  expect(screen.queryByText("Interrupt session")).not.toBeInTheDocument();
});

it("a stuck task is closed by hand only after confirmation", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, blocker: null, blocker_detail: null });
  const patchTask = api.patchTask as any;
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
  expect(await screen.findByText("Port")).toBeInTheDocument();
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
  expect(await screen.findByText(/wait for it to finish or close it manually first/)).toBeInTheDocument();
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
  expect(await screen.findByText("Which port should be used?")).toBeInTheDocument();
  expect(within(screen.getByPlaceholderText("Reply to Claude").closest("div")!.parentElement!)
    .getByRole("button", { name: "Image" })).toBeInTheDocument();
});

it("the backlog can be sent to work with a button, without dragging", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "backlog", blocker: null, blocker_detail: null });
  const patchTask = api.patchTask as any;
  patchTask.mockResolvedValue({ ...detail, status: "todo", blocker: null, blocker_detail: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "To work" }));
  await waitFor(() => expect(patchTask).toHaveBeenCalledWith(7, { status: "todo" }));
});

it("the \"To work\" button on a task without a description opens the dialog and sends nothing", async () => {
  // The session gets the description, not the title: there is nothing to send when it is empty, so the request
  // does not even fly: instead there is a dialog with an explanation (the server rejects it the same way).
  (api.getTask as any).mockResolvedValue({ ...detail, status: "backlog", description: "   ", blocker: null, blocker_detail: null });
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

it("a card without a description is opened straight in the editor", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "backlog", description: "", blocker: null, blocker_detail: null });
  render(<TaskModal taskId={7} allTasks={[]} initialEditing onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByLabelText("Task for the agent")).toBeInTheDocument();
});

it("a task outside the backlog has no \"To work\" button", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "todo", blocker: null, blocker_detail: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("description")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "To work" })).not.toBeInTheDocument();
});


it("the base branch is labelled and changed right in the card while the task is not in work", async () => {
  const waiting = { ...detail, status: "todo", blocker: null, blocker_detail: null };
  (api.getTask as any).mockResolvedValue(waiting);
  (api.patchTask as any).mockResolvedValue({ ...waiting, target_branch: "dev" });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("base branch")).toBeInTheDocument();
  const select = await screen.findByLabelText("Base branch");
  await waitFor(() => expect(within(select).getByRole("option", { name: "dev" })).toBeInTheDocument());
  await userEvent.selectOptions(select, "dev");
  await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(7, { target_branch: "dev" }));
});

it("for a running task the base branch is read-only and explains why", async () => {
  (api.getTask as any).mockResolvedValue(detail);
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("base branch")).toBeInTheDocument();
  expect(screen.queryByLabelText("Base branch")).not.toBeInTheDocument();
  expect(screen.getByText(/Too late to change: the working copy was already created/)).toBeInTheDocument();
});

it("shows the \"Tokens\" section with a breakdown by models and agents", async () => {
  const usage_json = JSON.stringify({
    total: { input: 100, cache_creation: 1000, cache_read: 3_000_000, output: 50_000 },
    total_tokens: 3_051_100,
    models: {
      "claude-opus-5": { input: 100, cache_creation: 1000, cache_read: 2_500_000, output: 40_000, messages: 80 },
      "claude-haiku-4-5": { input: 0, cache_creation: 0, cache_read: 500_000, output: 10_000, messages: 12 },
    },
    agents: [
      { session_id: "s", agent_id: null, agent_type: null, description: null, model: "claude-opus-5",
        tokens: { input: 100, cache_creation: 1000, cache_read: 2_500_000, output: 40_000 }, total_tokens: 2_541_100, messages: 80 },
      { session_id: "s", agent_id: "aaa", agent_type: "Explore", description: "Find the stub", model: "claude-haiku-4-5",
        tokens: { input: 0, cache_creation: 0, cache_read: 500_000, output: 10_000 }, total_tokens: 510_000, messages: 12 },
    ],
    sessions: [{ session_id: "s", job_id: "ab12cd34", total_tokens: 3_051_100 }],
    cost_usd: 1.25,
    cost_usd_estimated: 1.19,
    scanned_at: "2026-09-21T12:00:00+00:00",
  });
  (api.getTask as any).mockResolvedValue({ ...detail, status: "done", blocker: null, blocker_detail: null, usage_json });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("Tokens")).toBeInTheDocument();
  expect(screen.getByText("3,1M")).toBeInTheDocument();
  expect(screen.getAllByText("claude-opus-5").length).toBeGreaterThan(0);
  expect(screen.getByText("subagent Explore")).toBeInTheDocument();
  expect(screen.getByText("Find the stub")).toBeInTheDocument();
  expect(screen.getByText("main session")).toBeInTheDocument();
  expect(screen.getByText(/1 subagent,/)).toBeInTheDocument();
  expect(screen.getByText(/≈ \$1\.25/)).toBeInTheDocument();
});

it("shows its own cost estimate if Claude Code has not yet recorded the exact total", async () => {
  const usage_json = JSON.stringify({
    total: { input: 169, cache_creation: 44_000, cache_read: 1_100_000, output: 7_200 },
    total_tokens: 1_151_369,
    models: {
      "claude-haiku-4-5": { input: 169, cache_creation: 44_000, cache_read: 1_100_000, output: 7_200, messages: 30 },
    },
    agents: [],
    sessions: [{ session_id: "s", job_id: "ab12cd34", total_tokens: 1_151_369 }],
    cost_usd: null,
    cost_usd_estimated: 0.28,
    scanned_at: "2026-09-21T12:00:00+00:00",
  });
  (api.getTask as any).mockResolvedValue({ ...detail, status: "done", blocker: null, blocker_detail: null, usage_json });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("Tokens")).toBeInTheDocument();
  expect(screen.getByText(/≈ \$0\.28 by our estimate\./)).toBeInTheDocument();
});

it("without tokens there is no section", async () => {
  (api.getTask as any).mockResolvedValue({ ...detail, status: "done", blocker: null, blocker_detail: null, usage_json: null });
  render(<TaskModal taskId={7} allTasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("description")).toBeInTheDocument();
  expect(screen.queryByText("Tokens")).not.toBeInTheDocument();
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
