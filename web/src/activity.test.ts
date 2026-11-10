import { describe, expect, it } from "vitest";
import { NO_EXTRAS, buildConversation, buildRows, composerMode, filterConversation, filterRows, foldSteps, notificationSummary, nowFromTask, planStep } from "./activity";
import type { ActivityComment, ActivityEvent, ActivityNow, TaskDetail } from "./types";

const base = { session: 1, offset: 0, at: "2026-11-06T10:00:00Z" };
const toolCall = (id: string, name = "Bash", session = 1): ActivityEvent => ({
  ...base, session, id, kind: "tool_use", tool_use_id: id, name, summary: `run ${id}`, description: null, input: "{}", truncated: false,
});
const result = (id: string, isError = false): ActivityEvent => ({
  ...base, id: `r-${id}`, kind: "tool_result", tool_use_id: id, text: `output of ${id}`, is_error: isError, truncated: false,
});
const text = (id: string, body: string): ActivityEvent => ({ ...base, id, kind: "text", text: body, truncated: false });

describe("buildRows", () => {
  it("makes one row of a call and its result, and a call without a result is still running", () => {
    const rows = buildRows([toolCall("a"), result("a"), toolCall("b")]);
    expect(rows.map((r) => r.kind)).toEqual(["tool", "tool"]);
    expect(rows[0].kind === "tool" && rows[0].result?.text).toBe("output of a");
    expect(rows[1].kind === "tool" && rows[1].result).toBeNull();
  });

  it("keeps a result silent until its call arrives", () => {
    expect(buildRows([result("a")])).toEqual([]);
    const rows = buildRows([toolCall("a"), result("a")]);
    expect(rows).toHaveLength(1);
  });

  it("a call cut off by a new human turn or a new session is not running anymore", () => {
    const prompt: ActivityEvent = { ...base, id: "p", kind: "prompt", text: "go on", truncated: false, origin: "human" };
    const afterTurn = buildRows([toolCall("a"), prompt, toolCall("b")]);
    expect(afterTurn[0].kind === "tool" && afterTurn[0].interrupted).toBe(true);
    expect(afterTurn[2].kind === "tool" && afterTurn[2].interrupted).toBe(false);
    const afterSession = buildRows([toolCall("a"), toolCall("b", "Bash", 2)]);
    expect(afterSession[0].kind === "tool" && afterSession[0].interrupted).toBe(true);
    // A message delivered mid-run does not interrupt anything
    const delivered: ActivityEvent = { ...prompt, id: "d", origin: "delivered" };
    const soft = buildRows([toolCall("a"), delivered]);
    expect(soft[0].kind === "tool" && soft[0].interrupted).toBe(false);
  });

  it("marks where a new session begins", () => {
    const rows = buildRows([toolCall("a"), toolCall("b", "Bash", 2)]);
    expect(rows.map((r) => r.kind)).toEqual(["tool", "session", "tool"]);
  });
});

describe("filterRows", () => {
  const rows = buildRows([
    text("t", "looking at the tests"),
    toolCall("ok"),
    result("ok"),
    toolCall("bad", "Read"),
    result("bad", true),
    { ...base, id: "n", kind: "notice", notice: "error", text: "overloaded", level: "error" },
    { ...base, id: "th", kind: "thinking", text: "hmm", duration_ms: null, truncated: false },
  ]);
  const ids = (filter: Parameters<typeof filterRows>[1], search = "") => filterRows(rows, filter, search).map((r) => r.id);

  it("filters by kind, with a failed call counted among the errors", () => {
    expect(ids("messages")).toEqual(["t"]);
    expect(ids("tools")).toEqual(["ok", "bad"]);
    expect(ids("thinking")).toEqual(["th"]);
    expect(ids("errors")).toEqual(["bad", "n"]);
  });

  it("searches text, commands and their output", () => {
    expect(ids("all", "TESTS")).toEqual(["t"]);
    expect(ids("all", "output of bad")).toEqual(["bad"]);
    expect(ids("all", "nothing like this")).toEqual([]);
  });
});

it("a background notification shows its summary and not the XML", () => {
  expect(notificationSummary("<task-notification><summary>Agent finished</summary></task-notification>")).toBe("Agent finished");
  expect(notificationSummary("plain")).toBe("plain");
});

describe("buildConversation", () => {
  const at = (sec: number) => `2026-11-06T10:00:${String(sec).padStart(2, "0")}.500Z`;
  const comment = (id: number, kind: ActivityComment["kind"], body: string, sec: number, extra: Partial<ActivityComment> = {}): ActivityComment => ({
    id, task_id: 7, author: "user", kind, body, created_at: `2026-11-06T10:00:${String(sec).padStart(2, "0")}+00:00`, ...extra,
  });
  const prompt = (id: string, body: string, sec: number, origin = "human"): ActivityEvent => ({
    ...base, id, at: at(sec), kind: "prompt", text: body, truncated: false, origin,
  });
  const callAt = (id: string, sec: number, over: Partial<Extract<ActivityEvent, { kind: "tool_use" }>> = {}): ActivityEvent =>
    ({ ...toolCall(id), at: at(sec), ...over }) as ActivityEvent;
  const extras = (comments: ActivityComment[] | null, more: Partial<typeof NO_EXTRAS> = {}) => ({ ...NO_EXTRAS, comments, ...more });
  const kinds = (rows: ReturnType<typeof buildConversation>) => rows.map((r) => r.kind);

  it("a message to the agent is one entry, the comment, and the transcript prompt only marks it as read", () => {
    const answer = comment(1, "answer", "use port 8080", 12, { sent_text: "use port 8080", delivery: "sent" });
    const rows = buildConversation(
      [prompt("p0", "You are performing a task", 1), callAt("a", 5), result("a"), prompt("p1", "Message from the owner:\nuse port 8080", 13, "delivered")],
      extras([answer]),
      null,
    );
    expect(kinds(rows)).toEqual(["handoff", "tool", "comment"]);
    const line = rows.find((r) => r.kind === "comment");
    expect(line?.kind === "comment" && line.read).toBe(true);
  });

  it("a short answer is not mistaken for a part of the task statement, and a later prompt does not take a message twice", () => {
    const statement = "You are performing a task from the orchestrator queue. Work autonomously. Do you agree, да? Rules: ".padEnd(900, "x");
    const yes = comment(1, "answer", "да", 12, { sent_text: "да", delivery: "queued" });
    const rows = buildConversation([prompt("p0", statement, 1), toolCall("a"), prompt("p2", "verification failed: да, tests are red".padEnd(300, "y"), 30)], extras([yes]), null);
    expect(kinds(rows)).toEqual(["handoff", "tool", "comment", "handoff"]);
    expect(rows.find((r) => r.kind === "comment" && r.read)).toBeUndefined();
    const delivered = buildConversation([prompt("p0", statement, 1), prompt("p1", "да", 14, "delivered")], extras([yes]), null);
    expect(kinds(delivered)).toEqual(["handoff", "comment"]);
    expect(delivered.find((r) => r.kind === "comment" && r.read)).toBeDefined();
  });

  it("a prompt that carries several queued messages marks all of them as read", () => {
    const one = comment(1, "answer", "first", 5, { sent_text: "first", delivery: "sent" });
    const two = comment(2, "answer", "second", 6, { sent_text: "second", delivery: "sent" });
    const rows = buildConversation([prompt("p1", "first\n\nsecond", 9)], extras([one, two]), null);
    expect(rows.map((r) => r.kind === "comment" && r.read)).toEqual([true, true]);
  });

  it("a message not yet read stays marked as waiting, and a plain note never looks like a message", () => {
    const rows = buildConversation([], extras([comment(1, "answer", "go", 5, { sent_text: "go", delivery: "queued" }), comment(2, "comment", "a fact", 6)]), null);
    const [first, second] = rows;
    expect(first.kind === "comment" && first.read).toBe(false);
    expect(second.kind === "comment" && second.comment.sent_text).toBeUndefined();
  });

  it("any other human prompt of a task is orc's: the first is the task, later ones are handoffs", () => {
    const rows = buildConversation([prompt("p0", "task text", 1), prompt("p1", "verification failed: tests", 9)], extras([]), null);
    expect(rows.map((r) => r.kind === "handoff" && r.first)).toEqual([true, false]);
  });

  it("with earlier history still unloaded, the first prompt on screen is not called the task statement", () => {
    const rows = buildConversation([prompt("p1", "verification failed", 9)], extras([]), null, false);
    expect(rows[0].kind === "handoff" && rows[0].first).toBe(false);
  });

  it("in a chat the prompt is the owner's own words and stays an event", () => {
    expect(kinds(buildConversation([prompt("p0", "hello", 1)], extras(null), null))).toEqual(["event"]);
  });

  it("comments and stages are placed by time among the steps", () => {
    const rows = buildConversation(
      [callAt("a", 2), result("a"), callAt("b", 20), result("b")],
      extras([comment(1, "comment", "note", 10)], { stages: [{ id: 1, at: "2026-11-06T10:00:15+00:00", level: "info", text: "verification started" }] }),
      null,
    );
    expect(kinds(rows)).toEqual(["tool", "comment", "stage", "tool"]);
  });

  it("an old report comment stays in the thread, steps or not", () => {
    const archived = comment(1, "report", "old summary", 3, { author: "claude" });
    expect(kinds(buildConversation([callAt("a", 5)], extras([archived]), null))).toEqual(["comment", "tool"]);
    expect(kinds(buildConversation([], extras([archived]), null))).toEqual(["comment"]);
  });

  describe("what waits for the owner", () => {
    const nowWith = (over: Partial<ActivityNow>) => ({ live: true, processes: [], ...over }) as unknown as ActivityNow;
    const request = { id: 3, task_id: 7, kind: "question" as const, tool_name: "AskUserQuestion", tool_input: null, summary: "Which port?", state: "open" as const, created_at: "" };

    it("an open request hides the call that raised it: the question is shown once, by its form", () => {
      const events = [callAt("a", 4), result("a"), callAt("q", 5, { name: "AskUserQuestion" })];
      const rows = buildConversation(events, extras([]), nowWith({ phase: "waiting_input", input_request: request }));
      expect(rows.map((r) => r.id)).toEqual(["a"]);
      // Without a request the same call is just a running step
      expect(buildConversation(events, extras([]), nowWith({ phase: "working" })).map((r) => r.id)).toEqual(["a", "q"]);
    });

    it("a question at the end of a turn marks the agent's last message instead of repeating it", () => {
      const events = [{ ...text("t1", "Which port should be used?"), at: at(5) }, { ...callAt("c", 6) }, result("c")];
      const rows = buildConversation(events, extras([]), nowWith({ phase: "waiting_reply", waiting_detail: "Which port should be used?" }));
      expect(kinds(rows)).toEqual(["event", "waiting", "tool"]);
      const mark = rows[1];
      expect(mark.kind === "waiting" && mark.text).toBeNull();
    });

    it("a question cut short by the dispatcher still marks the message it came from", () => {
      const long = `Which port should be used?\n\n${"Some context. ".repeat(20)}`;
      const rows = buildConversation([{ ...text("t1", long), at: at(5) }], extras([]), nowWith({ phase: "waiting_reply", waiting_detail: `${long.slice(0, 60)}…` }));
      expect(kinds(rows)).toEqual(["event", "waiting"]);
      const mark = rows[1];
      expect(mark.kind === "waiting" && mark.text).toBeNull();
    });

    it("a wait the agent did not write (Claude Code's own dialog) is not pinned on its last message", () => {
      const said = { ...text("t1", "Now I'll edit app.py"), at: at(5) };
      const rows = buildConversation([said], extras([]), nowWith({ phase: "waiting_reply", waiting_detail: "Requests permission: Update: app.py" }));
      expect(kinds(rows)).toEqual(["event", "waiting"]);
      const last = rows[1];
      expect(last.kind === "waiting" && last.text).toBe("Requests permission: Update: app.py");
    });

    it("without a message of this turn to mark, the question itself comes last", () => {
      const earlier = { ...text("t1", "Done with the first part"), at: at(2) };
      const answer = comment(1, "answer", "go on", 4, { sent_text: "go on" });
      const rows = buildConversation([earlier], extras([answer]), nowWith({ phase: "waiting_reply", waiting_detail: "Which port?" }));
      expect(kinds(rows)).toEqual(["event", "comment", "waiting"]);
      const last = rows[2];
      expect(last.kind === "waiting" && last.text).toBe("Which port?");
    });

    it("a failure carries its whole detail in the place of its cut stage, or last when the log lost it", () => {
      const stage = { id: 9, at: at(4), level: "error", text: "failed: the session crashed wi" };
      const failed = nowWith({ phase: "failed", status: "failed", failed_detail: "the session crashed with a long trace" });
      const rows = buildConversation([callAt("a", 2), callAt("b", 6)], extras([], { stages: [stage] }), failed);
      expect(kinds(rows)).toEqual(["tool", "failure", "tool"]);
      const row = rows[1];
      expect(row.kind === "failure" && row.detail).toBe("the session crashed with a long trace");
      expect(kinds(buildConversation([callAt("a", 2)], extras([]), failed))).toEqual(["tool", "failure"]);
    });

    it("the failure row carries the code of its reason", () => {
      const coded = nowWith({ phase: "failed", status: "failed", failed_detail: "state lost", detail_code: "session_lost" });
      const row = buildConversation([callAt("a", 2)], extras([]), coded)[1];
      expect(row.kind === "failure" && row.code).toBe("session_lost");
    });
  });

  describe("delegation", () => {
    const delegating = (over: Partial<ActivityEvent> = {}) =>
      callAt("t1", 5, { name: "Agent", summary: "Survey", delegate: { agent_type: "Explore", description: "Survey the repo" }, ...over } as never);
    const live = { live: true, processes: [] } as unknown as ActivityNow;
    const state = (events: ActivityEvent[], delegations: { tool_use_id: string; agent_id: string; agent_type: string | null; finished: boolean }[], now: ActivityNow | null) => {
      const row = buildConversation(events, extras([], { delegations }), now).find((r) => r.kind === "delegate");
      return row?.kind === "delegate" ? row.state : null;
    };

    it("a call that hands work over is its own row and is never folded into the steps", () => {
      const rows = foldSteps(buildConversation([callAt("x", 4), delegating(), callAt("y", 6)], extras([]), live));
      expect(kinds(rows)).toEqual(["steps", "delegate", "steps"]);
    });

    it("a background subagent is running until its meta file says it finished, whatever the call's own result said", () => {
      const launched = [delegating(), result("t1")];
      expect(state(launched, [{ tool_use_id: "t1", agent_id: "ab", agent_type: "Explore", finished: false }], live)).toBe("running");
      expect(state(launched, [{ tool_use_id: "t1", agent_id: "ab", agent_type: "Explore", finished: true }], live)).toBe("done");
    });

    it("a notification that the background task failed wins over a meta file that is not updated yet", () => {
      const notice = prompt("n", "<task-notification><task-id>ab</task-id><status>failed</status></task-notification>", 9, "task_notification");
      expect(state([delegating(), notice], [{ tool_use_id: "t1", agent_id: "ab", agent_type: "Explore", finished: false }], live)).toBe("failed");
    });

    it("without a subagent file a synchronous call is done with its result, and cut off when the session is gone", () => {
      expect(state([delegating(), result("t1")], [], live)).toBe("done");
      expect(state([delegating(), result("t1", true)], [], live)).toBe("failed");
      expect(state([delegating()], [], live)).toBe("running");
      expect(state([delegating()], [], { live: false } as ActivityNow)).toBe("interrupted");
    });
  });
});

describe("foldSteps and filterConversation", () => {
  const rows = buildConversation(
    [text("t1", "first answer"), toolCall("a"), result("a"), toolCall("b"), result("b", true), text("t2", "second answer"), toolCall("c")],
    NO_EXTRAS,
    null,
  );

  it("steps in a row become one group between the messages", () => {
    const folded = foldSteps(rows);
    expect(folded.map((r) => r.kind)).toEqual(["event", "steps", "event", "steps"]);
    expect(folded[1].kind === "steps" && folded[1].rows).toHaveLength(2);
  });

  it("filtering looks at single steps, so a match is not hidden in a group", () => {
    expect(filterConversation(rows, "errors", "").map((r) => r.id)).toEqual(["b"]);
    expect(filterConversation(rows, "all", "second").map((r) => r.kind)).toEqual(["event"]);
  });
});

describe("planStep", () => {
  const now = (todos: { label: string; status: "pending" | "in_progress" | "done" }[]) => ({ todos }) as ActivityNow;

  it("names the item in progress, otherwise the next one, and nothing when the plan is done", () => {
    expect(planStep(now([{ label: "a", status: "done" }, { label: "b", status: "in_progress" }, { label: "c", status: "pending" }]))).toEqual({ label: "b", index: 2, total: 3 });
    expect(planStep(now([{ label: "a", status: "done" }, { label: "c", status: "pending" }]))).toEqual({ label: "c", index: 2, total: 2 });
    expect(planStep(now([{ label: "a", status: "done" }]))).toBeNull();
    expect(planStep(now([]))).toBeNull();
    expect(planStep(null)).toBeNull();
  });
});

// One case per row of the composer table: the state of the card decides what the one field sends.
describe("composerMode", () => {
  const now = (phase: ActivityNow["phase"], live = false) => ({ phase, live });
  it.each([
    ["not started: backlog", now("backlog"), "not_started"],
    ["not started: in the queue", now("todo"), "not_started"],
    ["working", now("working", true), "working"],
    ["working: finished its turn", now("idle", true), "working"],
    ["working: delivering a message", now("delivering", true), "working"],
    ["working: starting", now("starting", true), "working"],
    ["waiting for a reply", now("waiting_reply", true), "waiting_reply"],
    ["open input request", now("waiting_input", true), "request"],
    ["quota", now("quota", true), "quota"],
    ["failed", now("failed"), "failed"],
    ["done", now("done"), "done"],
    ["verifying", now("verifying"), "finishing"],
    ["merging", now("merging"), "finishing"],
    ["a session that just stopped", now("stopped", true), "note"],
  ] as const)("%s", (_, state, mode) => {
    expect(composerMode("task", state)).toBe(mode);
  });

  it("an archived card takes notes only, and nothing is known before the first answer", () => {
    expect(composerMode("task", now("done"), true)).toBe("note");
    expect(composerMode("task", null)).toBeNull();
  });

  it("a chat is written to while its session lives", () => {
    expect(composerMode("chat", now("working", true))).toBe("chat");
    expect(composerMode("chat", now("waiting_reply", true))).toBe("chat");
    expect(composerMode("chat", now("idle", false))).toBeNull();
  });

  it("before the feed answers, the card's own state says the same", () => {
    const task = { status: "in_progress", blocker: "needs_input", blocker_detail: "Which port?", input_request: null, outbox_state: null, session_id: "s" } as unknown as TaskDetail;
    expect(composerMode("task", nowFromTask(task))).toBe("waiting_reply");
    expect(nowFromTask(task).waiting_detail).toBe("Which port?");
    expect(composerMode("task", nowFromTask({ ...task, blocker: "quota" }))).toBe("quota");
    expect(composerMode("task", nowFromTask({ ...task, status: "failed", blocker: null }))).toBe("failed");
  });
});
