import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { NewTaskForm } from "./NewTaskForm";
import type { CardDraft } from "../types";

const { draftTask } = vi.hoisted(() => ({ draftTask: vi.fn() }));

vi.mock("../api", () => ({
  api: {
    draftTask,
    branches: vi.fn(async () => ({ current: "main", default_branch: null, base: "main", branches: ["main", "dev"], items: [] })),
  },
}));

const made: CardDraft = {
  draft: { title: "Fix the Save button", description: "Goal: make Save work.", priority: "high", agent_id: null, target_branch: "dev" },
  warnings: [],
  usage: { model: "haiku", tokens: 1200, cost_usd: 0.0023 },
};

const mount = (onSubmit = vi.fn()) =>
  render(<NewTaskForm projectId={1} allTasks={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);

beforeEach(() => draftTask.mockReset());

it("opens in manual mode with the ordinary form", async () => {
  mount();
  expect(screen.getByRole("radio", { name: "Manual", checked: true })).toBeInTheDocument();
  expect(screen.getByLabelText("Title")).toBeVisible();
  expect(screen.queryByLabelText("Describe the card in your own words")).not.toBeInTheDocument();
});

it("a phrase becomes a filled form that can be edited and submitted", async () => {
  draftTask.mockResolvedValue(made);
  const onSubmit = vi.fn();
  mount(onSubmit);
  await userEvent.click(screen.getByRole("radio", { name: "Describe" }));
  await userEvent.type(screen.getByLabelText("Describe the card in your own words"), "save button is broken");
  await userEvent.click(screen.getByRole("button", { name: "Draft the card" }));
  await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Fix the Save button"));
  expect(draftTask).toHaveBeenCalledWith(1, "save button is broken");
  expect(screen.getByText(/1,200 tokens/)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Title"), " now");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ title: "Fix the Save button now", priority: "high", target_branch: "dev" });
});

it("a failed model keeps the text and offers a retry", async () => {
  draftTask.mockRejectedValueOnce(new Error("the model did not answer in 90 seconds"));
  mount();
  await userEvent.click(screen.getByRole("radio", { name: "Describe" }));
  await userEvent.type(screen.getByLabelText("Describe the card in your own words"), "keep me");
  await userEvent.click(screen.getByRole("button", { name: "Draft the card" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("90 seconds");
  expect(screen.getByLabelText("Describe the card in your own words")).toHaveValue("keep me");
  draftTask.mockResolvedValueOnce(made);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Fix the Save button"));
});

it("switching to manual and back loses neither the typed form nor the phrase", async () => {
  mount();
  await userEvent.type(screen.getByLabelText("Title"), "By hand");
  await userEvent.click(screen.getByRole("radio", { name: "Describe" }));
  await userEvent.type(screen.getByLabelText("Describe the card in your own words"), "words");
  await userEvent.click(screen.getByRole("radio", { name: "Manual" }));
  expect(screen.getByLabelText("Title")).toHaveValue("By hand");
  await userEvent.click(screen.getByRole("radio", { name: "Describe" }));
  expect(screen.getByLabelText("Describe the card in your own words")).toHaveValue("words");
});
