import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { defaultT } from "./i18n";
import { MAX_PINNED, clearChatDrafts, defaultAgent, draftFor, startersFor, usePinnedAgents, useChatDraft } from "./chats";
import type { Agent, Chat, Project } from "./types";

const agent = (id: number, over: Partial<Agent> = {}) => ({ id, name: `A${id}`, project_id: null, ...over }) as Agent;
const chatOf = (agent_id: number) => ({ agent_id }) as Chat;

beforeEach(() => {
  localStorage.clear();
  clearChatDrafts();
});

it("pinned agents survive a reload, and the strip holds only a few faces", () => {
  const first = renderHook(() => usePinnedAgents());
  for (let id = 1; id <= MAX_PINNED + 2; id++) act(() => first.result.current.pin(id));
  expect(first.result.current.ids).toHaveLength(MAX_PINNED);
  act(() => first.result.current.pin(1));
  expect(first.result.current.ids.filter((id) => id === 1)).toHaveLength(1);
  const second = renderHook(() => usePinnedAgents());
  expect(second.result.current.ids).toEqual(first.result.current.ids);
  act(() => second.result.current.unpin(1));
  expect(second.result.current.ids).not.toContain(1);
});

it("a damaged store is an empty strip, not a crash", () => {
  localStorage.setItem("orc.chat.pinnedAgents", "{not json");
  expect(renderHook(() => usePinnedAgents()).result.current.ids).toEqual([]);
  localStorage.setItem("orc.chat.pinnedAgents", '{"a":1}');
  expect(renderHook(() => usePinnedAgents()).result.current.ids).toEqual([]);
});

it("the agent of the latest chat is who a new chat is with; failing that, the first agent", () => {
  const agents = [agent(1), agent(2)];
  expect(defaultAgent(agents, [chatOf(2), chatOf(1)])?.id).toBe(2);
  expect(defaultAgent(agents, [chatOf(9)])?.id).toBe(1);
  expect(defaultAgent([], [])).toBeNull();
});

it("a draft takes the project of an internal agent, else of the one a lead leads, else what was chosen", () => {
  const projects = [{ id: 7, archived_at: null, path_ok: true, lead_agent_id: 3 }] as Project[];
  expect(draftFor(agent(1, { project_id: 4 }), projects, null).projectId).toBe(4);
  expect(draftFor(agent(3), projects, null).projectId).toBe(7);
  expect(draftFor(agent(1), projects, null, 5).projectId).toBe(5);
  expect(draftFor(agent(1), projects, null).projectId).toBeNull();
});

it("a chat about a project gets starters that look at it", () => {
  expect(startersFor(defaultT, true).map((s) => s.key)).toEqual(["capabilities", "overview", "tasks"]);
  expect(startersFor(defaultT, false).map((s) => s.key)).toEqual(["capabilities", "plan", "decide"]);
});

it("a draft is kept per chat and dropped when emptied", () => {
  const first = renderHook(() => useChatDraft(5));
  act(() => first.result.current[1]("half"));
  expect(renderHook(() => useChatDraft(5)).result.current[0]).toBe("half");
  expect(renderHook(() => useChatDraft(6)).result.current[0]).toBe("");
  act(() => first.result.current[1](""));
  expect(renderHook(() => useChatDraft(5)).result.current[0]).toBe("");
});
