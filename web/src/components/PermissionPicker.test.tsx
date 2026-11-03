import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { PermissionPicker } from "./PermissionPicker";

it("the modes are named as in Claude Code, and the description sits next to them", () => {
  render(<PermissionPicker value={null} onChange={vi.fn()} defaultLabel="project default" />);
  expect(screen.getByRole("option", { name: "acceptEdits — file edits without asking" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /^bypassPermissions —/ })).toBeInTheDocument();
});

it("choosing a mode returns the identifier from the CLI", async () => {
  const onChange = vi.fn();
  render(<PermissionPicker value={null} onChange={onChange} defaultLabel="project default" />);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Permission mode" }), "bypassPermissions");
  expect(onChange).toHaveBeenCalledWith("bypassPermissions");
});

it("under the field it explains the selected mode in plain words", () => {
  render(<PermissionPicker value="dontAsk" onChange={vi.fn()} defaultLabel="project default" />);
  expect(screen.getByText(/isn't pre-approved/)).toBeInTheDocument();
});

it("without defaultLabel there is no empty option: a project always has a mode set", () => {
  render(<PermissionPicker value="auto" onChange={vi.fn()} />);
  expect(screen.getAllByRole("option")).toHaveLength(4);
});
