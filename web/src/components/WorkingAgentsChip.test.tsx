import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { WorkingAgentsChip } from "./WorkingAgentsChip";
import type { Agent, Chat, Task } from "../types";

const agent = { id: 1, name: "Hermione", avatar: "" } as Agent;
const task = { id: 7, title: "Fix login", agent_id: 1 } as Task;
const chat = { id: 3, title: "Plan", agent_id: 1 } as Chat;

it("renders nothing when nobody works", () => {
  render(<WorkingAgentsChip working={[]} onOpenTask={vi.fn()} onOpenChat={vi.fn()} />);
  expect(screen.queryByTestId("working-agents-chip")).not.toBeInTheDocument();
});

it("lists agents with their cards and chats and opens them", async () => {
  const onOpenTask = vi.fn();
  const onOpenChat = vi.fn();
  render(<WorkingAgentsChip working={[{ agent, tasks: [task], chats: [chat] }]} onOpenTask={onOpenTask} onOpenChat={onOpenChat} />);
  await userEvent.click(screen.getByTestId("working-agents-chip"));
  await userEvent.click(await screen.findByText("Fix login"));
  expect(onOpenTask).toHaveBeenCalledWith(7);
  await userEvent.click(screen.getByTestId("working-agents-chip"));
  await userEvent.click(await screen.findByText("Plan"));
  expect(onOpenChat).toHaveBeenCalledWith(3);
});
