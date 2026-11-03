import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import { BranchesDialog } from "./BranchesDialog";
import { api, ApiError } from "../api";
import type { BranchInfo, BranchesView, Task } from "../types";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ApiError: actual.ApiError,
    api: {
      branches: vi.fn(),
      createBranch: vi.fn(),
      renameBranch: vi.fn(),
      deleteBranch: vi.fn(),
      patchProject: vi.fn(),
    },
  };
});

const branch = (over: Partial<BranchInfo> = {}): BranchInfo => ({
  name: "dev", commit: "abc1234", committed_at: "", subject: "fix",
  is_current: false, is_base: false, worktree: null, target_of: [], branch_of: [],
  busy: false, merged: true, delete_block: null, delete_warnings: [], rename_block: null, ...over,
});

const view = (...items: BranchInfo[]): BranchesView => ({
  current: "main",
  default_branch: null,
  base: "main",
  branches: items.map((i) => i.name),
  items,
});

const task = (id: number, title: string): Task =>
  ({ id, title, project_id: 1 } as Task);

const main = () => branch({ name: "main", is_current: true, is_base: true });

const open = (v: BranchesView, tasks: Task[] = []) => {
  vi.mocked(api.branches).mockResolvedValue(v);
  const onChanged = vi.fn();
  render(
    <BranchesDialog open onOpenChange={vi.fn()} projectId={1} defaultBranch={v.default_branch} tasks={tasks} onChanged={onChanged} />,
  );
  return { onChanged };
};

beforeEach(() => vi.clearAllMocks());

it("shows the branches and who holds them", async () => {
  open(view(main(), branch({ target_of: [3], branch_of: [] })), [task(3, "Fix the port")]);
  expect(await screen.findByTitle("dev")).toBeInTheDocument();
  expect(screen.getByText("open in repository")).toBeInTheDocument();
  expect(screen.getByText("base for new tasks")).toBeInTheDocument();
  expect(screen.getByTitle("#3 Fix the port")).toHaveTextContent("#3");
});

it("shows a lock instead of buttons and names the reason for the ban", async () => {
  open(view(main(), branch({ busy: true, delete_block: "task #4 is merging into it", rename_block: "task #4 is merging into it" })));
  expect(await screen.findByText("task #4 is merging into it")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete dev" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Rename dev" })).not.toBeInTheDocument();
});

it("creates a branch from the selected base", async () => {
  const { onChanged } = open(view(main(), branch()));
  vi.mocked(api.createBranch).mockResolvedValue({ ...view(main(), branch(), branch({ name: "feature/x" })), note: "branch feature/x created from main" });
  await userEvent.type(await screen.findByLabelText("New branch name"), "feature/x");
  await userEvent.selectOptions(screen.getByLabelText("From branch"), "dev");
  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(api.createBranch).toHaveBeenCalledWith(1, "feature/x", "dev"));
  expect(await screen.findByText("branch feature/x created from main")).toBeInTheDocument();
  expect(onChanged).toHaveBeenCalled();
});

it("renames a branch in place", async () => {
  open(view(main(), branch()));
  vi.mocked(api.renameBranch).mockResolvedValue({ ...view(main(), branch({ name: "release" })), note: "dev → release; updated: #3" });
  await userEvent.click(await screen.findByRole("button", { name: "Rename dev" }));
  const input = screen.getByLabelText("New name for branch dev");
  await userEvent.clear(input);
  await userEvent.type(input, "release{Enter}");
  await waitFor(() => expect(api.renameBranch).toHaveBeenCalledWith(1, "dev", "release"));
  expect(await screen.findByText("dev → release; updated: #3")).toBeInTheDocument();
});

it("deletion asks for confirmation and lists the losses", async () => {
  open(view(main(), branch({ merged: false, target_of: [3], delete_warnings: ["it has commits that are not in main — they will be lost"] })), [
    task(3, "Fix the port"),
  ]);
  vi.mocked(api.deleteBranch).mockResolvedValue({ ...view(main()), note: "branch dev deleted" });
  await userEvent.click(await screen.findByRole("button", { name: "Delete dev" }));
  const confirm = await screen.findByText("Delete branch dev?");
  expect(screen.getByText("it has commits that are not in main — they will be lost")).toBeInTheDocument();
  expect(screen.getByText(/Waiting on it as base: #3 Fix the port/)).toBeInTheDocument();
  expect(api.deleteBranch).not.toHaveBeenCalled();
  await userEvent.click(within(confirm.closest("[role=dialog]") as HTMLElement).getByRole("button", { name: "Delete branch" }));
  await waitFor(() => expect(api.deleteBranch).toHaveBeenCalledWith(1, "dev", true));
});

it("a server refusal shows the reason and does not remove the branch", async () => {
  open(view(main(), branch()));
  vi.mocked(api.deleteBranch).mockRejectedValue(new ApiError(400, "dev cannot be deleted: task #4 is running in this branch right now"));
  await userEvent.click(await screen.findByRole("button", { name: "Delete dev" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete branch" }));
  expect(await screen.findByText(/task #4 is running/)).toBeInTheDocument();
  expect(screen.getByTitle("dev")).toBeInTheDocument();
});

it("changes the base branch of new tasks", async () => {
  const { onChanged } = open(view(main(), branch()));
  vi.mocked(api.patchProject).mockResolvedValue({} as never);
  await userEvent.selectOptions(await screen.findByLabelText("Base branch for new tasks"), "dev");
  await waitFor(() => expect(api.patchProject).toHaveBeenCalledWith(1, { default_branch: "dev" }));
  expect(onChanged).toHaveBeenCalled();
});
