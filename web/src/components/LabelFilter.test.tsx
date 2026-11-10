import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { resetLabelsCache } from "../hooks/useLabels";
import { LabelFilter } from "./LabelFilter";

vi.mock("../api", () => ({ api: { listLabels: vi.fn() } }));

const labels = [
  { id: 1, name: "bug", color: "#ff0000", task_count: 2 },
  { id: 2, name: "ui", color: "#00ff00", task_count: 1 },
];

beforeEach(() => {
  resetLabelsCache();
  (api.listLabels as any).mockReset();
});

it("is not drawn while there are no labels", async () => {
  (api.listLabels as any).mockResolvedValue([]);
  const { container } = render(<LabelFilter value={null} onChange={vi.fn()} />);
  await Promise.resolve();
  expect(container).toBeEmptyDOMElement();
});

it("picks a label and clears it", async () => {
  (api.listLabels as any).mockResolvedValue(labels);
  const onChange = vi.fn();
  const { rerender } = render(<LabelFilter value={null} onChange={onChange} />);
  await userEvent.click(await screen.findByRole("button", { name: "Label" }));
  await userEvent.click(await screen.findByRole("option", { name: /bug/ }));
  expect(onChange).toHaveBeenCalledWith(1);
  rerender(<LabelFilter value={1} onChange={onChange} />);
  expect(screen.getByRole("button", { name: "Label: bug" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(screen.getByRole("button", { name: "Show all labels" }));
  expect(onChange).toHaveBeenLastCalledWith(null);
});

it("lets go of a label that was deleted while the board was narrowed to it", async () => {
  (api.listLabels as any).mockResolvedValue(labels);
  const onChange = vi.fn();
  render(<LabelFilter value={99} onChange={onChange} />);
  await screen.findByRole("button", { name: /Label/ });
  expect(onChange).toHaveBeenCalledWith(null);
});
