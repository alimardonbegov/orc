import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { ModelVisibility } from "./ModelVisibility";

it("a removed checkbox hides the model, a checked one brings it back", async () => {
  const onChange = vi.fn();
  const { rerender } = render(<ModelVisibility hidden={[]} onChange={onChange} />);
  await userEvent.click(screen.getByRole("checkbox", { name: "Opus 5" }));
  expect(onChange).toHaveBeenLastCalledWith(["claude-opus-5"]);

  rerender(<ModelVisibility hidden={["claude-opus-5"]} onChange={onChange} />);
  expect(screen.getByRole("checkbox", { name: "Opus 5" })).not.toBeChecked();
  await userEvent.click(screen.getByRole("checkbox", { name: "Opus 5" }));
  expect(onChange).toHaveBeenLastCalledWith([]);
});

it("\"Show all\" brings back all known models, but does not touch foreign ids", async () => {
  const onChange = vi.fn();
  render(<ModelVisibility hidden={["claude-opus-5", "claude-sonnet-5", "custom-x"]} onChange={onChange} />);
  expect(screen.getByText(/2 of \d+ hidden/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show all" }));
  expect(onChange).toHaveBeenLastCalledWith(["custom-x"]);
});
