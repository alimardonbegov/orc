import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Board } from "./Board";
import { BatchToolbar, BulkResultDialog } from "./BatchToolbar";
import { ViewsMenu } from "./ViewsMenu";
import { sameFilters } from "../hooks/useBoardViews";
import { api } from "../api";
import type { BoardFilters, BoardView, Task } from "../types";

const base: Task = {
  id: 1, project_id: 1, title: "Do X", description: "", status: "backlog", priority: "normal", blocker: null,
  blocker_detail: null, target_branch: "dev", verify_cmd: null,
  requires_review: 0, worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0,
  state_miss_count: 0, quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null,
  merge_queued_at: null, retry_after: null,
  report_json: null, created_at: "", updated_at: "", done_at: null, archived_at: null, position: null, usage_json: null, depends_on: [],
};
const tasks: Task[] = [base, { ...base, id: 2, title: "Second" }, { ...base, id: 3, title: "Third" }];

/** The board with the selection state kept the way App keeps it. */
function Harness({ search = "", onOpen = vi.fn(), seen = vi.fn() }: { search?: string; onOpen?: (id: number) => void; seen?: (ids: number[]) => void }) {
  const [ids, setIds] = useState<ReadonlySet<number>>(new Set());
  return (
    <>
      <Board
        projectId={1}
        tasks={tasks}
        search={search}
        onMove={vi.fn()}
        onReorder={vi.fn()}
        onNotReady={vi.fn()}
        onOpen={onOpen}
        onCreate={vi.fn()}
        selection={{
          ids,
          onToggle: (id) => setIds((p) => { const n = new Set(p); if (!n.delete(id)) n.add(id); return n; }),
          onVisible: (visible) => {
            seen(visible);
            setIds((p) => {
              const next = new Set([...p].filter((id) => visible.includes(id)));
              return next.size === p.size ? p : next;
            });
          },
        }}
      />
      <output data-testid="selected">{[...ids].sort().join(",")}</output>
    </>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("selecting cards on the board", () => {
  it("the box selects a card without opening it", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select card #2" }));
    expect(screen.getByTestId("selected")).toHaveTextContent("2");
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Select card #2" })).toBeChecked();
  });

  it("while something is selected, a click on a card selects it instead of opening it", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select card #1" }));
    await userEvent.click(screen.getByText("Third"));
    expect(screen.getByTestId("selected")).toHaveTextContent("1,3");
    expect(onOpen).not.toHaveBeenCalled();
    // and a click on a selected card takes it out again
    await userEvent.click(screen.getByText("Third"));
    expect(screen.getByTestId("selected")).toHaveTextContent("1");
  });

  it("without a selection a click still opens the card", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    await userEvent.click(screen.getByText("Second"));
    expect(onOpen).toHaveBeenCalledWith(2);
  });

  it("a card that a filter hides leaves the selection", async () => {
    const { rerender } = render(<Harness />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select card #2" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select card #3" }));
    rerender(<Harness search="third" />);
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent("3"));
  });
});

describe("the batch toolbar", () => {
  it("shows the count and offers to bring archived cards back", async () => {
    const onApply = vi.fn();
    render(<BatchToolbar tasks={tasks.slice(0, 2)} projectId={1} archivedView pending={false} onApply={onApply} onClear={vi.fn()} />);
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));
    expect(onApply).toHaveBeenCalledWith({ archived: false });
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("archives with one press and clears the selection", async () => {
    const onApply = vi.fn();
    const onClear = vi.fn();
    render(<BatchToolbar tasks={tasks} projectId={1} archivedView={false} pending={false} onApply={onApply} onClear={onClear} />);
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(onApply).toHaveBeenCalledWith({ archived: true });
    await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("draws nothing when no card is selected", () => {
    const { container } = render(<BatchToolbar tasks={[]} projectId={1} archivedView={false} pending={false} onApply={vi.fn()} onClear={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the result of a bulk change", () => {
  it("names the refused card and the server's reason", () => {
    const result = {
      ok: 9,
      failed: 1,
      results: [
        { id: 1, ok: true, status: "todo" as const },
        { id: 2, ok: false, error: "assign an agent first" },
      ],
    };
    render(<BulkResultDialog result={result} tasks={tasks} onClose={vi.fn()} />);
    expect(screen.getByText("9 changed, 1 refused. The refused cards stay selected.")).toBeInTheDocument();
    expect(screen.getByText("assign an agent first")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.queryByText("Do X")).not.toBeInTheDocument(); // the changed card is not listed
  });
});

describe("saved views", () => {
  const filters: BoardFilters = { search: "api", attention_only: true, label_id: 4, show_done: false, show_archived: false, done_sort: "oldest" };
  const view: BoardView = { id: 7, project_id: 1, name: "API work", filters, created_at: "" };
  const empty: BoardFilters = { search: "", attention_only: false, label_id: null, show_done: true, show_archived: false, done_sort: "recent" };

  it("compares filters by value", () => {
    expect(sameFilters(filters, { ...filters, search: " api " })).toBe(true);
    expect(sameFilters(filters, { ...filters, label_id: null })).toBe(false);
  });

  it("opening a view hands its filters back", async () => {
    const onApply = vi.fn();
    render(<ViewsMenu projectId={1} views={[view]} current={empty} onApply={onApply} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Saved views" }));
    await userEvent.click(screen.getByRole("button", { name: "API work" }));
    expect(onApply).toHaveBeenCalledWith(filters);
  });

  it("names the view that matches the current filters", () => {
    render(<ViewsMenu projectId={1} views={[view]} current={filters} onApply={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Saved views" })).toHaveTextContent("API work");
  });

  it("saves the current filters under a name", async () => {
    const add = vi.spyOn(api, "addView").mockResolvedValue(view);
    const onChanged = vi.fn();
    render(<ViewsMenu projectId={1} views={[]} current={filters} onApply={vi.fn()} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: "Saved views" }));
    await userEvent.type(screen.getByPlaceholderText("View name"), "  API work ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(add).toHaveBeenCalledWith(1, "API work", filters);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
