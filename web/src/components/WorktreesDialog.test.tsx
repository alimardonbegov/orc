import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import { WorktreesDialog } from "./WorktreesDialog";
import { formatBytes } from "../bytes";
import { api } from "../api";
import type { WorktreeInfo, WorktreesView } from "../types";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ApiError: actual.ApiError,
    api: { worktrees: vi.fn(), deleteWorktrees: vi.fn() },
  };
});

const MB = 1024 * 1024;

const wt = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  name: "orc-task-1", path: "/repo/.claude/worktrees/orc-task-1", kind: "task",
  branch: "orc/task-1", head: "abc1234", registered: true, exists: true, locked: false,
  task_id: 1, task_title: "Fix the port", task_status: "done", task_archived: false, task_done_at: null,
  size_bytes: 10 * MB, merged: true, target: "main", dirty: 0, processes: [], last_activity: null,
  busy: false, in_use: false, safe: true, delete_block: null, delete_warnings: [], ...over,
});

const view = (...items: WorktreeInfo[]): WorktreesView => ({
  root: "/repo/.claude/worktrees", base: "main", processes_known: true,
  total_bytes: items.reduce((a, i) => a + (i.size_bytes ?? 0), 0), items,
});

const open = (v: WorktreesView) => {
  vi.mocked(api.worktrees).mockResolvedValue(v);
  const props = { onOpenChange: vi.fn(), onOpenTask: vi.fn(), onChanged: vi.fn() };
  render(<WorktreesDialog open projectId={1} {...props} />);
  return props;
};

beforeEach(() => vi.clearAllMocks());

it("formats sizes in a human way", () => {
  expect(formatBytes(0, "en")).toBe("0 byte");
  expect(formatBytes(1.5 * 1024 * MB, "en")).toBe("1.5 GB");
  expect(formatBytes(320 * MB, "en")).toBe("320 MB");
});

it("shows copies from the heaviest, their tasks and state", async () => {
  const props = open(
    view(
      wt(),
      wt({
        name: "orc-task-2", task_id: 2, task_title: "Dashboard", size_bytes: 900 * MB, merged: false, dirty: 3,
        safe: false, in_use: true, processes: [{ pid: 7, name: "node" }],
      }),
      wt({ name: "my-feature", kind: "foreign", task_id: null, task_title: null, task_status: null, safe: false }),
    ),
  );
  const rows = await screen.findAllByRole("listitem");
  expect(within(rows[0]).getByText("orc-task-2")).toBeInTheDocument();
  expect(within(rows[0]).getByText("not merged into main")).toBeInTheDocument();
  expect(within(rows[0]).getByText("uncommitted: 3")).toBeInTheDocument();
  expect(within(rows[0]).getByText("in use: node")).toBeInTheDocument();
  expect(screen.getByText("not orc")).toBeInTheDocument();
  expect(screen.getByText(/Worktrees: 3/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Open task #1" }));
  expect(props.onOpenChange).toHaveBeenCalledWith(false);
  expect(props.onOpenTask).toHaveBeenCalledWith(1);
});

it("puts a lock instead of the delete button and names the reason", async () => {
  open(view(wt({ task_status: "in_progress", busy: true, in_use: true, safe: false, delete_block: "task #1 is running in it right now" })));
  expect(await screen.findByText("task #1 is running in it right now")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete orc-task-1" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Delete all (0)" })).toBeDisabled();
});

it("deletes one copy after confirmation with warnings", async () => {
  const item = wt({ delete_warnings: ["\"Rework\" for #1 will become unavailable"] });
  const props = open(view(item));
  vi.mocked(api.deleteWorktrees).mockResolvedValue({ ...view(), note: "deleted: orc-task-1" });
  await userEvent.click(await screen.findByRole("button", { name: "Delete orc-task-1" }));
  expect(screen.getByText("\"Rework\" for #1 will become unavailable")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Delete worktree" }));
  expect(api.deleteWorktrees).toHaveBeenCalledWith(1, ["orc-task-1"], true);
  expect(await screen.findByText("deleted: orc-task-1")).toBeInTheDocument();
  expect(props.onChanged).toHaveBeenCalled();
});

it("\"Remove merged\" takes only the safe copies, \"Delete all\" takes everything that is not blocked", async () => {
  open(
    view(
      wt(),
      wt({ name: "orc-task-2", task_id: 2, merged: false, safe: false, delete_warnings: ["branch not merged"] }),
      wt({ name: "orc-task-3", task_id: 3, safe: false, delete_block: "running" }),
    ),
  );
  vi.mocked(api.deleteWorktrees).mockResolvedValue({ ...view(), note: "ok" });
  await userEvent.click(await screen.findByRole("button", { name: "Remove merged (1)" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(api.deleteWorktrees).toHaveBeenLastCalledWith(1, ["orc-task-1"], true);
});

it("\"Delete all\" lists what will be lost", async () => {
  open(
    view(
      wt(),
      wt({ name: "orc-task-2", task_id: 2, merged: false, safe: false, delete_warnings: ["branch not merged"] }),
      wt({ name: "orc-task-3", task_id: 3, safe: false, delete_block: "running" }),
    ),
  );
  vi.mocked(api.deleteWorktrees).mockResolvedValue({ ...view(), note: "ok" });
  await userEvent.click(await screen.findByRole("button", { name: "Delete all (2)" }));
  expect(screen.getByText("orc-task-2: branch not merged")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(api.deleteWorktrees).toHaveBeenLastCalledWith(1, ["orc-task-1", "orc-task-2"], true);
});
