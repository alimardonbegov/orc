/// <reference types="node" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { Project, Task } from "./types";

/** Response for GET /api/projects: an empty list, the board is not needed for this test. */
const projectsOk = () => Promise.resolve({ ok: true, status: 200, json: async () => [] });
/** Response for GET /api/dispatcher: the dispatcher is running, no quota. */
const dispatcherOk = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      paused: false, quota_retry_after: null, running: 1, last_tick: null,
      last_tick_duration_sec: null, last_tick_steps: {}, tick_error_count: 0, verifying_now: [],
      sessions_alive: null, reaped_total: 0, load_avg: null, free_mem_pct: null, start_blocked_reason: null,
    }),
  });

const project = (id: number, name: string): Project => ({
  id, name, path: `/repo/${id}`, default_model: null, default_effort: null, default_permission_mode: "auto", default_branch: null,
  verify_cmd: null, verify_timeout_sec: 900, max_workers: 2, push_enabled: 0, archived_at: null,
  path_ok: true, path_error: null, created_at: "", position: null,
});

const task = (id: number, projectId: number, title: string): Task => ({
  id, project_id: projectId, title, description: "", status: "todo", priority: "normal", blocker: null,
  blocker_detail: null, target_branch: "main", model: null, effort: null, permission_mode: null, verify_cmd: null,
  requires_review: 0, worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0,
  state_miss_count: 0, quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null,
  merge_queued_at: null, retry_after: null,
  report_json: null, created_at: "", updated_at: "", done_at: null, archived_at: null, position: null, usage_json: null, depends_on: [],
});

/** Backend mock with two projects and one task in the second of them. */
function mockBackend(tasks: Task[] = [], projectsOver: Partial<Project>[] = []) {
  const projects = [
    { ...project(1, "First project"), ...projectsOver[0] },
    { ...project(2, "Second project"), ...projectsOver[1] },
  ];
  (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("/api/projects")) return ok(projects);
    if (url.startsWith("/api/tasks/")) return ok({ ...tasks[0], comments: [] });
    if (url.startsWith("/api/tasks")) return ok(tasks);
    if (url === "/api/dispatcher") return dispatcherOk();
    if (url.startsWith("/api/git/branches")) return ok({ current: "main", branches: ["main"] });
    return ok([]);
  });
  return projects;
}

const KEY = "orc.ui.v1";

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("a rejected POST /api/dispatcher/tick (409) does not crash the promise and is visible to the user", async () => {
    const onUnhandledRejection = vi.fn();
    process.on("unhandledRejection", onUnhandledRejection);

    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === "/api/projects") return projectsOk();
      if (url === "/api/dispatcher") return dispatcherOk();
      if (url === "/api/dispatcher/tick") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ detail: "the dispatcher is already running a pass, try again later" }),
        });
      }
      // Other GET routes (e.g. /api/events) always return an array in the real backend
      // (see orc/api.py:326-328), so the mock answers with the same shape, not an arbitrary {}.
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });

    const user = userEvent.setup();
    render(<App />);

    const tickButton = await screen.findByRole("button", { name: "Run now" });
    await user.click(tickButton);

    expect(await screen.findByText("the dispatcher is already running a pass, try again later")).toBeInTheDocument();

    // give an unhandled rejection a chance to surface if .catch() were missing
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onUnhandledRejection).not.toHaveBeenCalled();

    process.off("unhandledRejection", onUnhandledRejection);
  });

  it("archived tasks are hidden from the board, and the Archive button shows them instead of the live ones", async () => {
    localStorage.setItem(KEY, JSON.stringify({ projectId: 1 }));
    const archived = { ...task(5, 1, "Removed"), archived_at: "2026-09-21T10:00:00+00:00" };
    mockBackend([task(4, 1, "Live"), archived]);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("Live")).toBeInTheDocument();
    expect(screen.queryByText("Removed")).not.toBeInTheDocument();
    // The archive arrives with the same poll: there is no separate request for it.
    const taskUrls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((u: string) => u.startsWith("/api/tasks"));
    expect(taskUrls.every((u: string) => u === "/api/tasks?archived=all")).toBe(true);

    await user.click(screen.getByRole("button", { name: /Archive/ }));
    expect(await screen.findByText("Removed")).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    // The view is remembered: after a restart the person does not lose where they were.
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!).showArchived).toBe(true));
  });

  it("help opens from the sidebar instead of the board, and clicking a project returns to the board", async () => {
    localStorage.setItem(KEY, JSON.stringify({ projectId: 1 }));
    mockBackend([task(4, 1, "Live")]);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText("Live")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "How it works" }));
    expect(screen.getByRole("heading", { name: "How it works", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Projects" });
    await user.click(within(nav).getByRole("button", { name: /Second project/ }));
    expect(await screen.findByRole("heading", { name: "Second project" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "How it works", level: 1 })).not.toBeInTheDocument();
  });

  it("the ? key opens and closes help", async () => {
    localStorage.setItem(KEY, JSON.stringify({ projectId: 1 }));
    mockBackend([task(4, 1, "Live")]);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText("Live")).toBeInTheDocument();
    await user.keyboard("?");
    expect(screen.getByRole("heading", { name: "How it works", level: 1 })).toBeInTheDocument();
    await user.keyboard("?");
    expect(await screen.findByText("Live")).toBeInTheDocument();
  });

  // Regression: after a browser restart the first project in the list
  // was opened, whatever the person had selected before.
  describe("state is restored after a browser restart", () => {
    it("the saved project is opened, not the first one in the list", async () => {
      localStorage.setItem(KEY, JSON.stringify({ projectId: 2 }));
      mockBackend();
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Second project" })).toBeInTheDocument();
    });

    it("without a saved choice the first project is taken", async () => {
      mockBackend();
      render(<App />);
      expect(await screen.findByRole("heading", { name: "First project" })).toBeInTheDocument();
    });

    it("the project choice is remembered immediately, before a restart", async () => {
      mockBackend();
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: "Second project" }));
      await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!).projectId).toBe(2));
    });

    it("a saved project that no longer exists is replaced with the first one in the list", async () => {
      localStorage.setItem(KEY, JSON.stringify({ projectId: 404 }));
      mockBackend();
      render(<App />);
      expect(await screen.findByRole("heading", { name: "First project" })).toBeInTheDocument();
      await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!).projectId).toBe(1));
    });

    it("an open task card is reopened", async () => {
      localStorage.setItem(KEY, JSON.stringify({ projectId: 2, openTaskId: 12 }));
      mockBackend([task(12, 2, "Saved task")]);
      render(<App />);
      const dialog = await screen.findByRole("dialog");
      // The title is also on the board card, so look specifically in the dialog.
      await waitFor(() => expect(within(dialog).getByText("Saved task")).toBeInTheDocument());
    });

    it("a collapsed sidebar stays collapsed", async () => {
      localStorage.setItem(KEY, JSON.stringify({ projectId: 1, sidebarCollapsed: true }));
      mockBackend();
      render(<App />);
      expect(await screen.findByRole("button", { name: "Expand panel · [" })).toBeInTheDocument();
    });
  });

  describe("a project that cannot be worked with", () => {
    it("a missing folder is shown as a banner, and a new task cannot be created", async () => {
      localStorage.setItem(KEY, JSON.stringify({ projectId: 1 }));
      mockBackend([], [{ path_ok: false, path_error: "folder missing" }]);
      render(<App />);
      expect(await screen.findByText(/Project folder unavailable \(folder missing\)/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Change path" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Task" })).toBeDisabled();
    });

    it("an archived project is shown as a banner with a restore option, not silently as an empty board", async () => {
      localStorage.setItem(KEY, JSON.stringify({ projectId: 1 }));
      mockBackend([], [{ archived_at: "2026-01-01T00:00:00" }]);
      render(<App />);
      expect(await screen.findByText(/Project is archived/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Restore from archive" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Task" })).toBeDisabled();
    });

    it("the default project is picked from the non-archived ones", async () => {
      mockBackend([], [{ archived_at: "2026-01-01T00:00:00" }]);
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Second project" })).toBeInTheDocument();
    });
  });

  describe("summary", () => {
    /** Empty summary: the response shape matters more than the numbers; we check the view switch, not the counts. */
    const emptyAnalytics = {
      generated_at: "2026-09-20T12:00:00+00:00",
      period: { days: 30, from: "2026-08-21T12:00:00+00:00", to: "2026-09-20T12:00:00+00:00", bucket: "day" },
      scope: { project_id: 1, project: "First project" },
      totals: {
        created: 0, finished: 0, done: 0, failed: 0, success_rate: null, tokens: 0, cost_usd: 0,
        cost_known_tasks: 0, cost_exact_tasks: 0, lead_p50_sec: null, lead_p90_sec: null,
        work_p50_sec: null, work_p90_sec: null, retries: { resume: 0, quota: 0, conflict: 0 },
        interventions: 0, interventions_by_kind: {}, answer_wait_p50_sec: null,
      },
      now: {
        by_status: { backlog: 0, todo: 0, in_progress: 0, verifying: 0, merging: 0, done: 0, failed: 0 },
        total: 0, archived: 0, in_flight: 0, waiting: 0, blocked: 0, queued: 0,
      },
      previous: null,
      flow: [{ date: "2026-09-20", created: 0, done: 0, failed: 0, tokens: 0, cost_usd: 0, by_status: {}, by_model: {}, by_project: {} }],
      durations: { measured: 0, finished: 0, bins: [] },
      models: [], efforts: [], permissions: [], projects: [], top_cost: [],
    };

    it("the Summary button replaces the board with the dashboard and remembers the choice", async () => {
      localStorage.setItem(KEY, JSON.stringify({ projectId: 1 }));
      mockBackend([task(1, 1, "First task")]);
      const base = (fetch as unknown as ReturnType<typeof vi.fn>).getMockImplementation() as (url: string) => Promise<unknown>;
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
        url.startsWith("/api/analytics")
          ? Promise.resolve({ ok: true, status: 200, json: async () => emptyAnalytics })
          : base(url),
      );

      render(<App />);
      expect(await screen.findByText("First task")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("radio", { name: "Summary" }));
      expect(await screen.findByText("Finished")).toBeInTheDocument();
      // board filters are not needed in the summary and go away with it
      expect(screen.queryByRole("searchbox", { name: "Search tasks" })).not.toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem(KEY)!).view).toBe("dashboard");
    });

    it("the summary is not requested on the board: every response is a full pass over the tasks", async () => {
      localStorage.setItem(KEY, JSON.stringify({ projectId: 1 }));
      mockBackend([task(1, 1, "First task")]);
      render(<App />);
      expect(await screen.findByText("First task")).toBeInTheDocument();
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(calls.some((url) => url.startsWith("/api/analytics"))).toBe(false);
      expect(calls.some((url) => url.startsWith("/api/forecast"))).toBe(false);
    });
  });
});
