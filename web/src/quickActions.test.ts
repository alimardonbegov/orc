import { expect, it, vi } from "vitest";
import { api } from "./api";
import { cleanCardSettings, effectiveCardSettings } from "./cardSettings";
import { filterQuickActions, newActionId, quickActionSender, resolveQuickActions, slashQuery } from "./quickActions";

vi.mock("./api", () => ({ api: { addComment: vi.fn(async () => ({})), resume: vi.fn(async () => ({})) } }));

const t = (key: string) => key;

it("the sender follows the state of the card, like the composer", async () => {
  const live = { has_session: true };
  await quickActionSender("working", live, 5)!("x");
  expect(api.addComment).toHaveBeenLastCalledWith(5, "x", "answer");
  await quickActionSender("waiting_reply", live, 5)!("x");
  expect(api.addComment).toHaveBeenLastCalledWith(5, "x", "answer");
  await quickActionSender("done", live, 5)!("y");
  expect(api.addComment).toHaveBeenLastCalledWith(5, "y", "rework");
  await quickActionSender("failed", live, 5)!("z");
  expect(api.resume).toHaveBeenLastCalledWith(5, "z");
  for (const mode of ["not_started", "finishing", "note", "quota", "request", "chat", null] as const) {
    expect(quickActionSender(mode, live, 5)).toBeNull();
  }
  expect(quickActionSender("failed", { has_session: false }, 5)).toBeNull();
});

it("slashQuery reads a single leading word only", () => {
  expect(slashQuery("/")).toBe("");
  expect(slashQuery("/Te")).toBe("te");
  for (const text of ["", "hi", "/a b", " /a", "a/b", "/a\nb"]) expect(slashQuery(text)).toBeNull();
});

it("filters by title or id and keeps the order", () => {
  const list = [{ id: "r", title: "Review", prompt: "p" }, { id: "t", title: "Tests", prompt: "p" }];
  expect(filterQuickActions(list, "")).toEqual(list);
  expect(filterQuickActions(list, "rev").map((a) => a.id)).toEqual(["r"]);
  expect(filterQuickActions(list, "t").map((a) => a.id)).toEqual(["t"]);
  expect(filterQuickActions(list, "zzz")).toEqual([]);
});

it("shows the built-in set until a list is stored; an empty stored list means none", () => {
  expect(resolveQuickActions({}, t).map((a) => a.title)).toContain("card.quickActions.defaults.review");
  expect(resolveQuickActions({ quick_actions: [] }, t)).toEqual([]);
  const own = [{ id: "a", title: "A", prompt: "p" }];
  expect(resolveQuickActions({ quick_actions: own }, t)).toEqual(own);
});

it("a project's list replaces the orc list as a whole", () => {
  const app = { quick_actions: [{ id: "a", title: "A", prompt: "p" }] };
  expect(effectiveCardSettings({ card_settings: { hidden: ["x"] } }, app).quick_actions).toEqual(app.quick_actions);
  const own = [{ id: "b", title: "B", prompt: "q" }];
  expect(effectiveCardSettings({ card_settings: { quick_actions: own } }, app).quick_actions).toEqual(own);
});

it("cleaning drops half-filled actions and trims the rest", () => {
  const cleaned = cleanCardSettings({ quick_actions: [{ id: "a", title: " A ", prompt: " p " }, { id: "b", title: "", prompt: "x" }, { id: "c", title: "C", prompt: " " }] });
  expect(cleaned.quick_actions).toEqual([{ id: "a", title: "A", prompt: "p" }]);
  expect(cleanCardSettings({ hidden: ["x"] })).toEqual({ hidden: ["x"] });
  expect(cleanCardSettings(null)).toBeNull();
});

it("a new id never collides", () => {
  expect(newActionId([{ id: "action-2", title: "", prompt: "" }])).toBe("action-3");
  expect(newActionId([])).toBe("action-1");
});
