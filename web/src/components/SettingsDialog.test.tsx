import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import { api } from "../api";
import type { Settings } from "../types";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ApiError: actual.ApiError, api: { settings: vi.fn(), patchSettings: vi.fn(), agents: vi.fn().mockResolvedValue([]) } };
});

const settings = (prompt_template: string): Settings => ({
  card_settings: "{}", global_max_workers: "3", poll_interval_sec: "30", prompt_template,
  prompt_template_default: "the default", quota_patterns: "[]", conflict_autoresolve: "0",
  conflict_prompt_template: "", verify_workers: "2", events_retention_days: "30",
  attachments_max_total_mb: "500", worktree_autoclean: "0", worktree_retention_days: "7", hidden_models: "[]", quick_create_model: "haiku",
});

const open = async (template: string) => {
  vi.mocked(api.settings).mockResolvedValue(settings(template));
  render(<SettingsDialog open onOpenChange={vi.fn()} theme="system" onThemeChange={vi.fn()} />);
  await screen.findByDisplayValue(template);
};

beforeEach(() => vi.clearAllMocks());

it.each(["write {report_path} at the end", "write .orchestrator/report.json at the end"])(
  "warns about a kept template that orders the report: %s",
  async (template) => {
    await open(template);
    expect(screen.getByText(/still orders report\.json/)).toBeInTheDocument();
  },
);

it("says nothing about a template without it", async () => {
  await open("just do the task");
  expect(screen.queryByText(/still orders report\.json/)).not.toBeInTheDocument();
});

it("resets to the default in one click and sends only that on save", async () => {
  vi.mocked(api.patchSettings).mockResolvedValue(settings("the default"));
  await open("write {report_path}");
  await userEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  expect(screen.getByDisplayValue("the default")).toBeInTheDocument();
  expect(screen.queryByText(/still orders report\.json/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(api.patchSettings).toHaveBeenCalledWith({ prompt_template: "the default" });
});

it("saves the quick actions with the half-filled ones left out", async () => {
  vi.mocked(api.patchSettings).mockResolvedValue(settings("t"));
  await open("t");
  await userEvent.click(screen.getByRole("button", { name: "Add an action" }));
  expect(screen.getAllByLabelText("Title")).toHaveLength(5);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  const sent = vi.mocked(api.patchSettings).mock.calls[0][0];
  const stored = JSON.parse(sent.card_settings as string);
  expect(stored.quick_actions.map((a: { id: string }) => a.id)).toEqual(["review", "tests", "summary", "simplify"]);
});
