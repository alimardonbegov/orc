import { render, screen, within } from "@testing-library/react";
import { it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { ForecastPanel } from "./ForecastPanel";
import { formatPct } from "../usage";
import type { Forecast, ForecastProject, ForecastWindow } from "../types";

const NOW = Math.floor(Date.now() / 1000);

function project(over: Partial<ForecastProject>): ForecastProject {
  return {
    project_id: 1,
    project: "orc",
    tasks: 2,
    tokens: 400_000,
    cost_usd: 3,
    share: 0.75,
    limit_pct_max: 45,
    pace_tokens_per_hour: 200_000,
    pace_cost_per_hour: 1.5,
    projected_tokens: 700_000,
    projected_cost_usd: 6,
    ...over,
  };
}

function win(over: Partial<ForecastWindow> = {}): ForecastWindow {
  return {
    used_pct: 60,
    resets_at: NOW + 2 * 3600,
    window_start: NOW - 3 * 3600,
    measured_at: NOW,
    pace_pct_per_hour: 30,
    pace_basis: "recent",
    avg_pct_per_hour: 20,
    projected_pct: 120,
    hits_limit_at: NOW + 80 * 60,
    safe_pace_pct_per_hour: 20,
    slowdown_to_pct: 67,
    verdict: "over",
    spend_since: "2026-09-25T07:00:00+00:00",
    spend: {
      measure: "cost",
      tokens: 500_000,
      cost_usd: 4,
      pace_tokens_per_hour: 250_000,
      pace_cost_per_hour: 2,
      leader_project_id: 1,
      projects: [project({}), project({ project_id: 2, project: "site", tokens: 100_000, cost_usd: 1, share: 0.25, limit_pct_max: 15, pace_cost_per_hour: 0.5 })],
    },
    ...over,
  };
}

function forecast(over: Partial<Forecast> = {}): Forecast {
  return {
    generated_at: "2026-09-25T10:00:00+00:00",
    available: true,
    stale: false,
    updated_at: NOW,
    ledger_since: "2026-01-01T00:00:00+00:00",
    five_hour: win(),
    seven_day: win({ used_pct: 20, verdict: "ok", projected_pct: 40, hits_limit_at: null, slowdown_to_pct: null, pace_pct_per_hour: 0.5 }),
    ...over,
  };
}

it("warns that at the current pace the limit runs out before the reset, and advises whom to slow down", () => {
  render(<ForecastPanel data={forecast()} error={null} projectId={null} />);
  const five = screen.getByTestId("forecast-five_hour");
  expect(within(five).getByText("60%")).toBeInTheDocument();
  expect(within(five).getByText(/Limit at/)).toBeInTheDocument();
  expect(within(five).getByText("· 40 min before the reset")).toBeInTheDocument();
  expect(within(five).getByText("To make it to the reset, slow down to 67% of the current pace (≤ 20%/h).")).toBeInTheDocument();
  expect(within(five).getByText(/Spending fastest right now: “orc” \(\$1\.50\/h\)/)).toBeInTheDocument();
  // A calm window: no advice
  const week = screen.getByTestId("forecast-seven_day");
  expect(within(week).getByText("Enough until reset")).toBeInTheDocument();
  expect(within(week).queryByText(/slow down/)).toBeNull();
});

it("the per-project table: share, estimate on top of the limit share, and a mark for the fastest", () => {
  render(<ForecastPanel data={forecast()} error={null} projectId={2} />);
  const table = screen.getByRole("table");
  const rows = within(table).getAllByRole("row");
  expect(within(rows[1]).getByText("orc")).toBeInTheDocument();
  expect(within(rows[1]).getByText("fastest")).toBeInTheDocument();
  expect(within(rows[1]).getByText("75%")).toBeInTheDocument();
  expect(within(rows[1]).getByText("≤ 45%")).toBeInTheDocument();
  // The project selected in the sidebar is highlighted
  expect(within(rows[2]).getByText("current")).toBeInTheDocument();
});

it("the window switcher changes the table", async () => {
  const data = forecast({ seven_day: win({ verdict: "ok", spend: { ...win().spend, projects: [project({ project: "weekly-only" })] } }) });
  render(<ForecastPanel data={data} error={null} projectId={null} />);
  expect(screen.queryByText("weekly-only")).toBeNull();
  await userEvent.click(screen.getByRole("radio", { name: "Week" }));
  expect(screen.getByText("weekly-only")).toBeInTheDocument();
});

it("without a five-hour window the plan shows only the week and no switcher", () => {
  const data = forecast({ absent: ["five_hour"], seven_day: win({ verdict: "ok", spend: { ...win().spend, projects: [project({ project: "weekly-only" })] } }) });
  render(<ForecastPanel data={data} error={null} projectId={null} />);
  expect(screen.queryByText("5 hours")).not.toBeInTheDocument();
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  expect(screen.getByText("weekly-only")).toBeInTheDocument();
});

it("without limits it honestly says there are none yet, but shows per-project usage", () => {
  render(<ForecastPanel data={forecast({ available: false })} error={null} projectId={null} />);
  expect(screen.getByText(/Limits are unknown yet/)).toBeInTheDocument();
  expect(screen.queryByTestId("forecast-five_hour")).toBeNull();
  expect(screen.getByText("orc")).toBeInTheDocument();
});

it("an empty window with no usage", () => {
  const empty = win({ spend: { ...win().spend, projects: [], leader_project_id: null } });
  render(<ForecastPanel data={forecast({ five_hour: empty })} error={null} projectId={null} />);
  expect(screen.getByText("No orchestrator task spent tokens in this window.")).toBeInTheDocument();
});

it("a request error is visible instead of an endless loading", () => {
  render(<ForecastPanel data={null} error="500" projectId={null} />);
  expect(screen.getByText("Forecast failed: 500")).toBeInTheDocument();
});

it("formatPct: a fraction only for small numbers", () => {
  expect(formatPct(62)).toBe("62%");
  expect(formatPct(62.4)).toBe("62%");
  expect(formatPct(7.5)).toBe("7,5%");
  expect(formatPct(0.5)).toBe("0,5%");
});
