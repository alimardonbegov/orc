import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { QuickActionsEditor } from "./QuickActionsEditor";
import { QuickActionsSection } from "./QuickActionsSection";

const actions = [
  { id: "review", title: "Review", prompt: "Review it." },
  { id: "tests", title: "Tests", prompt: "Write tests." },
];

it("a click sends the action's text through the card's own command runner", async () => {
  const send = vi.fn(async () => ({}));
  const run = vi.fn(async (fn: () => Promise<unknown>) => (await fn(), true));
  render(<QuickActionsSection actions={actions} send={send} pending={false} run={run} />);
  await userEvent.click(screen.getByRole("button", { name: "Tests" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("Write tests."));
  expect(run).toHaveBeenCalledTimes(1);
});

it("the actions are disabled and say why where the agent cannot be reached, and while a command runs", () => {
  const run = vi.fn(async () => true);
  const { rerender } = render(<QuickActionsSection actions={actions} send={null} pending={false} run={run} />);
  expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
  expect(screen.getByText("The agent cannot take a message in this state.")).toBeInTheDocument();
  rerender(<QuickActionsSection actions={actions} send={vi.fn()} pending run={run} />);
  expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
});

it("an empty set shows no section; half-filled actions are not offered", () => {
  const run = vi.fn(async () => true);
  const { container, rerender } = render(<QuickActionsSection actions={[]} send={vi.fn()} pending={false} run={run} />);
  expect(container).toBeEmptyDOMElement();
  rerender(<QuickActionsSection actions={[{ id: "a", title: "", prompt: "x" }]} send={vi.fn()} pending={false} run={run} />);
  expect(container).toBeEmptyDOMElement();
});

it("the editor shows the built-in set, stores the whole list on the first edit and restores the set", async () => {
  const onChange = vi.fn();
  const { rerender } = render(<QuickActionsEditor value={{}} onChange={onChange} />);
  expect(screen.getAllByLabelText("Title")).toHaveLength(4);
  expect(screen.getByRole("button", { name: "Restore the built-in set" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Remove Review" }));
  expect(onChange.mock.calls[0][0].quick_actions.map((a: { id: string }) => a.id)).toEqual(["tests", "summary", "simplify"]);

  rerender(<QuickActionsEditor value={{ quick_actions: actions }} onChange={onChange} />);
  await userEvent.click(screen.getByRole("button", { name: "Move Review down" }));
  expect(onChange.mock.lastCall![0].quick_actions.map((a: { id: string }) => a.id)).toEqual(["tests", "review"]);
  expect(screen.getByRole("button", { name: "Move Review up" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Add an action" }));
  expect(onChange.mock.lastCall![0].quick_actions).toHaveLength(3);
  await userEvent.click(screen.getByRole("button", { name: "Restore the built-in set" }));
  expect(onChange.mock.lastCall![0].quick_actions).toBeUndefined();
});

it("editing a title or a text changes only that action", async () => {
  const onChange = vi.fn();
  render(<QuickActionsEditor value={{ quick_actions: [actions[0]] }} onChange={onChange} />);
  await userEvent.type(screen.getByLabelText("Text for the agent"), "!");
  expect(onChange.mock.lastCall![0].quick_actions).toEqual([{ ...actions[0], prompt: "Review it.!" }]);
});
