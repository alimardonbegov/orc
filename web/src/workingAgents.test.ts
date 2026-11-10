import { describe, expect, it } from "vitest";
import { workingAgents } from "./workingAgents";
import type { Agent, Chat, Task } from "./types";

const agent = (id: number) => ({ id, name: `A${id}`, avatar: "" }) as Agent;
const task = (over: Partial<Task>) => ({ id: 1, agent_id: 1, status: "in_progress", blocker: null, archived_at: null, ...over }) as Task;
const chat = (over: Partial<Chat>) => ({ id: 1, agent_id: 1, status: "running", archived_at: null, ...over }) as Chat;

describe("workingAgents", () => {
  it("groups running cards and chats by agent", () => {
    const r = workingAgents([agent(1), agent(2)], [task({ id: 5 }), task({ id: 6, agent_id: 2, status: "verifying" })], [chat({ id: 9 })]);
    expect(r.map((w) => [w.agent.id, w.tasks.map((t) => t.id), w.chats.map((c) => c.id)])).toEqual([
      [1, [5], [9]],
      [2, [6], []],
    ]);
  });
  it("skips idle, sleeping, waiting, archived and unknown agents", () => {
    const r = workingAgents(
      [agent(1)],
      [task({ id: 1, status: "todo" }), task({ id: 2, blocker: "sleeping" }), task({ id: 3, archived_at: "x" }), task({ id: 4, agent_id: 9 })],
      [chat({ status: "waiting" }), chat({ id: 2, status: "idle" })],
    );
    expect(r).toEqual([]);
  });
});
