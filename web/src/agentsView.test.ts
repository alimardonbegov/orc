import { expect, it } from "vitest";
import type { Agent } from "./types";
import { DEFAULT_VIEW, applyOrder, filterAgents, groupAgents, moveInOrder, sortAgents } from "./agentsView";

const a = (id: number, over: Partial<Agent> = {}): Agent => ({
  id, name: `A${id}`, description: "", avatar: null, model: null, effort: null, permission_mode: null, prompt: "",
  project_id: null, memory_enabled: false, created_at: `2026-01-0${id}`, updated_at: "", tasks: { active: 0, total: 0 }, ...over,
} as Agent);

it("applyOrder follows the saved order, drops unknown ids and appends new agents", () => {
  const list = [a(1), a(2), a(3)];
  expect(applyOrder(list, [3, 99, 1]).map((x) => x.id)).toEqual([3, 1, 2]);
});

it("moveInOrder moves in the full list and keeps hidden agents in place", () => {
  expect(moveInOrder([1, 2, 3, 4], 1, 3)).toEqual([2, 3, 1, 4]);
  expect(moveInOrder([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3]);
  expect(moveInOrder([1, 2], 1, 1)).toEqual([1, 2]);
  expect(moveInOrder([1, 2], 1, 9)).toEqual([1, 2]);
});

it("filters by status, scope and text", () => {
  const list = [a(1, { name: "Reviewer" }), a(2, { project_id: 5, description: "writes tests" }), a(3)];
  const live = new Set([2]);
  expect(filterAgents(list, { ...DEFAULT_VIEW, status: "working" }, live).map((x) => x.id)).toEqual([2]);
  expect(filterAgents(list, { ...DEFAULT_VIEW, status: "idle" }, live).map((x) => x.id)).toEqual([1, 3]);
  expect(filterAgents(list, { ...DEFAULT_VIEW, scope: "shared" }, live).map((x) => x.id)).toEqual([1, 3]);
  expect(filterAgents(list, { ...DEFAULT_VIEW, scope: "5" }, live).map((x) => x.id)).toEqual([2]);
  expect(filterAgents(list, { ...DEFAULT_VIEW, query: " TESTS " }, live).map((x) => x.id)).toEqual([2]);
});

it("sorts by name, date and workload without touching the input", () => {
  const list = [a(2, { name: "bob", tasks: { active: 3, total: 3 } }), a(1, { name: "Alice", tasks: { active: 0, total: 9 } })];
  expect(sortAgents(list, "name").map((x) => x.id)).toEqual([1, 2]);
  expect(sortAgents(list, "newest").map((x) => x.id)).toEqual([2, 1]);
  expect(sortAgents(list, "oldest").map((x) => x.id)).toEqual([1, 2]);
  expect(sortAgents(list, "tasks").map((x) => x.id)).toEqual([2, 1]);
  expect(sortAgents(list, "manual").map((x) => x.id)).toEqual([2, 1]);
  expect(list.map((x) => x.id)).toEqual([2, 1]);
});

it("groups by scope and by model", () => {
  const list = [a(1, { model: "m1" }), a(2, { project_id: 5, model: "m1" }), a(3)];
  const scope = groupAgents(list, "scope", () => "Demo");
  expect(scope.map((s) => [s.key, s.agents.length])).toEqual([["shared", 2], ["p5", 1]]);
  expect(scope[1].label).toBe("Demo");
  expect(groupAgents(list, "model", () => "").map((s) => s.key)).toEqual(["m1", "inherit"]);
  expect(groupAgents(list, "none", () => "")).toHaveLength(1);
});
