import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, describe } from "vitest";
import { Sidebar, byPosition } from "./Sidebar";
import type { Project, Task } from "../types";

// EventsPanel inside the column polls the feed itself: an empty response is enough for the layout.
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { events: vi.fn(async () => []), markEventsRead: vi.fn(async () => ({ ok: true })) } };
});

const project = (id: number, name: string, position: number | null = null): Project => ({
  id,
  name,
  path: `/repo/${name}`,
  default_model: null,
  default_effort: null,
  default_permission_mode: "auto",
  default_branch: null,
  verify_cmd: null,
  verify_timeout_sec: 900,
  max_workers: 2,
  push_enabled: 0,
  archived_at: null,
  path_ok: true,
  path_error: null,
  created_at: "",
  position,
});

const baseProps = {
  tasks: [] as Task[],
  currentId: null as number | null,
  collapsed: false,
  usage: null,
  onUsageRefresh: vi.fn(),
  usagePending: false,
  dispatcher: null,
  onPause: vi.fn(),
  onResume: vi.fn(),
  onTick: vi.fn(),
  dispatcherPending: false,
  eventsOpen: false,
  onEventsOpen: vi.fn(),
  onOpenTask: vi.fn(),
  awake: false,
  working: false,
  onToggleCollapsed: vi.fn(),
  onAddProject: vi.fn(),
  onOpenSettings: vi.fn(),
  helpPage: null,
  onOpenHelp: vi.fn(),
};

describe("byPosition: manual order of projects in the sidebar", () => {
  it("sorts by position, ones never reordered (null) go to the tail by id", () => {
    const a = project(1, "A", null);
    const b = project(2, "B", 10);
    expect(byPosition([a, b]).map((p) => p.id)).toEqual([2, 1]);
  });

  it("a list nobody touched stays in id order", () => {
    const a = project(1, "A");
    const b = project(2, "B");
    const c = project(3, "C");
    expect(byPosition([a, b, c]).map((p) => p.id)).toEqual([1, 2, 3]);
  });
});

it("draws active projects in position order, not in the order of the incoming list", () => {
  const projects = [project(1, "Bravo", 20), project(2, "Alpha", 10)];
  render(<Sidebar projects={projects} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} />);
  const names = screen.getAllByText(/Alpha|Bravo/).map((el) => el.textContent);
  expect(names).toEqual(["Alpha", "Bravo"]);
});

it("clicking a project still selects it (the drag handlers do not intercept an ordinary click)", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const projects = [project(1, "Demo")];
  render(<Sidebar projects={projects} onSelect={onSelect} onReorderProjects={vi.fn()} {...baseProps} />);
  await user.click(screen.getByText("Demo"));
  expect(onSelect).toHaveBeenCalledWith(1);
});

it("archived projects do not take part in the manual order and stay in their section", () => {
  const projects = [project(1, "Live", 10), { ...project(2, "Dead"), archived_at: "2024-01-01" }];
  render(<Sidebar projects={projects} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} />);
  expect(screen.getByText("Archive")).toBeInTheDocument();
  expect(screen.getByText("Dead")).toBeInTheDocument();
});

it("the \"New project\" button sits in the project list, not in the footer of the column", async () => {
  const onAddProject = vi.fn();
  render(
    <Sidebar projects={[project(1, "Demo")]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} onAddProject={onAddProject} />,
  );
  const nav = screen.getByRole("navigation", { name: "Projects" });
  await userEvent.click(within(nav).getByRole("button", { name: "New project" }));
  expect(onAddProject).toHaveBeenCalledOnce();
});

it("in the collapsed rail adding a project stays next to the list", () => {
  render(
    <Sidebar projects={[project(1, "Demo")]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} collapsed />,
  );
  const nav = screen.getByRole("navigation", { name: "Projects" });
  expect(within(nav).getByRole("button", { name: "New project" })).toBeInTheDocument();
});

it("settings open from a row in the bottom navigation, and there is no separate theme button any more", async () => {
  const onOpenSettings = vi.fn();
  render(
    <Sidebar projects={[project(1, "Demo")]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} onOpenSettings={onOpenSettings} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(onOpenSettings).toHaveBeenCalledOnce();
  // The appearance is switched in the settings themselves: a second door to the theme is not needed in the column
  expect(screen.queryByRole("button", { name: /Theme:/ })).not.toBeInTheDocument();
});

it("help opens from the bottom navigation, the open page is highlighted", async () => {
  const onOpenHelp = vi.fn();
  render(
    <Sidebar projects={[]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} helpPage="about" onOpenHelp={onOpenHelp} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "How it works" }));
  expect(onOpenHelp).toHaveBeenCalledWith("guide");
  expect(screen.getByRole("button", { name: "About orc" })).toHaveAttribute("aria-current", "page");
});

it("in the collapsed rail help stays available as icons", async () => {
  const onOpenHelp = vi.fn();
  render(
    <Sidebar projects={[]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} collapsed onOpenHelp={onOpenHelp} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "About orc" }));
  expect(onOpenHelp).toHaveBeenCalledWith("about");
});

// Tasks are closed in several projects at once: the counter in the list says where the
// results the owner has not seen yet are (viewing.ts).
it("a project has an unviewed-results counter, only where viewing is tracked", () => {
  const done = (id: number, projectId: number, viewed_at: string | null = null) =>
    ({ id, project_id: projectId, status: "done", blocker: null, archived_at: null, done_at: "2026-03-01T10:00:00+00:00", viewed_at }) as Task;
  const projects = [{ ...project(1, "Alpha"), track_viewed: 1 }, { ...project(2, "Beta"), track_viewed: 0 }];
  const tasks = [done(1, 1), done(2, 1), done(3, 1, "2026-03-02T00:00:00+00:00"), done(4, 2)];
  render(<Sidebar projects={projects} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} tasks={tasks} />);

  expect(within(screen.getByRole("button", { name: /Alpha/ })).getByTitle("not viewed: 2")).toHaveTextContent("2");
  expect(within(screen.getByRole("button", { name: /Beta/ })).queryByTitle(/not viewed/)).not.toBeInTheDocument();
});
