import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, describe } from "vitest";
import { Board, DONE_PAGE_SIZE, byPosition, canMove, isForceMove, moveIssues, withWaitingFirst } from "./Board";
import type { Task } from "../types";

const base: Task = {
  id: 1, project_id: 1, title: "Do X", description: "", status: "todo", priority: "high", blocker: null,
  blocker_detail: null, target_branch: "dev", verify_cmd: null,
  requires_review: 0, worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0,
  state_miss_count: 0, quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null,
  merge_queued_at: null, retry_after: null,
  report_json: null, created_at: "", updated_at: "", done_at: null, archived_at: null, position: null, usage_json: null, depends_on: [2],
};

// A column is a <section> with an aria-label (see Column.tsx), i.e. an accessible region with a name.
// We look it up by role, not by DOM structure: column markup changes more often than its meaning.
const columnOf = (title: string): HTMLElement => screen.getByRole("region", { name: title });

it("renders four columns and a card with badges", () => {
  const tasks = [base, { ...base, id: 2, title: "Needs answer", status: "in_progress" as const, priority: "normal" as const, blocker: "needs_input" as const, depends_on: [] }];
  render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  for (const title of ["Backlog", "To do", "In progress", "Done"]) {
    expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
  }
  expect(screen.queryByRole("region", { name: "Verifying" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Merging" })).not.toBeInTheDocument();
  expect(screen.getByText("Do X")).toBeInTheDocument();
  expect(screen.getByText("waiting for reply")).toBeInTheDocument();
  expect(screen.getByText("high")).toBeInTheDocument();
  expect(screen.getByText("after #2")).toBeInTheDocument();
});

// The "after #N" badge is not a caption but a jump: from "what we are waiting for" to the blocking task itself,
// otherwise you would have to look for it by eye on the board.
it("the \"after #N\" badge opens the blocking task, not its own card", async () => {
  const onOpen = vi.fn();
  const tasks = [base, { ...base, id: 2, title: "Waiting on this", depends_on: [] }];
  render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={onOpen} onCreate={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "after #2" }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(2);
});

// Waiting cards in "In progress" sit on a separate shelf with a label: without it the column looks
// as if everything is working on its own. The badge label depends on the request kind, when the hook knows it.
it("tasks waiting for input are put on a shelf in \"In progress\", the badge names the request kind", () => {
  const request = { id: 1, task_id: 2, kind: "permission" as const, tool_name: "Bash", tool_input: {}, summary: "", state: "open" as const, created_at: "" };
  const tasks = [
    { ...base, id: 3, title: "Just working", status: "in_progress" as const, depends_on: [] },
    { ...base, id: 2, title: "Needs answer", status: "in_progress" as const, blocker: "needs_input" as const, input_request: request, depends_on: [] },
  ];
  render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  const inProgress = columnOf("In progress");
  expect(within(inProgress).getByText("Waiting for input")).toBeInTheDocument();
  expect(within(inProgress).getByText("Working")).toBeInTheDocument();
  expect(within(inProgress).getByText("waiting for permission")).toBeInTheDocument();
  const titles = within(inProgress).getAllByText(/Needs answer|Just working/).map((el) => el.textContent);
  expect(titles).toEqual(["Needs answer", "Just working"]);
});

it("without waiting tasks there is no shelf in \"In progress\"", () => {
  render(<Board projectId={1} tasks={[{ ...base, status: "in_progress", depends_on: [] }]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  expect(screen.queryByText("Waiting for input")).not.toBeInTheDocument();
  expect(screen.queryByText("Working")).not.toBeInTheDocument();
});

it("failed is shown in the Done column with a badge", () => {
  render(<Board projectId={1} tasks={[{ ...base, status: "failed" }]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  expect(screen.getByText("Failed")).toBeInTheDocument();
  expect(columnOf("Done")).toContainElement(screen.getByText("Do X"));
});

// There are no separate "Verify" and "Merge" columns any more: both stages sit in "In progress",
// and the stage is read from the badge on the card (the backend's FIFO merge queue mechanics are unchanged).
it("verifying and merging are shown in the \"In progress\" column with a stage badge", () => {
  const tasks = [
    { ...base, id: 3, title: "Being verified", status: "verifying" as const, depends_on: [] },
    { ...base, id: 4, title: "Queued for merge", status: "merging" as const, depends_on: [] },
  ];
  render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  const inProgress = columnOf("In progress");
  expect(inProgress).toContainElement(screen.getByText("Being verified"));
  expect(inProgress).toContainElement(screen.getByText("Queued for merge"));
  expect(screen.getByText("verifying")).toBeInTheDocument();
  expect(screen.getByText("merging")).toBeInTheDocument();
});

// The orchestrator hands a conflict with the target branch back to the task's session: the card is then
// in "In progress" again, and the badge should show that branches are being reconciled there, not code written.
it("a task resolving a conflict sits in \"In progress\" with a badge", () => {
  const tasks = [{ ...base, id: 5, title: "Resolving", status: "in_progress" as const, conflict_retry_count: 1, depends_on: [] }];
  render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  expect(columnOf("In progress")).toContainElement(screen.getByText("Resolving"));
  expect(screen.getByText("resolving conflict")).toBeInTheDocument();
});

it("there is no \"resolving conflict\" badge once the task has left In progress", () => {
  const tasks = [{ ...base, id: 6, title: "Finished", status: "done" as const, conflict_retry_count: 2, depends_on: [] }];
  render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  expect(screen.queryByText("resolving conflict")).not.toBeInTheDocument();
});

it("the card shows the message delivery state", () => {
  render(<Board projectId={1} tasks={[{ ...base, outbox_state: "sent" }]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  expect(screen.getByText("message sent to session")).toBeInTheDocument();
});

it("the card names a stalled delivery as such", () => {
  render(<Board projectId={1} tasks={[{ ...base, outbox_state: "stalled" }]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  expect(screen.getByText("message not picked up")).toBeInTheDocument();
});

// The manual-transition rule must match MANUAL_MOVES + FORCE_MOVES in orc/api.py exactly.
// This is where the brief was wrong (it had failed>backlog instead of failed>todo),
// so this block must tell the correct set from the wrong one.
describe("canMove: allowed manual transitions (as in orc/api.py)", () => {
  it("allows the four manual transitions of the backend", () => {
    expect(canMove("backlog", "todo")).toBe(true);
    expect(canMove("todo", "backlog")).toBe(true);
    expect(canMove("failed", "todo")).toBe(true);
    expect(canMove("done", "backlog")).toBe(true);
  });

  it("forbids failed -> backlog (the backend has no such transition)", () => {
    expect(canMove("failed", "backlog")).toBe(false);
  });

  it("forbids the automatic transitions of the dispatcher", () => {
    expect(canMove("todo", "in_progress")).toBe(false);
    expect(canMove("verifying", "merging")).toBe(false);
    expect(canMove("backlog", "in_progress")).toBe(false);
  });

  // The only door out of the working statuses: a stuck card is closed by hand
  // by dragging it to "Done". Everything else out of work is still not allowed by hand.
  it("allows emergency manual closing from any working status", () => {
    expect(canMove("in_progress", "done")).toBe(true);
    expect(canMove("verifying", "done")).toBe(true);
    expect(canMove("merging", "done")).toBe(true);
  });

  it("does not open the other directions out of work", () => {
    expect(canMove("in_progress", "backlog")).toBe(false);
    expect(canMove("in_progress", "todo")).toBe(false);
    expect(canMove("merging", "todo")).toBe(false);
  });

  it("does not allow a move to the same column", () => {
    expect(canMove("todo", "todo")).toBe(false);
    expect(canMove("backlog", "backlog")).toBe(false);
  });
});

// Exactly the emergency close requires confirmation: an ordinary move must not ask
// "are you sure" every time, otherwise people stop looking at the dialog and it loses its meaning.
describe("isForceMove: which move requires confirmation", () => {
  it("flags manual closing from the working statuses", () => {
    expect(isForceMove("in_progress", "done")).toBe(true);
    expect(isForceMove("verifying", "done")).toBe(true);
    expect(isForceMove("merging", "done")).toBe(true);
  });

  it("does not touch ordinary manual transitions", () => {
    expect(isForceMove("backlog", "todo")).toBe(false);
    expect(isForceMove("todo", "backlog")).toBe(false);
    expect(isForceMove("failed", "todo")).toBe(false);
    expect(isForceMove("done", "backlog")).toBe(false);
  });
});

// The agent session gets the task's description, not its title (orc/prompt.py), so a card
// with an empty description must not be allowed to go to "To work": the session would burn limits inventing
// work itself. The server rejects it the same way (orc/api.py, _check_description_for_work).
describe("moveIssues: an empty description is not let into work", () => {
  const empty = { ...base, description: "" };
  const spaces = { ...base, description: "   \n  " };
  const filled = { ...base, description: "fix login" };

  it("catches an empty and a whitespace-only description on a move to \"To work\"", () => {
    expect(moveIssues(empty, "todo")).toContain("description");
    expect(moveIssues(spaces, "todo")).toContain("description");
  });

  it("lets a task with a description through", () => {
    expect(moveIssues(filled, "todo")).not.toContain("description");
  });

  it("does not interfere with other moves: the rule is about work, not about an empty field in general", () => {
    expect(moveIssues(empty, "backlog")).not.toContain("description");
    expect(moveIssues(empty, "done")).not.toContain("description");
  });
});

describe("withWaitingFirst: cards waiting for an answer float to the top of the column", () => {
  const waiting = { ...base, id: 3, blocker: "needs_input" as const };
  const plain = { ...base, id: 4 };
  const conflict = { ...base, id: 5, blocker: "conflict" as const };

  it("lifts needs_input above the rest", () => {
    expect(withWaitingFirst([plain, waiting]).map((t) => t.id)).toEqual([3, 4]);
  });

  it("does not touch the order of the rest and does not lift other badges", () => {
    expect(withWaitingFirst([plain, conflict, waiting]).map((t) => t.id)).toEqual([3, 4, 5]);
  });

  it("does not mutate the source array", () => {
    const src = [plain, waiting];
    withWaitingFirst(src);
    expect(src.map((t) => t.id)).toEqual([4, 3]);
  });
});

// Reordering (backlog, "To work"): position sets the manual order, tasks that were never reordered
// (position=null) stay in id order, exactly as the board used to sort them.
describe("byPosition: manual order within a column", () => {
  it("sorts by position when it is set", () => {
    const a = { ...base, id: 1, position: 20 };
    const b = { ...base, id: 2, position: 10 };
    expect(byPosition([a, b]).map((t) => t.id)).toEqual([2, 1]);
  });

  it("ones never reordered (position=null) come after the ordered ones, in id order", () => {
    const positioned = { ...base, id: 1, position: 10 };
    const freshA = { ...base, id: 3, position: null, usage_json: null };
    const freshB = { ...base, id: 2, position: null, usage_json: null };
    expect(byPosition([freshA, positioned, freshB]).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("a column never touched by hand is sorted as before, by id", () => {
    const a = { ...base, id: 3 };
    const b = { ...base, id: 1 };
    const c = { ...base, id: 2 };
    expect(byPosition([a, b, c]).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("does not mutate the source array", () => {
    const src = [{ ...base, id: 2, position: 20 }, { ...base, id: 1, position: 10 }];
    byPosition(src);
    expect(src.map((t) => t.id)).toEqual([2, 1]);
  });
});

describe("board filters", () => {
  const tasks: Task[] = [
    { ...base, id: 1, title: "Fix login", status: "todo", blocker: null, depends_on: [] },
    { ...base, id: 2, title: "Update styles", status: "in_progress", blocker: "needs_input", depends_on: [] },
    { ...base, id: 3, title: "Ship release", status: "done", blocker: null, depends_on: [] },
  ];
  const render3 = (props: Partial<React.ComponentProps<typeof Board>> = {}) =>
    render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} {...props} />);

  it("search narrows the board by title and by number", () => {
    const { unmount } = render3({ search: "login" });
    expect(screen.getByText("Fix login")).toBeInTheDocument();
    expect(screen.queryByText("Update styles")).not.toBeInTheDocument();
    unmount();

    render3({ search: "#3" });
    expect(screen.getByText("Ship release")).toBeInTheDocument();
    expect(screen.queryByText("Fix login")).not.toBeInTheDocument();
  });

  it("\"waiting for me\" keeps only tasks stuck on the human", () => {
    render3({ attentionOnly: true });
    expect(screen.getByText("Update styles")).toBeInTheDocument();
    expect(screen.queryByText("Fix login")).not.toBeInTheDocument();
    expect(screen.queryByText("Ship release")).not.toBeInTheDocument();
  });

  it("the \"Done\" column can be removed from the board entirely", () => {
    render3({ showDone: false });
    expect(screen.queryByRole("region", { name: "Done" })).not.toBeInTheDocument();
    expect(screen.queryByText("Ship release")).not.toBeInTheDocument();
    expect(screen.getByText("Fix login")).toBeInTheDocument();
  });
});

describe("archive", () => {
  const archived: Task = { ...base, id: 9, title: "Archived one", status: "done", archived_at: "2026-09-21T10:00:00+00:00", depends_on: [] };

  it("archived cards are not shown on the board by default", () => {
    render(<Board projectId={1} tasks={[base, archived]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByText("Do X")).toBeInTheDocument();
    expect(screen.queryByText("Archived one")).not.toBeInTheDocument();
  });

  it("the archive view shows only removed tasks and marks them with a badge", () => {
    render(<Board projectId={1} tasks={[base, archived]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} showArchived />);
    expect(screen.getByText("Archived one")).toBeInTheDocument();
    expect(screen.queryByText("Do X")).not.toBeInTheDocument();
    expect(screen.getByText("archived")).toBeInTheDocument();
    // The "Done" column is always present in the archive: most removed cards end up there.
    expect(columnOf("Done")).toContainElement(screen.getByText("Archived one"));
  });

  it("in the archive view the \"Done\" filter does not hide the column", () => {
    render(
      <Board projectId={1} tasks={[archived]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} showArchived showDone={false} />,
    );
    expect(screen.getByRole("region", { name: "Done" })).toBeInTheDocument();
  });
});

// Regression: a column with a long list squeezed the cards instead of scrolling. A card is
// a flex item in a flex-container column, and flex-shrink defaults to 1: the browser
// flattened the rows to a few pixels just to fit the list into the column height, and
// scrolling therefore never kicked in (scrollHeight matched clientHeight).
// jsdom does not compute heights, so we check the layout contract itself: the card does not shrink,
// and the column's list is scrollable.
describe("a long list in a column", () => {
  const cardOf = (title: string) => screen.getByText(title).closest('[role="button"]') as HTMLElement;
  const listOf = (title: string) => columnOf(title).querySelector("[data-column-list]") as HTMLElement;

  it("the card keeps its height instead of being flattened to fit the column", () => {
    // The stubs have no timestamps, so the default order ("newest first")
    // separates them with a tie-break on the number: the task with the highest id is on top, and the first chunk is
    // the top DONE_PAGE_SIZE cards.
    const done = Array.from({ length: DONE_PAGE_SIZE + 5 }, (_, i) => ({
      ...base, id: 100 + i, title: `Finished ${i}`, status: "done" as const, depends_on: [],
    }));
    render(<Board projectId={1} tasks={done} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(cardOf(`Finished ${done.length - 1}`).className).toContain("shrink-0");
    expect(cardOf(`Finished ${done.length - DONE_PAGE_SIZE}`).className).toContain("shrink-0");
  });

  it("the column's list scrolls inside itself and does not drag its neighbours along", () => {
    render(<Board projectId={1} tasks={[base]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    for (const title of ["Backlog", "To do", "In progress", "Done"]) {
      const list = listOf(title);
      expect(list.className).toContain("overflow-y-auto");
      expect(list.className).toContain("overscroll-contain");
    }
  });
});


/* The "Done" column is the only archive on the board: it grows without a ceiling, and people look at it
   from the end ("what closed last"). So, unlike the working columns, it
   has its own selectable order and a first chunk instead of the whole list at once. */
describe("order in the \"Done\" column", () => {
  // Card titles in the column from top to bottom: the order is exactly what is being checked.
  const titlesIn = (column: string): string[] =>
    [...columnOf(column).querySelectorAll('[role="button"]')].map((el) =>
      (el.querySelector(".line-clamp-3")?.textContent ?? "").trim(),
    );

  const closed = (id: number, title: string, at: string): Task => ({
    ...base, id, title, status: "done" as const, done_at: at, depends_on: [],
  });

  const three = [
    closed(1, "Old", "2026-01-10T00:00:00+00:00"),
    closed(2, "Fresh", "2026-03-20T00:00:00+00:00"),
    closed(3, "Middle", "2026-02-15T00:00:00+00:00"),
  ];

  const board = (props: Partial<React.ComponentProps<typeof Board>> = {}) =>
    render(
      <Board
        projectId={1} tasks={three} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()}
        onOpen={vi.fn()} onCreate={vi.fn()} {...props}
      />,
    );

  it("by default the most recently closed tasks are on top", () => {
    board();
    expect(titlesIn("Done")).toEqual(["Fresh", "Middle", "Old"]);
  });

  it("the board applies the chosen order immediately", () => {
    board({ doneSort: "oldest" });
    expect(titlesIn("Done")).toEqual(["Old", "Middle", "Fresh"]);
  });

  it("the menu in the column header passes the choice out: UI state remembers it", async () => {
    const onDoneSortChange = vi.fn();
    board({ onDoneSortChange });
    await userEvent.click(screen.getByRole("button", { name: "Order: Newest first" }));
    await userEvent.click(screen.getByRole("radio", { name: /Failures first/ }));
    expect(onDoneSortChange).toHaveBeenCalledWith("failed");
  });

  // The archive is cut into days: where "today" ends and the old stuff begins is visible from the heading,
  // not from captions on every card. The year is not the current one: it is in the heading too.
  const headingsIn = (column: string): string[] =>
    [...columnOf(column).querySelectorAll("[data-day-heading]")].map((el) => el.firstChild?.textContent ?? "");

  it("chronological order is split into days", () => {
    // "Today" and the presence of a year depend on the current date: we pin it and leave the timers alone.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 2, 20, 18));
    // Noon local time: in any time zone this is the same calendar day.
    const noon = (month: number, day: number) => new Date(2026, month, day, 12).toISOString();
    try {
      board({ tasks: [closed(1, "Old", noon(0, 10)), closed(2, "Fresh", noon(2, 20)), closed(3, "Middle", noon(1, 15))] });
      expect(headingsIn("Done")).toEqual(["Today", "February 15", "January 10"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("there are no days in \"failures first\": the order there is not by time", () => {
    board({ doneSort: "failed" });
    expect(headingsIn("Done")).toEqual([]);
  });

  // The menu is a property of the archive. In the working columns the order is either set by hand (backlog,
  // "To work") or means nothing ("In progress"), and an extra control there is just noise.
  it("the working columns have no order menu", () => {
    board({ onDoneSortChange: vi.fn() });
    expect(screen.getAllByRole("button", { name: /^Order:/ })).toHaveLength(1);
    expect(columnOf("Done")).toContainElement(screen.getByRole("button", { name: /^Order:/ }));
  });
});

/* A month of work in the archive is hundreds of rows, and drawing them all for the sake of the top two is pointless.
   The column shows the first chunk, the rest is loaded with a button. */
describe("chunks in the \"Done\" column", () => {
  const many = Array.from({ length: DONE_PAGE_SIZE + 3 }, (_, i) => ({
    ...base, id: 100 + i, title: `Finished ${i}`, status: "done" as const,
    done_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00+00:00`, depends_on: [],
  }));
  const cardsIn = (column: string) => columnOf(column).querySelectorAll('[role="button"]');

  const renderMany = () =>
    render(<Board projectId={1} tasks={many} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);

  it("only the first chunk is drawn right away, and the column counter tells the truth", () => {
    renderMany();
    expect(cardsIn("Done")).toHaveLength(DONE_PAGE_SIZE);
    expect(columnOf("Done").querySelector(".tnum")?.textContent).toBe(String(many.length));
  });

  it("the button loads the remaining cards", async () => {
    renderMany();
    await userEvent.click(screen.getByRole("button", { name: /Show \d+ more/ }));
    expect(cardsIn("Done")).toHaveLength(many.length);
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  it("a short list does not grow a button", () => {
    render(<Board projectId={1} tasks={[{ ...base, status: "done" }]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });
});

describe("tokens", () => {
  const usage = (total: number) =>
    JSON.stringify({ total: { input: 1, cache_creation: 0, cache_read: total - 2, output: 1 }, total_tokens: total });

  it("a finished card shows a token badge, and the \"Done\" column shows the sum", () => {
    const tasks = [
      { ...base, id: 1, status: "done" as const, depends_on: [], usage_json: usage(4_250_000) },
      { ...base, id: 2, status: "failed" as const, depends_on: [], usage_json: usage(750_000) },
      { ...base, id: 3, status: "done" as const, depends_on: [], usage_json: null },
    ];
    render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByText("4,3M")).toBeInTheDocument();
    expect(screen.getByText("750k")).toBeInTheDocument();
    expect(within(columnOf("Done")).getByText("5M")).toBeInTheDocument();
    // The tooltip with the breakdown hangs on the badge itself (title), not on the card
    expect(screen.getByText("4,3M").closest("[title]")).toHaveAttribute("title", expect.stringContaining("total tokens 4"));
  });

  it("without a count or with zero there is no badge, and no sum is drawn in the column", () => {
    const tasks = [
      { ...base, id: 1, status: "done" as const, depends_on: [], usage_json: null },
      { ...base, id: 2, status: "done" as const, depends_on: [], usage_json: usage(0) },
    ];
    render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(document.querySelector("[title^='total tokens']")).toBeNull();
  });
});

it("a scheduled task shows a countdown to its start", () => {
  const at = new Date(Date.now() + (2 * 60 + 15) * 60_000 + 30_000).toISOString();
  const tasks = [{ ...base, depends_on: [], start_after: at }];
  render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  expect(screen.getByText("starts in 2 h 15 min")).toBeInTheDocument();
});

it("a missed window is visible on the card in the backlog", () => {
  const tasks = [{ ...base, status: "backlog" as const, depends_on: [],
    start_after: new Date(Date.now() - 3 * 3_600_000).toISOString(), start_before: new Date(Date.now() - 3_600_000).toISOString() }];
  render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  expect(screen.getByText("start window missed")).toBeInTheDocument();
});

// The dispatcher does not pick up tasks from the backlog: promising them "starts in ..." is wrong, only "not before" is.
it("a backlog task with a future start shows \"not before\", not a countdown", () => {
  const at = new Date(Date.now() + 2 * 3_600_000 + 30_000).toISOString();
  const tasks = [{ ...base, status: "backlog" as const, depends_on: [], start_after: at }];
  render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
  expect(screen.getByText(/^not before /)).toBeInTheDocument();
  expect(screen.queryByText(/starts in/)).not.toBeInTheDocument();
});

// Viewing results (viewing.ts): "Done" reads like an inbox: unviewed items
// sit on a shelf at the top until the owner opens the card or ticks the checkbox.
describe("viewing results", () => {
  const done = (id: number, title: string, extra: Partial<Task> = {}): Task => ({
    ...base, id, title, status: "done", priority: "normal", depends_on: [], done_at: "2026-03-01T10:00:00+00:00", ...extra,
  });
  const tasks = [
    done(1, "Old seen", { done_at: "2026-01-10T10:00:00+00:00", viewed_at: "2026-01-11T00:00:00+00:00" }),
    done(2, "Fresh unseen", { done_at: "2026-03-20T10:00:00+00:00" }),
    done(3, "Seen", { done_at: "2026-03-25T10:00:00+00:00", viewed_at: "2026-03-26T00:00:00+00:00" }),
    done(4, "Long-ago unseen", { done_at: "2026-02-01T10:00:00+00:00" }),
    done(5, "Crashed", { status: "failed", done_at: null, updated_at: "2026-03-27T10:00:00+00:00" }),
  ];
  const renderDone = (props: Partial<React.ComponentProps<typeof Board>> = {}) =>
    render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} {...props} />);
  const viewing = () => ({ onToggle: vi.fn(), onMarkAll: vi.fn() });
  const titlesIn = (column: HTMLElement) =>
    within(column).getAllByText(/seen|Crashed/i).map((el) => el.textContent);

  it("where viewing is not tracked, \"Done\" looks as before", () => {
    renderDone();
    const column = columnOf("Done");
    expect(within(column).queryByText("Not viewed")).not.toBeInTheDocument();
    expect(within(column).queryByRole("checkbox")).not.toBeInTheDocument();
    // The order is simply by recency, without a shelf
    expect(titlesIn(column)).toEqual(["Crashed", "Seen", "Fresh unseen", "Long-ago unseen", "Old seen"]);
  });

  it("unviewed ones sit on a shelf at the top, the rest below in the previous order", () => {
    renderDone({ viewing: viewing() });
    const column = columnOf("Done");
    expect(within(column).getByText("Not viewed").parentElement).toHaveTextContent("Not viewed2");
    expect(titlesIn(column)).toEqual(["Fresh unseen", "Long-ago unseen", "Crashed", "Seen", "Old seen"]);
    // The shelf is not cut into days: the first day heading sits below it
    const firstDay = column.querySelector("[data-day-heading]")!;
    const lastUnviewed = within(column).getByText("Long-ago unseen");
    expect(lastUnviewed.compareDocumentPosition(firstDay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the checkbox on the card marks it viewed and does not open the card", async () => {
    const control = viewing();
    const onOpen = vi.fn();
    renderDone({ viewing: control, onOpen });
    const card = (title: string) => screen.getByText(title).closest("[role=button]") as HTMLElement;

    const mark = within(card("Fresh unseen")).getByRole("checkbox", { name: "Viewed" });
    expect(mark).not.toBeChecked();
    await userEvent.click(mark);
    expect(control.onToggle).toHaveBeenCalledWith(2, true);

    // The same checkbox returns the task to unviewed, like "mark as unread"
    const viewedMark = within(card("Seen")).getByRole("checkbox", { name: "Viewed" });
    expect(viewedMark).toBeChecked();
    await userEvent.click(viewedMark);
    expect(control.onToggle).toHaveBeenLastCalledWith(3, false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  // A failure calls the person on its own: it is in "Waiting for me"; the viewed checkbox is not needed for it.
  it("a failed task has no checkbox", () => {
    renderDone({ viewing: viewing() });
    const failed = screen.getByText("Crashed").closest("[role=button]") as HTMLElement;
    expect(within(failed).queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("\"mark all\" calls the shared handler, and without unviewed ones there is no shelf", async () => {
    const control = viewing();
    const { unmount } = renderDone({ viewing: control });
    await userEvent.click(screen.getByRole("button", { name: "Mark all" }));
    expect(control.onMarkAll).toHaveBeenCalledOnce();
    unmount();

    render(<Board projectId={1} tasks={[tasks[0], tasks[2]]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} viewing={viewing()} />);
    expect(screen.queryByText("Not viewed")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark all" })).not.toBeInTheDocument();
  });

  it("in the archive view viewing is not marked", () => {
    const archived = done(9, "Removed unseen", { archived_at: "2026-09-21T10:00:00+00:00" });
    render(<Board projectId={1} tasks={[archived]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} showArchived viewing={viewing()} />);
    expect(screen.getByText("Removed unseen")).toBeInTheDocument();
    expect(screen.queryByText("Not viewed")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("labels and the due date on a card", () => {
  const labels = [{ id: 1, name: "bug", color: "#ff0000" }, { id: 2, name: "ui", color: "#00ff00" }];

  it("shows the labels and a due date on the card", () => {
    const tasks = [{ ...base, depends_on: [], labels, due_date: "2099-01-05" }];
    render(<Board projectId={1} tasks={tasks} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByText("ui")).toBeInTheDocument();
    expect(screen.getByTitle("Due date")).toBeInTheDocument();
  });

  it("marks an overdue date on an open card, and not on a finished one", () => {
    const open = { ...base, id: 1, depends_on: [], due_date: "2000-01-05" };
    const done = { ...base, id: 2, title: "Closed", status: "done" as const, depends_on: [], due_date: "2000-01-05", done_at: "2000-01-04T00:00:00Z" };
    render(<Board projectId={1} tasks={[open, done]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getAllByTitle("Overdue")).toHaveLength(1);
  });

  it("narrows the board to one label", () => {
    const tasks = [
      { ...base, id: 1, title: "Has bug", depends_on: [], labels: [labels[0]] },
      { ...base, id: 2, title: "Has ui", depends_on: [], labels: [labels[1]] },
      { ...base, id: 3, title: "No labels", depends_on: [] },
    ];
    const { rerender } = render(<Board projectId={1} tasks={tasks} labelId={1} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByText("Has bug")).toBeInTheDocument();
    expect(screen.queryByText("Has ui")).not.toBeInTheDocument();
    expect(screen.queryByText("No labels")).not.toBeInTheDocument();
    rerender(<Board projectId={1} tasks={tasks} labelId={null} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByText("No labels")).toBeInTheDocument();
  });
});

it("a parent card shows done/total of its subtasks, counted from all cards rather than the board's list", async () => {
  const { SubtaskProgressContext } = await import("../subtaskProgress");
  const parent = { ...base, id: 5, title: "Epic", depends_on: [] };
  render(
    <SubtaskProgressContext.Provider value={new Map([[5, { done: 1, total: 3 }]])}>
      <Board projectId={1} tasks={[parent]} onMove={vi.fn()} onReorder={vi.fn()} onNotReady={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />
    </SubtaskProgressContext.Provider>,
  );
  expect(screen.getByTitle("1 of 3 subtasks done")).toHaveTextContent("1/3");
});
