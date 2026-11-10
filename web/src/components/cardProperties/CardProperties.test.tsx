import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { resetLabelsCache } from "../../hooks/useLabels";
import { PropertyPills, PropertyRows } from "./CardProperties";
import type { CardPropertyValues } from "./types";

vi.mock("../../api", () => ({
  api: {
    listLabels: vi.fn().mockResolvedValue([
      { id: 1, name: "bug", color: "#ff0000" },
      { id: 2, name: "ui", color: "#00ff00" },
    ]),
    addLabel: vi.fn(async (name: string) => ({ id: 3, name, color: "#8b8b95" })),
  },
}));

const blank: CardPropertyValues = {
  agent_id: 1,
  priority: "normal",
  target_branch: "main",
  depends_on: [],
  labels: [],
  start_date: null,
  due_date: null,
};

const branches = { branches: ["main"], setBranches: vi.fn() };

function setup(values: Partial<CardPropertyValues> = {}, extra: Partial<React.ComponentProps<typeof PropertyRows>> = {}) {
  const onChange = vi.fn();
  const merged = { ...blank, ...values };
  render(<PropertyRows settings={{}} values={merged} onChange={onChange} projectId={1} allTasks={[]} branches={branches} taskId={5} {...extra} />);
  return { onChange };
}

beforeEach(() => resetLabelsCache());

it("keeps the optional rows back until they hold a value", () => {
  setup();
  expect(screen.queryByText("Labels")).not.toBeInTheDocument();
  expect(screen.queryByText("Due date")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add property" })).toBeInTheDocument();
});

it("a row with a value shows without being added", () => {
  setup({ due_date: "2026-11-09" });
  expect(screen.getByText("Due date")).toBeInTheDocument();
  expect(screen.queryByText("Start date")).not.toBeInTheDocument();
});

it("the menu adds a row and opens its picker", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Add property" }));
  const menu = await screen.findByRole("listbox");
  expect(within(menu).getAllByRole("option").map((o) => o.textContent)).toEqual(["Labels", "Start date", "Due date"]);
  await userEvent.click(within(menu).getByRole("option", { name: "Due date" }));
  expect(screen.getByText("Due date")).toBeInTheDocument();
  expect(await screen.findByLabelText("Due date", { selector: "input" })).toBeInTheDocument();
  // what was added is no longer offered
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Add property" }));
  expect(within(await screen.findByRole("listbox")).queryByRole("option", { name: "Due date" })).not.toBeInTheDocument();
});

it("settings keep a property out of the menu", async () => {
  render(<PropertyRows settings={{ hidden: ["labels", "start_date"] }} values={blank} onChange={vi.fn()} projectId={1} allTasks={[]} branches={branches} taskId={5} />);
  await userEvent.click(screen.getByRole("button", { name: "Add property" }));
  expect(within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Due date"]);
});

it("picks a date and clears it", async () => {
  const { onChange } = setup({ due_date: "2026-11-09" });
  await userEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Clear date" }));
  expect(onChange).toHaveBeenCalledWith({ due_date: null });
});

it("a date can be set in a status where everything else is locked", async () => {
  const { onChange } = setup({ due_date: "2026-11-09" }, { status: "in_progress" });
  // the assignee is locked in a working card, the plan is not
  expect(screen.getByRole("button", { name: /^Assignee:/ })).toBeDisabled();
  const due = screen.getByRole("button", { name: /^Due date:/ });
  expect(due).toBeEnabled();
  await userEvent.click(due);
  await userEvent.click(await screen.findByRole("button", { name: "Clear date" }));
  expect(onChange).toHaveBeenCalledWith({ due_date: null });
});

it("a due date in the past on an open card is marked, and on a finished one it is not", () => {
  const { unmount } = render(
    <PropertyRows settings={{}} values={{ ...blank, due_date: "2000-01-01" }} onChange={vi.fn()} projectId={1} allTasks={[]} branches={branches} taskId={5} status="todo" />,
  );
  expect(screen.getByRole("button", { name: /Overdue/ })).toBeInTheDocument();
  unmount();
  render(<PropertyRows settings={{}} values={{ ...blank, due_date: "2000-01-01" }} onChange={vi.fn()} projectId={1} allTasks={[]} branches={branches} taskId={5} status="done" />);
  expect(screen.queryByRole("button", { name: /Overdue/ })).not.toBeInTheDocument();
});

it("toggles labels and creates a new one from the typed name", async () => {
  const { onChange } = setup({ labels: ["bug"] });
  await userEvent.click(screen.getByRole("button", { name: /^Labels:/ }));
  const list = await screen.findByRole("listbox", { name: "Labels" });
  expect(within(list).getByRole("option", { name: "bug" })).toHaveAttribute("aria-selected", "true");
  await userEvent.click(within(list).getByRole("option", { name: "ui" }).querySelector("button")!);
  expect(onChange).toHaveBeenLastCalledWith({ labels: ["bug", "ui"] });
  await userEvent.click(within(list).getByRole("option", { name: "bug" }).querySelector("button")!);
  expect(onChange).toHaveBeenLastCalledWith({ labels: [] });
  await userEvent.type(screen.getByLabelText("Find or create a label"), "brand new{Enter}");
  expect(onChange).toHaveBeenLastCalledWith({ labels: ["bug", "brand new"] });
});

it("the status row offers the backlog and To do, and is locked while a session works", async () => {
  const onStatusChange = vi.fn();
  const { unmount } = render(
    <PropertyRows settings={{}} values={blank} onChange={vi.fn()} projectId={1} allTasks={[]} branches={branches} taskId={5} status="backlog" onStatusChange={onStatusChange} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /^Status:/ }));
  const list = await screen.findByRole("listbox");
  expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["To do"]);
  await userEvent.click(within(list).getByRole("option", { name: /To do/ }));
  expect(onStatusChange).toHaveBeenCalledWith("todo");
  unmount();
  for (const status of ["in_progress", "verifying", "merging"] as const) {
    const view = render(
      <PropertyRows settings={{}} values={blank} onChange={vi.fn()} projectId={1} allTasks={[]} branches={branches} taskId={5} status={status} onStatusChange={onStatusChange} />,
    );
    expect(screen.getByRole("button", { name: /^Status:/ })).toBeDisabled();
    view.unmount();
  }
});

it("the creation form's pills use the same menu", async () => {
  const onChange = vi.fn();
  render(<PropertyPills settings={{}} values={blank} onChange={onChange} projectId={1} allTasks={[]} branches={branches} />);
  await userEvent.click(screen.getByRole("button", { name: "Add property" }));
  await userEvent.click(await screen.findByRole("option", { name: "Labels" }));
  expect(screen.getByRole("button", { name: /^Labels:/ })).toBeInTheDocument();
});

it("Enter closes the date panel, and the due date cannot go before the start", async () => {
  setup({ start_date: "2026-11-03", due_date: "2026-11-09" });
  await userEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
  const input = await screen.findByLabelText("Due date", { selector: "input" });
  expect(input).toHaveAttribute("min", "2026-11-03");
  await userEvent.type(input, "{Enter}");
  await waitFor(() => expect(screen.queryByLabelText("Due date", { selector: "input" })).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /^Start date:/ }));
  expect(await screen.findByLabelText("Start date", { selector: "input" })).toHaveAttribute("max", "2026-11-09");
});
