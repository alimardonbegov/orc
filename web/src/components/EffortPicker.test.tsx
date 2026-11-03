import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { EffortPicker } from "./EffortPicker";

const renderPicker = (value: string | null, onChange = vi.fn()) => {
  render(<EffortPicker value={value} onChange={onChange} defaultLabel="project default" />);
  return onChange;
};

it("choosing a level from the list returns its identifier", async () => {
  const onChange = renderPicker(null);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Effort" }), "high");
  expect(onChange).toHaveBeenCalledWith("high");
});

it("the empty option means \"not set\", not an empty string", async () => {
  const onChange = renderPicker("high");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Effort" }), "");
  expect(onChange).toHaveBeenCalledWith(null);
});

it("a previously saved value outside the list is not lost: it stays as a selected option", () => {
  renderPicker("ultra");
  expect(screen.getByRole("combobox", { name: "Effort" })).toHaveValue("ultra");
  expect(screen.getByRole("option", { name: /set manually earlier/ })).toBeInTheDocument();
});
