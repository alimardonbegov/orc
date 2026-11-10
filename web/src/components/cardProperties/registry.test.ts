import { expect, it } from "vitest";
import { CARD_PROPERTIES, addableProperties, isLocked, visibleProperties } from "./registry";
import { effectiveCardSettings, defaultAgentId, parseCardSettings } from "../../cardSettings";
import type { Agent } from "../../types";
import type { CardPropertyValues } from "./types";

const blank: CardPropertyValues = { agent_id: null, priority: "normal", target_branch: "main", depends_on: [], labels: [], start_date: null, due_date: null };
const ids = (settings: object, values = blank, added: string[] = []) =>
  visibleProperties(settings, values, undefined, added).map((p) => p.id);
const REGULAR = CARD_PROPERTIES.filter((p) => !p.optional).map((p) => p.id);

it("shows the regular properties by default, in registry order, and keeps the optional ones back", () => {
  expect(ids({})).toEqual(REGULAR);
  expect(REGULAR).toEqual(["agent", "priority", "branch", "depends_on"]);
});

it("hides what the settings hide, but never the assignee", () => {
  expect(ids({ hidden: ["priority", "agent"] })).toEqual(["agent", "branch", "depends_on"]);
});

it("an optional property shows once it holds a value, in registry order", () => {
  const values = { ...blank, due_date: "2026-11-09", labels: ["bug"] };
  expect(ids({}, values)).toEqual([...REGULAR, "labels", "due_date"]);
});

it("an optional property shows once it was added from the menu", () => {
  expect(ids({}, blank, ["start_date"])).toEqual([...REGULAR, "start_date"]);
});

it("the menu offers the optional properties that are not on the card and not hidden", () => {
  const offered = (settings: object, values = blank, added: string[] = []) =>
    addableProperties(settings, values, undefined, added).map((p) => p.id);
  expect(offered({})).toEqual(["labels", "start_date", "due_date"]);
  expect(offered({ hidden: ["labels"] })).toEqual(["start_date", "due_date"]);
  expect(offered({}, { ...blank, labels: ["x"] })).toEqual(["start_date", "due_date"]);
  expect(offered({}, blank, ["due_date"])).toEqual(["labels", "start_date"]);
});

it("a hidden optional property is not shown even if asked for, until it holds a value", () => {
  expect(ids({ hidden: ["labels"] }, blank, ["labels"])).not.toContain("labels");
  expect(ids({ hidden: ["labels"] }, { ...blank, labels: ["x"] })).toContain("labels");
});

it("dates and labels can change in every status", () => {
  for (const id of ["labels", "start_date", "due_date"]) {
    const property = CARD_PROPERTIES.find((p) => p.id === id)!;
    for (const status of ["backlog", "todo", "in_progress", "verifying", "merging", "done", "failed"] as const) {
      expect(isLocked(property, status)).toBe(false);
    }
  }
});

it("a hidden property with a value stays visible: a value must not disappear silently", () => {
  expect(ids({ hidden: ["priority"] }, { ...blank, priority: "high" })).toContain("priority");
  expect(ids({ hidden: ["depends_on"] }, { ...blank, depends_on: [3] })).toContain("depends_on");
});

it("an unknown id from the settings is ignored", () => {
  expect(ids({ hidden: ["removed_long_ago"] })).toEqual(REGULAR);
});

it("properties lock once the session has its assignment", () => {
  const agent = CARD_PROPERTIES[0];
  expect(isLocked(agent, "backlog")).toBe(false);
  expect(isLocked(agent, "failed")).toBe(false);
  expect(isLocked(agent, "in_progress")).toBe(true);
  expect(isLocked(agent, "done")).toBe(true);
});

it("a project overrides orc key by key", () => {
  const app = { hidden: ["priority"], default_agent_id: 1 };
  expect(effectiveCardSettings(null, app)).toEqual(app);
  expect(effectiveCardSettings({ card_settings: null }, app)).toEqual(app);
  expect(effectiveCardSettings({ card_settings: { default_agent_id: 2 } }, app)).toEqual({ hidden: ["priority"], default_agent_id: 2 });
  // "no default here" is a choice of the project, not the absence of one
  expect(effectiveCardSettings({ card_settings: { default_agent_id: null } }, app).default_agent_id).toBeNull();
});

it("a broken setting reads as nothing set", () => {
  expect(parseCardSettings(undefined)).toEqual({});
  expect(parseCardSettings("{broken")).toEqual({});
  expect(parseCardSettings("[1]")).toEqual({});
  expect(parseCardSettings('{"hidden":["a"]}')).toEqual({ hidden: ["a"] });
});

it("a default agent that does not fit the project counts as none", () => {
  const agents = [{ id: 1, project_id: null }, { id: 2, project_id: 9 }] as Agent[];
  expect(defaultAgentId({ default_agent_id: 1 }, agents, 5)).toBe(1);
  expect(defaultAgentId({ default_agent_id: 2 }, agents, 5)).toBeNull();
  expect(defaultAgentId({ default_agent_id: 77 }, agents, 5)).toBeNull();
  expect(defaultAgentId({}, agents, 5)).toBeNull();
});
