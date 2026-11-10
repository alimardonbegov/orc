import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { WakeupsSection } from "./WakeupsSection";
import { api } from "../api";
import type { TaskDetail, Wakeup } from "../types";
import { wakeTime } from "../wakeups";

vi.mock("../api", () => ({
  api: { taskWakeups: vi.fn(), cancelWakeup: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const task = {
  id: 7, project_id: 1, title: "Port", description: "", status: "in_progress", priority: "normal", blocker: "sleeping",
  blocker_detail: "asleep until #3 is done", target_branch: "main", job_id: "j3", session_id: "s", updated_at: "u1",
  comments: [], outbox: [],
} as unknown as TaskDetail;

function wakeup(id: number, fields: Partial<Wakeup> = {}): Wakeup {
  return {
    id, task_id: 7, kind: "at", wake_at: "2026-11-08T15:30:00+00:00", watch_task_id: null, note: "", state: "pending",
    reason: null, created_at: "2026-11-08T14:00:00+00:00", ended_at: null, ...fields,
  };
}

function show(list: Wakeup[], fields: Partial<TaskDetail> = {}, onOpenTask = vi.fn()) {
  (api.taskWakeups as any).mockResolvedValue(list);
  const onAction = vi.fn(async (action: () => Promise<unknown>) => {
    await action();
    return true;
  });
  render(<WakeupsSection task={{ ...task, ...fields }} pending={false} onAction={onAction} onOpenTask={onOpenTask} />);
  return { onAction, onOpenTask };
}

it("a card whose agent never asked for a wakeup shows no section", async () => {
  show([]);
  await waitFor(() => expect(api.taskWakeups).toHaveBeenCalledWith(7));
  expect(screen.queryByText("Wakeups")).not.toBeInTheDocument();
});

it("pending wakeups show their condition and note, and the watched card opens", async () => {
  const { onOpenTask } = show([
    wakeup(1, { kind: "task", watch_task_id: 3, wake_at: null, note: "check the merge" }),
    wakeup(2),
  ]);
  expect(await screen.findByText("Wakeups")).toBeInTheDocument();
  expect(screen.getByText("check the merge")).toBeInTheDocument();
  expect(screen.getByText(`At ${wakeTime("2026-11-08T15:30:00+00:00", "en")}`)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "When #3 is done" }));
  expect(onOpenTask).toHaveBeenCalledWith(3);
});

it("Cancel cancels that wakeup through the card's action path", async () => {
  (api.cancelWakeup as any).mockResolvedValue(wakeup(1, { state: "cancelled" }));
  const { onAction } = show([wakeup(1)]);
  await userEvent.click(await screen.findByRole("button", { name: "Cancel the wakeup" }));
  expect(onAction).toHaveBeenCalled();
  expect(api.cancelWakeup).toHaveBeenCalledWith(7, 1);
});

it("a sleeper with nothing left to wake it says what the owner can do, and the history is folded", async () => {
  show([wakeup(1, { state: "cancelled", reason: "cancelled by the owner" })]);
  expect(await screen.findByText(/Nothing will wake this card/)).toBeInTheDocument();
  expect(screen.queryByText(/cancelled by the owner/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "History (1)" }));
  expect(screen.getByText(/cancelled by the owner/)).toBeInTheDocument();
});

it("a deadline joins a card condition", async () => {
  show([wakeup(1, { kind: "task", watch_task_id: 3 })]);
  expect(await screen.findByRole("button", { name: `When #3 is done, at the latest ${wakeTime("2026-11-08T15:30:00+00:00", "en")}` })).toBeInTheDocument();
});
