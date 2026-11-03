import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { DispatcherPanel, railHint } from "./DispatcherPanel";
import { defaultT } from "../i18n";
import type { DispatcherStatus } from "../types";

const status = (patch: Partial<DispatcherStatus> = {}): DispatcherStatus => ({
  paused: false,
  quota_retry_after: null,
  running: 0,
  last_tick: "2026-01-01T10:00:00+00:00",
  last_tick_duration_sec: 0.4,
  last_tick_steps: {},
  tick_error_count: 0,
  verifying_now: [],
  sessions_alive: null,
  reaped_total: 0,
  load_avg: null,
  free_mem_pct: null,
  start_blocked_reason: null,
  ...patch,
});

const noop = { onPause: () => {}, onResume: () => {}, onTick: () => {} };

it("in the expanded column it shows the state and agent load in a single line", () => {
  render(<DispatcherPanel status={status({ running: 2 })} {...noop} />);
  expect(screen.getByText("running")).toBeInTheDocument();
  expect(screen.getByText("2 in progress")).toBeInTheDocument();
  // The "Orchestrator" label moved into the tooltip: a heading above the single
  // state line was an extra tier in the already dense footer of the column
  expect(screen.queryByText("Orchestrator")).not.toBeInTheDocument();
});

it("when paused it says so in a word, not only by the dot color", () => {
  render(<DispatcherPanel status={status({ paused: true })} {...noop} />);
  expect(screen.getByText("paused")).toBeInTheDocument();
  expect(screen.getByText("free")).toBeInTheDocument();
  // The button changes meaning: when paused it resumes work rather than stopping it
  expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
});

it("shows the quota and running verifications as badges", () => {
  render(
    <DispatcherPanel
      status={status({ quota_retry_after: "2026-01-01T12:30:00+00:00", verifying_now: [1, 2] })}
      {...noop}
    />,
  );
  expect(screen.getByText(/quota until/)).toBeInTheDocument();
  expect(screen.getByText("verifying: 2")).toBeInTheDocument();
});

it("in the collapsed rail there are no labels, but both commands stay available", () => {
  render(<DispatcherPanel status={status({ running: 3 })} {...noop} collapsed />);
  expect(screen.queryByText("running")).not.toBeInTheDocument();
  // The count of busy agents stays: it is the only number needed by peripheral vision
  expect(screen.getByText("3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run now" })).toBeInTheDocument();
});

it("the buttons call the pause and out-of-turn pass handlers", async () => {
  const onPause = vi.fn();
  const onTick = vi.fn();
  const user = userEvent.setup();
  render(<DispatcherPanel status={status()} onPause={onPause} onResume={() => {}} onTick={onTick} />);

  await user.click(screen.getByRole("button", { name: "Pause" }));
  await user.click(screen.getByRole("button", { name: "Run now" }));

  expect(onPause).toHaveBeenCalledTimes(1);
  expect(onTick).toHaveBeenCalledTimes(1);
});

it("with no server response it honestly says \"not responding\" and does not let the buttons be pressed", () => {
  render(<DispatcherPanel status={null} {...noop} />);
  expect(screen.getByText("not responding")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
});

it("the tooltip shows live sessions, reaped ones and the reason the start is paused", () => {
  const hint = railHint(defaultT, "en", status({ sessions_alive: 3, reaped_total: 29, load_avg: 4.1,
                                                 start_blocked_reason: "load 14.0" }));
  expect(hint).toContain("Sessions: 3 alive · 29 stopped · load 4.1");
  expect(hint).toContain("New tasks on hold: load 14.0");
});

it("until the janitor has run there is no sessions line", () => {
  expect(railHint(defaultT, "en", status())).not.toContain("Sessions:");
});

it("an old server without the session and load fields: no line, the panel does not crash", () => {
  // The SPA was rebuilt but the server has not been restarted yet: sessions_alive/load_avg arrive as undefined
  const old = status() as Partial<DispatcherStatus>;
  delete old.sessions_alive;
  delete old.load_avg;
  const hint = railHint(defaultT, "en", old as DispatcherStatus);
  expect(hint).not.toContain("Sessions:");
  const withAliveOnly = railHint(defaultT, "en", { ...status({ sessions_alive: 2 }), load_avg: undefined } as unknown as DispatcherStatus);
  expect(withAliveOnly).toContain("Sessions: 2 alive");
});

it("a start deferred because of load is shown as a badge, not only in the tooltip", () => {
  // Otherwise the "Run now" button looked broken: tasks do not start and the reason is not visible
  render(<DispatcherPanel status={status({ start_blocked_reason: "load 59.7 with 12 cores (threshold 100%)" })} {...noop} />);
  const badge = screen.getByText("start on hold");
  expect(badge.closest("[title]")?.getAttribute("title")).toContain("load 59.7");
});
