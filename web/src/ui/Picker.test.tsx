import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Picker, PickerTrigger, type PickerOption } from "./Picker";

const options: PickerOption<number | null>[] = [
  { value: null, label: "Unassigned", pinned: true },
  { value: 1, label: "Lena", hint: "Reviews code" },
  { value: 2, label: "Max", hint: "Writes tests" },
];

const setup = (props: Partial<React.ComponentProps<typeof Picker<number | null>>> = {}) => {
  const onChange = vi.fn();
  const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
  render(
    <form onSubmit={onSubmit}>
      <Picker label="Assignee" trigger={<PickerTrigger>Open</PickerTrigger>} options={options} value={1} onChange={onChange} {...props} />
    </form>,
  );
  return { onChange, onSubmit };
};

const open = () => userEvent.click(screen.getByRole("button", { name: "Open" }));

it("marks the current value and reports the one picked", async () => {
  const { onChange } = setup();
  await open();
  expect(screen.getByRole("option", { name: /Lena/ })).toHaveAttribute("aria-selected", "true");
  await userEvent.click(screen.getByRole("option", { name: /Max/ }));
  expect(onChange).toHaveBeenCalledWith(2);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("picking the current value again is not a change", async () => {
  const { onChange } = setup();
  await open();
  await userEvent.click(screen.getByRole("option", { name: /Lena/ }));
  expect(onChange).not.toHaveBeenCalled();
});

it("works from the keyboard, and Enter does not submit the form underneath", async () => {
  const { onChange, onSubmit } = setup();
  await open();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenCalledWith(2);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("the search looks in the second line too, and Enter takes a match, never the pinned row", async () => {
  const { onChange } = setup({ searchable: true });
  await open();
  await userEvent.keyboard("tests");
  const list = screen.getByRole("listbox");
  expect(within(list).queryByRole("option", { name: /Lena/ })).not.toBeInTheDocument();
  // The pinned row stays in view, and it is not what the query asked for
  expect(within(list).getByRole("option", { name: /Unassigned/ })).toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith(2);
});

it("a query that matches nothing leaves Enter inert", async () => {
  const { onChange } = setup({ searchable: true });
  await open();
  await userEvent.keyboard("zzz{Enter}");
  expect(onChange).not.toHaveBeenCalled();
});

it("says why the list is empty", async () => {
  setup({ options: [], empty: "No agents yet" });
  await open();
  expect(screen.getByText("No agents yet")).toBeInTheDocument();
});
