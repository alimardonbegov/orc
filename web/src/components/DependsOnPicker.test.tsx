import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect } from "vitest";
import { DependsOnPicker } from "./DependsOnPicker";
import type { Project, Task, TaskStatus } from "../types";

const task = (id: number, title: string, status: TaskStatus = "todo", projectId = 1, createdAt = ""): Task => ({
  id, project_id: projectId, title, description: "", status, priority: "normal", blocker: null, blocker_detail: null,
  target_branch: "main", verify_cmd: null, requires_review: 0,
  worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0, state_miss_count: 0,
  quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null, merge_queued_at: null, retry_after: null, report_json: null,
  created_at: createdAt, updated_at: "", done_at: null, archived_at: null, position: null, usage_json: null, depends_on: [],
});

const project = (id: number, name: string): Project => ({
  id, name, path: `/tmp/${id}`, default_model: null, default_effort: null, default_permission_mode: "acceptEdits",
  default_branch: null, verify_cmd: null, verify_timeout_sec: 600, max_workers: 1, push_enabled: 0,
  archived_at: null, path_ok: true, path_error: null, created_at: "", position: null,
});

const PROJECTS = [project(1, "Console"), project(2, "Backend")];

/** A stateful wrapper: the component is controlled, and the tests check the behaviour after a click. */
function Harness({ candidates, initial = [] }: { candidates: Task[]; initial?: number[] }) {
  const [value, setValue] = useState<number[]>(initial);
  return (
    <>
      <DependsOnPicker candidates={candidates} projectId={1} projects={PROJECTS} value={value} onChange={setValue} />
      <output>{value.join(",")}</output>
    </>
  );
}

it("shows the candidates as checkboxes and marks the already selected ones", () => {
  render(<Harness candidates={[task(3, "First"), task(5, "Second")]} initial={[5]} />);
  expect(screen.getByRole("checkbox", { name: /#3 First/ })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /#5 Second/ })).toBeChecked();
});

it("clicking a row checks and unchecks the box", async () => {
  render(<Harness candidates={[task(3, "First"), task(5, "Second")]} />);
  await userEvent.click(screen.getByRole("checkbox", { name: /#3 First/ }));
  await userEvent.click(screen.getByRole("checkbox", { name: /#5 Second/ }));
  expect(screen.getByRole("status")).toHaveTextContent("3,5");
  await userEvent.click(screen.getByRole("checkbox", { name: /#3 First/ }));
  expect(screen.getByRole("status")).toHaveTextContent("5");
});

it("\"Clear\" removes the whole selection and hides itself when there is no selection", async () => {
  render(<Harness candidates={[task(3, "First"), task(5, "Second")]} initial={[3, 5]} />);
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(screen.getByRole("status").textContent).toBe("");
  expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
});

it("shows the selected counter", async () => {
  render(<Harness candidates={[task(3, "First"), task(5, "Second")]} initial={[3]} />);
  expect(screen.getByText("selected: 1")).toBeInTheDocument();
});

it("filters the list by number and by title", async () => {
  const many = [task(1, "Alpha"), task(2, "Beta"), task(3, "Gamma"), task(4, "Delta"), task(5, "Epsilon"), task(6, "Zeta")];
  render(<Harness candidates={many} />);
  const search = screen.getByPlaceholderText("Search by number, title or project");
  await userEvent.type(search, "Gam");
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(screen.getByRole("checkbox", { name: /#3 Gamma/ })).toBeInTheDocument();

  await userEvent.clear(search);
  await userEvent.type(search, "#5");
  expect(screen.getByRole("checkbox", { name: /#5 Epsilon/ })).toBeInTheDocument();

  await userEvent.clear(search);
  await userEvent.type(search, "zzz");
  expect(screen.getByText("Nothing found")).toBeInTheDocument();
});

it("does not show the search when there are few candidates", () => {
  render(<Harness candidates={[task(1, "Alpha"), task(2, "Beta")]} />);
  expect(screen.queryByPlaceholderText("Search by number, title or project")).not.toBeInTheDocument();
});

it("hides finished tasks but shows them on a button", async () => {
  render(<Harness candidates={[task(1, "Active"), task(2, "Finished", "done")]} />);
  expect(screen.queryByRole("checkbox", { name: /#2 Finished/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show completed (1)" }));
  expect(screen.getByRole("checkbox", { name: /#2 Finished/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Hide completed" }));
  expect(screen.queryByRole("checkbox", { name: /#2 Finished/ })).not.toBeInTheDocument();
});

it("an already selected finished task is always visible, otherwise the checkbox could not be unchecked", () => {
  render(<Harness candidates={[task(1, "Active"), task(2, "Finished", "done")]} initial={[2]} />);
  expect(screen.getByRole("checkbox", { name: /#2 Finished/ })).toBeChecked();
});

it("with no candidates it explains there is nothing to choose", () => {
  render(<Harness candidates={[]} />);
  expect(screen.getByText("No other tasks")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

it("other projects are hidden, and a button shows them as a separate group with the project name", async () => {
  render(<Harness candidates={[task(1, "Own"), task(9, "Foreign", "todo", 2)]} />);
  expect(screen.queryByRole("checkbox", { name: /#9 Foreign/ })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Show other projects (1)" }));
  expect(screen.getByRole("checkbox", { name: /#9 Foreign .*project Backend/ })).toBeInTheDocument();
  // Group headings: the own project is marked as current, the foreign one is named by its name.
  expect(screen.getByText("current project")).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Backend" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Current project only" }));
  expect(screen.queryByRole("checkbox", { name: /#9 Foreign/ })).not.toBeInTheDocument();
});

it("tasks of the current project come before foreign ones", async () => {
  render(<Harness candidates={[task(9, "Foreign", "todo", 2), task(1, "Own")]} />);
  await userEvent.click(screen.getByRole("button", { name: "Show other projects (1)" }));
  const names = screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"));
  expect(names[0]).toMatch(/#1 Own/);
  expect(names[1]).toMatch(/#9 Foreign/);
});

it("recently created tasks come above old ones within their group", async () => {
  render(
    <Harness
      candidates={[
        task(1, "Old", "todo", 1, "2024-01-01T00:00:00Z"),
        task(2, "New", "todo", 1, "2024-06-01T00:00:00Z"),
        task(9, "Old foreign", "todo", 2, "2024-01-01T00:00:00Z"),
        task(10, "New foreign", "todo", 2, "2024-06-01T00:00:00Z"),
      ]}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Show other projects (2)" }));
  const names = screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"));
  // Within the own project the new one is before the old; within a foreign one it is the same logic,
  // but the own project's group still comes first.
  expect(names[0]).toMatch(/#2 New /);
  expect(names[1]).toMatch(/#1 Old /);
  expect(names[2]).toMatch(/#10 New foreign/);
  expect(names[3]).toMatch(/#9 Old foreign/);
});

it("an already selected foreign task is always visible and labelled with its project", () => {
  render(<Harness candidates={[task(1, "Own"), task(9, "Foreign", "todo", 2)]} initial={[9]} />);
  expect(screen.getByRole("checkbox", { name: /#9 Foreign .*project Backend/ })).toBeChecked();
  expect(screen.getByText("Backend")).toBeInTheDocument();
});

it("findings in hidden foreign projects are not lost: it offers to show them", async () => {
  const many = [
    task(1, "Alpha"), task(2, "Beta"), task(3, "Gamma"), task(4, "Delta"), task(5, "Epsilon"), task(6, "Zeta"),
    task(9, "Omega", "todo", 2),
  ];
  render(<Harness candidates={many} />);
  await userEvent.type(screen.getByPlaceholderText("Search by number, title or project"), "Omega");
  expect(screen.queryByText("Nothing found")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "1 more in other projects — show" }));
  expect(screen.getByRole("checkbox", { name: /#9 Omega/ })).toBeInTheDocument();
});

it("searches by project name", async () => {
  const many = [
    task(1, "Alpha"), task(2, "Beta"), task(3, "Gamma"), task(4, "Delta"), task(5, "Epsilon"), task(6, "Zeta"),
    task(9, "Omega", "todo", 2),
  ];
  render(<Harness candidates={many} />);
  await userEvent.click(screen.getByRole("button", { name: "Show other projects (1)" }));
  await userEvent.type(screen.getByPlaceholderText("Search by number, title or project"), "backend");
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(screen.getByRole("checkbox", { name: /#9 Omega/ })).toBeInTheDocument();
});
