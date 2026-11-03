import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { UsagePanel } from "./UsagePanel";
import type { UsageStatus } from "../types";

const status = (patch: Partial<UsageStatus> = {}): UsageStatus => ({
  available: true,
  stale: false,
  source: "statusline",
  model: "Opus 5",
  five_hour: { used_percentage: 72, resets_at: 1789989000 },
  seven_day: { used_percentage: 45, resets_at: 1790157600 },
  updated_at: Date.now() / 1000,
  ...patch,
});

it("shows both windows with percentages", () => {
  render(<UsagePanel status={status()} onRefresh={() => {}} />);
  expect(screen.getByText("5 hours")).toBeInTheDocument();
  expect(screen.getByText("72%")).toBeInTheDocument();
  expect(screen.getByText("Week")).toBeInTheDocument();
  expect(screen.getByText("45%")).toBeInTheDocument();
});

it("shows the reset time and date under each window", () => {
  render(<UsagePanel status={status()} onRefresh={() => {}} />);
  const fiveHourReset = new Date(1789989000 * 1000).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
  const sevenDayReset = new Date(1790157600 * 1000).toLocaleDateString("en", { day: "numeric", month: "short" });
  expect(screen.getByText(`until ${fiveHourReset}`)).toBeInTheDocument();
  expect(screen.getByText(`until ${sevenDayReset}`)).toBeInTheDocument();
});

it("shows a dash instead of a reset window, not the old percentage", () => {
  render(<UsagePanel status={status({ five_hour: null })} onRefresh={() => {}} />);
  expect(screen.getByText("—")).toBeInTheDocument();
  expect(screen.getByText("45%")).toBeInTheDocument();
});

it("a window the plan does not have is not drawn at all: neither a row nor a dash", () => {
  render(<UsagePanel status={status({ five_hour: null, absent: ["five_hour"] })} onRefresh={() => {}} />);
  expect(screen.queryByText("5 hours")).not.toBeInTheDocument();
  expect(screen.queryByText("—")).not.toBeInTheDocument();
  expect(screen.getByText("45%")).toBeInTheDocument();
});

it("with no data it explains where they will come from, and draws no percentages", () => {
  render(<UsagePanel status={{ ...status(), available: false, five_hour: null, seven_day: null }} onRefresh={() => {}} />);
  expect(screen.getByText(/ask Claude/)).toBeInTheDocument();
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});

it("for stale numbers it shows the age of the snapshot", () => {
  const hourAgo = Date.now() / 1000 - 3600;
  render(<UsagePanel status={status({ stale: true, updated_at: hourAgo })} onRefresh={() => {}} />);
  expect(screen.getByText(/· at /)).toBeInTheDocument();
});

it("the button asks to query the limits again", async () => {
  const onRefresh = vi.fn();
  render(<UsagePanel status={status()} onRefresh={onRefresh} />);
  await userEvent.click(screen.getByRole("button", { name: "Ask Claude for limits" }));
  expect(onRefresh).toHaveBeenCalledOnce();
});

it("both windows remain in the collapsed rail", () => {
  render(<UsagePanel status={status()} onRefresh={() => {}} collapsed />);
  expect(screen.getByRole("button", { name: /Claude limits/ })).toBeInTheDocument();
  expect(screen.getByText("72")).toBeInTheDocument();
  expect(screen.getByText("45")).toBeInTheDocument();
});
