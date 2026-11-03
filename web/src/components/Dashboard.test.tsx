import { render, screen, within } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Dashboard } from "./Dashboard";
import type { Analytics, AnalyticsFlowCell, AnalyticsFlowRow, Project } from "../types";

const project: Project = {
  id: 1,
  name: "orc",
  path: "/repo",
  default_model: null,
  default_effort: null,
  default_permission_mode: "auto",
  default_branch: null,
  verify_cmd: null,
  verify_timeout_sec: 900,
  max_workers: 2,
  push_enabled: 0,
  archived_at: null,
  path_ok: true,
  path_error: null,
  created_at: "2026-01-01T00:00:00+00:00",
  position: null,
};

function analytics(over: Partial<Analytics> = {}): Analytics {
  return {
    generated_at: "2026-09-20T12:00:00+00:00",
    period: { days: 30, from: "2026-08-21T12:00:00+00:00", to: "2026-09-20T12:00:00+00:00", bucket: "day" },
    scope: { project_id: 1, project: "orc" },
    totals: {
      created: 12,
      finished: 10,
      done: 8,
      failed: 2,
      success_rate: 0.8,
      tokens: 1_250_000,
      cost_usd: 4.25,
      cost_known_tasks: 10,
      cost_exact_tasks: 7,
      lead_p50_sec: 7200,
      lead_p90_sec: 86400,
      work_p50_sec: 1800,
      work_p90_sec: 5400,
      retries: { resume: 3, quota: 1, conflict: 2 },
      interventions: 4,
      interventions_by_kind: { question: 3, permission: 1 },
      answer_wait_p50_sec: 600,
    },
    now: {
      by_status: { backlog: 5, todo: 2, in_progress: 1, verifying: 0, merging: 0, done: 8, failed: 2 },
      total: 18,
      archived: 3,
      in_flight: 1,
      waiting: 1,
      blocked: 1,
      queued: 2,
    },
    previous: {
      created: 9,
      finished: 8,
      done: 5,
      failed: 3,
      success_rate: 0.625,
      tokens: 900_000,
      cost_usd: 5.0,
      work_p50_sec: 2400,
      interventions: 6,
    },
    flow: [
      flowRow("2026-09-18", { created: 2, done: 1, failed: 1, tokens: 400_000, cost_usd: 1.5 }, {
        by_status: { done: cell(1, 300_000, 1.2), failed: cell(1, 100_000, 0.3) },
        by_model: { "claude-opus-5": cell(1, 300_000, 1.2), "claude-sonnet-5": cell(1, 100_000, 0.3) },
        by_project: { orc: cell(2, 400_000, 1.5) },
      }),
      flowRow("2026-09-19", { created: 0, done: 3, failed: 0, tokens: 850_000, cost_usd: 2.75 }, {
        by_status: { done: cell(3, 850_000, 2.75) },
        by_model: { "claude-opus-5": cell(3, 850_000, 2.75) },
        by_project: { orc: cell(3, 850_000, 2.75) },
      }),
      flowRow("2026-09-20", { created: 1, done: 0, failed: 0, tokens: 0, cost_usd: 0 }),
    ],
    durations: {
      measured: 8,
      finished: 10,
      bins: [
        { label: "< 5 min", from_sec: 0, to_sec: 300, count: 2 },
        { label: "5–15 min", from_sec: 300, to_sec: 900, count: 5 },
        { label: "> 4 h", from_sec: 14400, to_sec: null, count: 1 },
      ],
    },
    models: [
      { key: "claude-opus-5", tasks: 7, done: 6, failed: 1, tokens: 1_000_000, cost_usd: 3.5, median_sec: 1800 },
      { key: "claude-sonnet-5", tasks: 3, done: 2, failed: 1, tokens: 250_000, cost_usd: 0.75, median_sec: 900 },
    ],
    efforts: [{ key: "—", tasks: 10, done: 8, failed: 2, tokens: 1_250_000, cost_usd: 4.25, median_sec: 1800 }],
    permissions: [{ key: "bypassPermissions", tasks: 10, done: 8, failed: 2, tokens: 1_250_000, cost_usd: 4.25, median_sec: 1800 }],
    projects: [{ key: "orc", tasks: 10, done: 8, failed: 2, tokens: 1_250_000, cost_usd: 4.25, median_sec: 1800 }],
    top_cost: [
      {
        id: 42,
        title: "Dashboard",
        status: "done",
        project: "orc",
        model: "claude-opus-5",
        tokens: 900_000,
        cost_usd: 3.1,
        work_sec: 5400,
        finished_at: "2026-09-19T10:00:00+00:00",
      },
    ],
    ...over,
  };
}

const cell = (tasks: number, tokens: number, cost_usd: number): AnalyticsFlowCell => ({ tasks, tokens, cost_usd });

function flowRow(
  date: string,
  totals: { created: number; done: number; failed: number; tokens: number; cost_usd: number },
  splits: Partial<Pick<AnalyticsFlowRow, "by_status" | "by_model" | "by_project">> = {},
): AnalyticsFlowRow {
  return { date, ...totals, by_status: {}, by_model: {}, by_project: {}, ...splits };
}

const allScope = () => analytics({ scope: { project_id: null, project: null } });

function view(props: Partial<React.ComponentProps<typeof Dashboard>> = {}) {
  const merged = {
    data: analytics(),
    error: null,
    project,
    allProjects: false,
    onAllProjects: vi.fn(),
    days: 30,
    onDays: vi.fn(),
    metric: "cost_usd" as const,
    onMetric: vi.fn(),
    split: "by_model" as const,
    onSplit: vi.fn(),
    breakdown: "models" as const,
    onBreakdown: vi.fn(),
    onRefresh: vi.fn(),
    onOpenTask: vi.fn(),
    ...props,
  };
  const utils = render(<Dashboard {...merged} />);
  return { ...merged, ...utils };
}

it("shows five tiles with period totals, without \"queued\"", () => {
  view();
  expect(screen.getByText("Finished")).toBeInTheDocument();
  expect(screen.getByText("8 done · 2 failed")).toBeInTheDocument();
  // "80%" also appears in the tables' success column: we take the tile itself (the big number)
  expect(screen.getByText("80%", { selector: ".text-\\[22px\\]" })).toBeInTheDocument();
  expect(screen.getByText("p90 1 h 30 min · lead time 2 h")).toBeInTheDocument();
  expect(screen.getByText("1,3M tokens · 7 of 10 exact")).toBeInTheDocument();
  expect(screen.getByText("Called a human")).toBeInTheDocument();
  expect(screen.getByText("median reply 10 min")).toBeInTheDocument();
  // the number of created cards says nothing about the work, so there is no tile
  expect(screen.queryByText("Created")).not.toBeInTheDocument();
  expect(screen.queryByText(/more than closed/)).not.toBeInTheDocument();
});

it("the \"where tasks are now\" strip and the \"friction\" list are not on screen", () => {
  view();
  expect(screen.queryByRole("figure", { name: /Where tasks are now/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("figure", { name: /Friction/ })).not.toBeInTheDocument();
  expect(screen.queryByText("Auto-resumes")).not.toBeInTheDocument();
});

it("the limit forecast is always visible: there is no toggle any more", () => {
  view();
  expect(screen.getByRole("figure", { name: "Claude limit forecast" })).toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

it("the time chart draws a single measure (money by default) and labels the buckets", () => {
  view();
  const chart = screen.getByRole("figure", { name: "Money per day" });
  // one group of bars, not three panels
  expect(within(chart).getByRole("group", { name: "money" })).toBeInTheDocument();
  expect(within(chart).queryByRole("group", { name: "tokens" })).not.toBeInTheDocument();
  expect(within(chart).getByRole("button", { name: "18 Sep: money $1.50" })).toBeInTheDocument();
  // a day without events is also there: a dip in the flow is a fact, not a compressed axis
  expect(within(chart).getByRole("button", { name: "20 Sep: money $0.00" })).toBeInTheDocument();
  expect(within(chart).getByText("18 Sep")).toBeInTheDocument();
  // the legend is by model, the color is tied to the name
  expect(within(chart).getByText("Opus 5")).toBeInTheDocument();
  expect(within(chart).getByText("Sonnet 5")).toBeInTheDocument();
});

it("the chart measure switches and is reported outward; the heading follows the measure", async () => {
  const props = view();
  const chart = screen.getByRole("figure", { name: "Money per day" });
  await userEvent.click(within(chart).getByRole("radio", { name: "tokens" }));
  expect(props.onMetric).toHaveBeenCalledWith("tokens");

  props.unmount();
  view({ metric: "tasks" });
  const tasks = screen.getByRole("figure", { name: "Finished per day" });
  expect(within(tasks).getByRole("group", { name: "tasks" })).toBeInTheDocument();
  expect(within(tasks).getByRole("button", { name: "18 Sep: tasks 2" })).toBeInTheDocument();
});

it("there is no split by status, and the stack by project is available only in the all-projects scope", async () => {
  const props = view();
  const chart = screen.getByRole("figure", { name: "Money per day" });
  expect(within(chart).queryByRole("radio", { name: "status" })).not.toBeInTheDocument();
  expect(within(chart).queryByRole("radio", { name: "project" })).not.toBeInTheDocument();
  expect(within(chart).queryByRole("radio", { name: "model" })).not.toBeInTheDocument();

  props.unmount();
  const all = view({ allProjects: true, split: "by_project", data: allScope() });
  const wide = screen.getByRole("figure", { name: "Money per day" });
  expect(within(wide).getByRole("radio", { name: "project", checked: true })).toBeInTheDocument();
  // orc also appears in the projects table, so we look inside the chart legend
  expect(within(wide).getByText("orc")).toBeInTheDocument();
  await userEvent.click(within(wide).getByRole("radio", { name: "model" }));
  expect(all.onSplit).toHaveBeenCalledWith("by_model");
});

it("without prices the chart switches to tokens on its own and does not offer an empty measure", () => {
  const rows = analytics().flow.map((r) => ({ ...r, cost_usd: 0, by_model: Object.fromEntries(Object.entries(r.by_model).map(([k, c]) => [k, { ...c, cost_usd: 0 }])) }));
  view({ data: analytics({ flow: rows }) });
  const chart = screen.getByRole("figure", { name: "Tokens per day" });
  expect(within(chart).getByRole("group", { name: "tokens" })).toBeInTheDocument();
  expect(within(chart).queryByRole("radio", { name: "money" })).not.toBeInTheDocument();
});

it("hovering a bar shows a tooltip with the bucket breakdown, a tap pins it", async () => {
  view();
  const bar = screen.getByRole("button", { name: "18 Sep: money $1.50" });
  await userEvent.hover(bar);
  const tip = screen.getByRole("tooltip");
  expect(within(tip).getByText("18 Sep · money $1.50")).toBeInTheDocument();
  expect(within(tip).getByText("Opus 5")).toBeInTheDocument();
  // the other bucket measures and the dip are in the tooltip footer, a status row is not needed for this
  expect(within(tip).getByText("tokens 400k · tasks 2 · failed 1")).toBeInTheDocument();
  await userEvent.unhover(bar);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  // a tap pins it: moving the cursor away does not dismiss the tooltip, a second tap does
  await userEvent.click(bar);
  await userEvent.unhover(bar);
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
  await userEvent.click(bar);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("tiles show a delta against the previous period with an assessment", () => {
  view();
  // finished 10 vs 8 is better; spent $4.25 vs $5.00 is less, also better
  expect(screen.getByText("+2")).toHaveAttribute("title", "vs. the for 30 days before: 8");
  expect(screen.getByText("−$0.75")).toBeInTheDocument();
  // success rate 80% vs 62.5% is plus 18 points
  expect(screen.getByText("+18%")).toBeInTheDocument();
  // a human was called 4 vs 6 times is fewer, better
  expect(screen.getByText("−2")).toBeInTheDocument();
});

it("for all time there are no deltas: nothing to compare with", () => {
  view({ days: 0, data: analytics({ previous: null, period: { days: 0, from: "2026-01-01T00:00:00+00:00", to: "2026-09-20T12:00:00+00:00", bucket: "month" } }) });
  expect(screen.queryByText("+2")).not.toBeInTheDocument();
});

it("the duration distribution honestly states its coverage", () => {
  view();
  const durations = screen.getByRole("figure", { name: /How long a task takes/ });
  // 8 of 10: two finished tasks have no usable session start mark
  expect(within(durations).getByText("8 of 10 tasks")).toBeInTheDocument();
});

it("the breakdown is by model by default: names instead of identifiers, money, success, cost per task", () => {
  view();
  const models = screen.getByRole("figure", { name: "By model" });
  expect(within(models).getByText("Opus 5")).toBeInTheDocument();
  expect(within(models).getByText("Sonnet 5")).toBeInTheDocument();
  expect(within(models).getByText("$3.50")).toBeInTheDocument();
  // Opus: 6 of 7 -> 86%, $3.50 / 7 = $0.50 per task
  expect(within(models).getByText("86%")).toBeInTheDocument();
  expect(within(models).getByText("$0.50")).toBeInTheDocument();
  // the other dimensions do not sit side by side as separate tables
  expect(screen.queryByRole("figure", { name: "By effort level" })).not.toBeInTheDocument();
  expect(screen.queryByRole("figure", { name: "By permission mode" })).not.toBeInTheDocument();
});

it("the breakdown dimension switches in the table header, project only in the all-projects scope", async () => {
  const props = view();
  const models = screen.getByRole("figure", { name: "By model" });
  expect(within(models).queryByRole("radio", { name: "project" })).not.toBeInTheDocument();
  await userEvent.click(within(models).getByRole("radio", { name: "effort" }));
  expect(props.onBreakdown).toHaveBeenCalledWith("efforts");

  props.unmount();
  view({ breakdown: "efforts" });
  const efforts = screen.getByRole("figure", { name: "By effort level" });
  expect(within(efforts).getByText("Claude Code default")).toBeInTheDocument();
});

it("in the all-projects scope the breakdown can go by project, and \"most expensive\" gets a project column", () => {
  view({ allProjects: true, breakdown: "projects", data: allScope() });
  const projects = screen.getByRole("figure", { name: "By project" });
  expect(within(projects).getByRole("radio", { name: "project", checked: true })).toBeInTheDocument();
  expect(within(projects).getByText("orc")).toBeInTheDocument();
  expect(within(screen.getByRole("figure", { name: /Most expensive/ })).getByText("project")).toBeInTheDocument();
});

it("a \"project\" dimension from memory in a single-project scope is replaced with models", () => {
  view({ breakdown: "projects" });
  expect(screen.getByRole("figure", { name: "By model" })).toBeInTheDocument();
});

it("the \"most expensive\" table opens the task card", async () => {
  const props = view();
  await userEvent.click(screen.getByRole("button", { name: /Dashboard/ }));
  expect(props.onOpenTask).toHaveBeenCalledWith(42);
});

it("the period switcher reports the choice outward", async () => {
  const props = view();
  await userEvent.click(screen.getByRole("radio", { name: "90 days" }));
  expect(props.onDays).toHaveBeenCalledWith(90);
});

it("an empty period is explained in words, not by empty axes", () => {
  view({
    data: analytics({
      totals: { ...analytics().totals, finished: 0, done: 0, failed: 0, success_rate: null, work_p50_sec: null },
      flow: [flowRow("2026-09-20", { created: 0, done: 0, failed: 0, tokens: 0, cost_usd: 0 })],
      durations: { measured: 0, finished: 0, bins: [{ label: "< 5 min", from_sec: 0, to_sec: 300, count: 0 }] },
      models: [],
      top_cost: [],
    }),
  });
  expect(screen.getByText("nothing to finish yet")).toBeInTheDocument();
  expect(screen.getAllByText("No data for this period").length).toBeGreaterThan(0);
  expect(screen.getByText("No finished tasks in this period")).toBeInTheDocument();
  expect(screen.getByText(/usable session-start mark/)).toBeInTheDocument();
});

it("while the answer to new filters is being computed, the old one is shown dimmed", () => {
  // The data came for 30 days, but 90 were already asked for: the layout does not jump to a skeleton
  const { container } = view({ days: 90 });
  expect(container.querySelector(".opacity-50")).not.toBeNull();
});

it("with no data and a broken request the reason is visible, not an empty screen", () => {
  view({ data: null, error: "no connection to server" });
  expect(screen.getByText(/Summary failed to load: no connection to server/)).toBeInTheDocument();
});
