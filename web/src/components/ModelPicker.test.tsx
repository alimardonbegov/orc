import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";

const renderPicker = (value: string | null, onChange = vi.fn()) => {
  render(<ModelPicker value={value} onChange={onChange} defaultLabel="project default" />);
  return onChange;
};

it("choosing a model from the list returns its identifier", async () => {
  const onChange = renderPicker(null);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), "claude-opus-5");
  expect(onChange).toHaveBeenCalledWith("claude-opus-5");
});

it("the empty option means \"not set\", not an empty string", async () => {
  const onChange = renderPicker("claude-opus-5");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), "");
  expect(onChange).toHaveBeenCalledWith(null);
});

it("a value saved manually is not lost: the control opens in manual entry mode", () => {
  renderPicker("claude-3-typo");
  expect(screen.getByRole("textbox", { name: /manual/ })).toHaveValue("claude-3-typo");
});

it("manual input is committed when focus leaves", async () => {
  const onChange = renderPicker(null);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), "__custom__");
  const field = screen.getByRole("textbox", { name: /manual/ });
  await userEvent.type(field, "claude-next-9");
  expect(onChange).not.toHaveBeenCalled();  // while typing, nothing is saved
  await userEvent.tab();
  expect(onChange).toHaveBeenCalledWith("claude-next-9");
});

it("hidden models do not appear in the list", () => {
  render(<ModelPicker value={null} onChange={vi.fn()} defaultLabel="project default" hidden={["claude-opus-5"]} />);
  const values = Array.from(screen.getByRole("combobox", { name: "Model" }).querySelectorAll("option")).map((o) => o.value);
  expect(values).not.toContain("claude-opus-5");
  expect(values).toContain("claude-opus-5-5");
});

it("an already selected hidden model stays visible with a mark, not replaced by the default value", () => {
  render(<ModelPicker value="claude-opus-5" onChange={vi.fn()} defaultLabel="project default" hidden={["claude-opus-5"]} />);
  const select = screen.getByRole("combobox", { name: "Model" });
  expect(select).toHaveValue("claude-opus-5");
  expect(screen.getByRole("option", { name: "Opus 5 (hidden)" })).toBeInTheDocument();
});
