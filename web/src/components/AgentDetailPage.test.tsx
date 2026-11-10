import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentsContext } from "../agents";
import { api } from "../api";
import type { Agent, AgentRun, AgentWork, AgentWorkRun, AgentsActivity, Project } from "../types";
import { AgentDetailPage } from "./AgentDetailPage";
import { AgentsPage } from "./AgentsPage";

vi.mock("../api", () => ({
  api: {
    agentWork: vi.fn(),
    agentsActivity: vi.fn(),
  },
  ApiError: class extends Error {},
}));

// The log itself has its own tests; here only which run it is asked for matters.
vi.mock("./ActivityPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ActivityPanel")>()),
  ActivityPane: ({ source }: { source: { kind: string; id: number } }) => <div data-testid="log">{`${source.kind}:${source.id}`}</div>,
}));

const agent: Agent = {
  id: 1, name: "Ann", description: "reviews", avatar: null, model: "claude-haiku-4-5", effort: "low", permission_mode: "dontAsk",
  prompt: "", project_id: null, memory_enabled: false, created_at: "", updated_at: "", tasks: { active: 1, total: 3 },
};
const project = { id: 1, name: "Demo", archived_at: null, path_ok: true } as Project;

const run = (over: Partial<AgentWorkRun>): AgentWorkRun => ({
  kind: "task", id: 1, title: "Task", project_id: 1, status: "done", live: false, started_at: "2026-11-05T10:00:00+00:00",
  finished_at: "2026-11-05T11:30:00+00:00", updated_at: "2026-11-05T11:30:00+00:00", tokens: 0, cost_usd: null, archived: false, routine_id: null, ...over,
});

const work = (over: Partial<AgentWork> = {}): AgentWork => ({
  summary: {
    tasks_total: 3, tasks_by_status: { done: 1, failed: 1, in_progress: 1 }, tasks_done: 1, tasks_failed: 1, chats_total: 1,
    tokens: 12_000, cost_usd: 1.25, models: { "claude-opus-5": 12_000, "claude-haiku-4-5": 500 }, busy_ms: 5_400_000,
    avg_run_ms: 2_700_000, first_run_at: "2026-11-01T00:00:00+00:00",
  },
  daily: Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(24 + i).padStart(2, "0")}`.replace("2026-10-3", "2026-11-0"), tokens: i === 13 ? 900 : 0, cost_usd: 0 })),
  runs: [
    run({ id: 7, title: "Fix login", live: true, status: "in_progress", finished_at: null, tokens: 800 }),
    run({ id: 5, title: "Old job", tokens: 11_000, cost_usd: 1.1 }),
    run({ kind: "chat", id: 2, title: "Talk", status: "idle", finished_at: null, tokens: 700, cost_usd: 0.15 }),
  ],
  total_runs: 3,
  ...over,
});

const live = (over: Partial<AgentRun> = {}): AgentRun => ({
  kind: "task", id: 7, title: "Fix login", agent_id: 1, project_id: 1, status: "in_progress", started_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  updated_at: "", now: null, ...over,
});

function setup(activity: AgentsActivity | null, data: AgentWork = work()) {
  vi.mocked(api.agentWork).mockResolvedValue(data);
  const handlers = { onBack: vi.fn(), onEdit: vi.fn(), onChat: vi.fn(), onOpenTask: vi.fn(), onActivityChanged: vi.fn() };
  render(<AgentDetailPage agent={agent} projects={[project]} activity={activity} {...handlers} />);
  return handlers;
}

beforeEach(() => vi.clearAllMocks());

it("shows that the agent is working, since when, and its log", async () => {
  setup({ runs: [live()], recent: [] });
  expect(screen.getByTestId("agent-live-status")).toHaveTextContent("Working on 1");
  expect(screen.getByTestId("tile-now")).toHaveTextContent("1 in work");
  expect(screen.getByTestId("tile-now")).toHaveTextContent("the longest for 12 min");
  expect(screen.getByTestId("log")).toHaveTextContent("task:7");
  // The total counters arrive from the server
  await waitFor(() => expect(screen.getByTestId("tile-tokens")).toHaveTextContent("12k"));
  expect(screen.getByTestId("tile-tokens")).toHaveTextContent("about $1.25");
  expect(screen.getByTestId("tile-tasks")).toHaveTextContent("done 1 · failed 1 · chats: 1");
  expect(screen.getByTestId("tile-time")).toHaveTextContent("1 h 30 min");
});

it("an idle agent says so and offers its last finished run", async () => {
  setup({ runs: [], recent: [] });
  expect(screen.getByTestId("agent-live-status")).toHaveTextContent("Idle");
  expect(screen.getByTestId("tile-now")).toHaveTextContent("Nothing in work");
  // The newest finished run is open until another is picked
  expect(await screen.findByTestId("log")).toHaveTextContent("task:5");
  await userEvent.click(screen.getByRole("button", { name: /Talk/ }));
  expect(screen.getByTestId("log")).toHaveTextContent("chat:2");
});

it("the history lists tasks and chats with tokens and opens a run's log", async () => {
  setup({ runs: [], recent: [] });
  await userEvent.click(screen.getByRole("radio", { name: "History" }));
  const table = await screen.findByRole("table");
  const rows = within(table).getAllByRole("row");
  expect(rows).toHaveLength(4);
  expect(within(rows[2]).getByText("#5 Old job")).toBeInTheDocument();
  expect(within(rows[2]).getByText("11k")).toBeInTheDocument();
  expect(within(rows[2]).getByText("$1.10")).toBeInTheDocument();
  expect(within(rows[2]).getByText("1 h 30 min")).toBeInTheDocument();
  expect(within(rows[3]).getByText("chat")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Open the log of Talk" }));
  expect(screen.getByTestId("log")).toHaveTextContent("chat:2");
});

it("older history is loaded on request", async () => {
  setup({ runs: [], recent: [] }, work({ total_runs: 120, runs: Array.from({ length: 50 }, (_, i) => run({ id: i + 1 })) }));
  await userEvent.click(screen.getByRole("radio", { name: "History" }));
  await userEvent.click(await screen.findByRole("button", { name: "Show more (70 left)" }));
  await waitFor(() => expect(api.agentWork).toHaveBeenLastCalledWith(1, 100));
});

it("no \"show more\" when the server returned fewer rows than asked: its page cap was reached", async () => {
  setup({ runs: [], recent: [] }, work({ total_runs: 600 }));
  await userEvent.click(screen.getByRole("radio", { name: "History" }));
  await screen.findByRole("table");
  expect(screen.queryByRole("button", { name: /Show more/ })).not.toBeInTheDocument();
});

it("the tokens tab breaks the spending down by model", async () => {
  setup({ runs: [], recent: [] });
  await userEvent.click(screen.getByRole("radio", { name: "Tokens" }));
  expect(await screen.findByText("Opus 5")).toBeInTheDocument();
  expect(screen.getByText("Haiku 4.5")).toBeInTheDocument();
});

it("an agent that has not run yet shows empty states, not zeros everywhere", async () => {
  setup({ runs: [], recent: [] }, work({ runs: [], total_runs: 0, summary: { ...work().summary, tokens: 0, cost_usd: null, tasks_total: 0, busy_ms: 0, avg_run_ms: null, models: {} } }));
  await userEvent.click(screen.getByRole("radio", { name: "History" }));
  expect(await screen.findByText("This agent has not run anything yet.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "Tokens" }));
  expect(screen.getByText("No tokens counted for this agent yet.")).toBeInTheDocument();
});

it("a card on the agents page opens the agent's own page and goes back", async () => {
  vi.mocked(api.agentWork).mockResolvedValue(work());
  vi.mocked(api.agentsActivity).mockResolvedValue({ runs: [live()], recent: [] });
  render(
    <AgentsContext.Provider value={[agent]}>
      <AgentsPage projects={[project]} onChanged={vi.fn()} onChat={vi.fn()} />
    </AgentsContext.Provider>,
  );
  // The card itself shows that the agent is at work
  expect(await screen.findByTestId("agent-card-live")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Open the page of Ann" }));
  expect(await screen.findByTestId("agent-live-status")).toHaveTextContent("Working on 1");
  await userEvent.click(screen.getByRole("button", { name: "All agents" }));
  expect(screen.queryByTestId("agent-live-status")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open the page of Ann" })).toBeInTheDocument();
});
