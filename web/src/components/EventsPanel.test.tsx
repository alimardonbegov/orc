import { render, screen, waitFor, within } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { EventsPanel } from "./EventsPanel";
import { api, ApiError } from "../api";
import type { OrcEvent } from "../types";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { events: vi.fn(), markEventsRead: vi.fn(async () => ({ ok: true })) } };
});

/** A feed event with the join fields filled with defaults: only the differences matter in the tests. */
function event(over: Partial<OrcEvent> & Pick<OrcEvent, "id">): OrcEvent {
  return {
    task_id: null,
    project_id: null,
    level: "info",
    message: "event",
    is_read: 1,
    created_at: "2026-01-01T09:00:00+00:00",
    project_name: null,
    task_title: null,
    task_status: null,
    ...over,
  };
}

it("shows the unread counter and puts it in the title", async () => {
  (api.events as any).mockResolvedValue([
    event({ id: 1, task_id: 3, project_id: 1, level: "warn", message: "#3 is waiting for a reply", is_read: 0, created_at: "2026-01-01T10:00:00+00:00" }),
    event({ id: 2, task_id: 3, project_id: 1, message: "#3 started" }),
  ]);
  render(<EventsPanel open={true} onToggle={vi.fn()} />);
  expect(await screen.findByText("#3 is waiting for a reply")).toBeInTheDocument();
  await waitFor(() => expect(document.title).toBe("(1) orc"));
  expect(screen.getByText("1")).toBeInTheDocument();
});

it("a rejected POST /api/events/read (500) does not crash the promise and the error text is visible to the user", async () => {
  (api.events as any).mockResolvedValue([
    event({ id: 1, task_id: 3, project_id: 1, level: "warn", message: "#3 is waiting for a reply", is_read: 0, created_at: "2026-01-01T10:00:00+00:00" }),
  ]);
  (api.markEventsRead as any).mockRejectedValue(new ApiError(500, "server hiccup"));

  const onUnhandledRejection = vi.fn();
  process.on("unhandledRejection", onUnhandledRejection);

  const user = userEvent.setup();
  render(<EventsPanel open={true} onToggle={vi.fn()} />);
  await screen.findByText("#3 is waiting for a reply");

  await user.click(screen.getByRole("button", { name: "Mark read" }));

  expect(await screen.findByText("server hiccup")).toBeInTheDocument();

  // give an unhandled rejection a chance to surface if .catch() were missing
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(onUnhandledRejection).not.toHaveBeenCalled();

  process.off("unhandledRejection", onUnhandledRejection);
});

it("with several projects the row shows whose project it is and what the task is", async () => {
  (api.events as any).mockResolvedValue([
    event({
      id: 1,
      task_id: 12,
      project_id: 1,
      level: "warn",
      message: "#12 is waiting for a reply",
      project_name: "Orchestrator API",
      task_title: "Limits on the page",
    }),
    event({ id: 2, task_id: 4, project_id: 2, message: "#4 started", project_name: "Web client", task_title: "Dark theme" }),
  ]);
  render(<EventsPanel open={true} onToggle={vi.fn()} />);

  expect(await screen.findByText("Limits on the page")).toBeInTheDocument();
  expect(screen.getByText("Dark theme")).toBeInTheDocument();
  // The project monogram: "Orchestrator API" -> OA, "Web client" -> WC
  expect(screen.getByText("OA")).toBeInTheDocument();
  expect(screen.getByText("WC")).toBeInTheDocument();
});

it("with a single project the project label is not drawn: there is nothing to tell apart", async () => {
  (api.events as any).mockResolvedValue([
    event({ id: 1, task_id: 12, project_id: 1, message: "#12 started", project_name: "Orchestrator API", task_title: "Limits" }),
    event({ id: 2, task_id: 13, project_id: 1, message: "#13 started", project_name: "Orchestrator API", task_title: "Branches" }),
  ]);
  render(<EventsPanel open={true} onToggle={vi.fn()} />);

  expect(await screen.findByText("Limits")).toBeInTheDocument();
  expect(screen.queryByText("OA")).not.toBeInTheDocument();
});

it("\"All events\" opens a large window with filters by project and level", async () => {
  (api.events as any).mockResolvedValue([
    event({
      id: 1,
      task_id: 12,
      project_id: 1,
      level: "error",
      message: "#12 failed",
      project_name: "Orchestrator API",
      task_title: "Limits on the page",
      task_status: "failed",
    }),
    event({
      id: 2,
      task_id: 4,
      project_id: 2,
      level: "success",
      message: "#4 merged into dev",
      project_name: "Web client",
      task_title: "Dark theme",
      task_status: "done",
    }),
  ]);

  const user = userEvent.setup();
  render(<EventsPanel open={true} onToggle={vi.fn()} />);
  await screen.findByText("#12 failed");

  await user.click(screen.getByRole("button", { name: /All events/ }));

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Limits on the page")).toBeInTheDocument();
  expect(within(dialog).getByText("Dark theme")).toBeInTheDocument();

  // The project filter leaves only its rows
  await user.click(within(dialog).getByRole("button", { name: /Web client/ }));
  expect(within(dialog).queryByText("Limits on the page")).not.toBeInTheDocument();
  expect(within(dialog).getByText("Dark theme")).toBeInTheDocument();

  // Reset brings both back
  await user.click(within(dialog).getByRole("button", { name: "Reset" }));
  expect(within(dialog).getByText("Limits on the page")).toBeInTheDocument();
});

it("search in the large window also matches the task title, which is not in the event text", async () => {
  (api.events as any).mockResolvedValue([
    event({ id: 1, task_id: 12, project_id: 1, message: "#12 started in orc/task-12", project_name: "A", task_title: "Limits on the page" }),
    event({ id: 2, task_id: 13, project_id: 1, message: "#13 started in orc/task-13", project_name: "A", task_title: "Project branches" }),
  ]);

  const user = userEvent.setup();
  render(<EventsPanel open={true} onToggle={vi.fn()} />);
  await screen.findByText("#12 started in orc/task-12");

  await user.click(screen.getByRole("button", { name: /All events/ }));
  const dialog = await screen.findByRole("dialog");

  await user.type(within(dialog).getByLabelText("Search events"), "limits");
  expect(within(dialog).getByText("Limits on the page")).toBeInTheDocument();
  expect(within(dialog).queryByText("Project branches")).not.toBeInTheDocument();
});

it("clicking a row in the large window closes it and opens the task", async () => {
  (api.events as any).mockResolvedValue([
    event({ id: 1, task_id: 12, project_id: 1, message: "#12 failed", level: "error", project_name: "A", task_title: "Limits" }),
  ]);
  const onOpenTask = vi.fn();

  const user = userEvent.setup();
  render(<EventsPanel open={true} onToggle={vi.fn()} onOpenTask={onOpenTask} />);
  await screen.findByText("#12 failed");

  await user.click(screen.getByRole("button", { name: /All events/ }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByText("Limits"));

  expect(onOpenTask).toHaveBeenCalledWith(12);
  // Specifically by the search field: the dropdown panel under the modal is also role="dialog",
  // and after the window closes it ends up in the role query again.
  await waitFor(() => expect(screen.queryByLabelText("Search events")).not.toBeInTheDocument());
});

it("in the expanded column the bell is a row with a label, in the collapsed rail it is a single icon", async () => {
  (api.events as any).mockResolvedValue([event({ id: 1, message: "#1 started", is_read: 0 })]);

  const wide = render(<EventsPanel open={false} onToggle={vi.fn()} />);
  expect(await screen.findByText("Events")).toBeInTheDocument();
  wide.unmount();

  render(<EventsPanel open={false} onToggle={vi.fn()} collapsed />);
  // There is no label in the rail, but the button stays named — for the screen reader and the tooltip
  await waitFor(() => expect(screen.getByRole("button", { name: /Events/ })).toBeInTheDocument());
  expect(screen.queryByText("Events")).not.toBeInTheDocument();
});
