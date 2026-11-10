import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ActivityQuery } from "./api";
import type { ActivityComment, ActivityDelegation, ActivityEvent, ActivityNow, ActivityPage, ActivityStage, OsProcesses, TaskDetail } from "./types";

/** Whose feed: a task or a direct chat, or one subagent inside them. All look the same from here on. */
export interface ActivitySource {
  kind: "task" | "chat";
  id: number;
  /** The subagent to read instead of the main session. */
  agent?: string;
}

export function fetchPage(source: ActivitySource, params: ActivityQuery): Promise<ActivityPage> {
  const query = source.agent ? { ...params, agent: source.agent } : params;
  return source.kind === "task" ? api.taskActivity(source.id, query) : api.chatActivity(source.id, query);
}

export function fetchFullResult(source: ActivitySource, session: number, offset: number, toolUseId: string): Promise<{ text: string }> {
  return source.kind === "task"
    ? api.taskActivityResult(source.id, session, offset, toolUseId, source.agent)
    : api.chatActivityResult(source.id, session, offset, toolUseId, source.agent);
}

export function fetchProcesses(source: ActivitySource): Promise<OsProcesses> {
  return source.kind === "task" ? api.taskProcesses(source.id) : api.chatProcesses(source.id);
}

type ToolUse = Extract<ActivityEvent, { kind: "tool_use" }>;
type ToolResult = Extract<ActivityEvent, { kind: "tool_result" }>;

/** A row of the feed: a call and its result are one row, the rest are events as they are. */
export type ActivityRow =
  /** interrupted: there is no result and there never will be: the session moved on without it. */
  | { kind: "tool"; id: string; use: ToolUse; result: ToolResult | null; interrupted: boolean }
  | { kind: "session"; id: string }
  | { kind: "event"; id: string; event: Exclude<ActivityEvent, ToolUse | ToolResult> };

export type ActivityFilter = "all" | "messages" | "tools" | "thinking" | "errors";

/**
 * Events into rows. A result whose call is out of the loaded window waits silently: "show earlier"
 * will bring the call and the pair will come together.
 */
export function buildRows(events: readonly ActivityEvent[]): ActivityRow[] {
  const results = new Map<string, ToolResult>();
  for (const event of events) {
    if (event.kind === "tool_result") results.set(event.tool_use_id, event);
  }
  const rows: ActivityRow[] = [];
  let session: number | null = null;
  // A stop cuts a running call off, and its result never comes. A new session or a new human turn
  // says so: without this, such a call would spin forever in the log.
  const closeOpenCalls = () => {
    for (const row of rows) {
      if (row.kind === "tool" && !row.result) row.interrupted = true;
    }
  };
  for (const event of events) {
    if (event.kind === "tool_result") continue;
    if (session !== null && event.session !== session) {
      closeOpenCalls();
      rows.push({ kind: "session", id: `session:${event.id}` });
    }
    session = event.session;
    if (event.kind === "prompt" && event.origin === "human") closeOpenCalls();
    if (event.kind === "tool_use") {
      rows.push({ kind: "tool", id: event.id, use: event, result: results.get(event.tool_use_id) ?? null, interrupted: false });
    } else {
      rows.push({ kind: "event", id: event.id, event });
    }
  }
  return rows;
}

function rowMatches(row: ActivityRow, filter: ActivityFilter): boolean {
  if (filter === "all") return true;
  if (row.kind === "session") return false;
  if (row.kind === "tool") return filter === "tools" || (filter === "errors" && Boolean(row.result?.is_error));
  const { event } = row;
  if (filter === "messages") return event.kind === "text" || event.kind === "prompt";
  if (filter === "thinking") return event.kind === "thinking";
  if (filter === "tools") return false;
  return event.kind === "notice" && event.level === "error";
}

function rowText(row: ActivityRow): string {
  if (row.kind === "session") return "";
  if (row.kind === "tool") return `${row.use.name} ${row.use.summary} ${row.use.input} ${row.result?.text ?? ""}`;
  return row.event.text;
}

export function filterRows(rows: ActivityRow[], filter: ActivityFilter, search: string): ActivityRow[] {
  const needle = search.trim().toLowerCase();
  return rows.filter((row) => rowMatches(row, filter) && (!needle || rowText(row).toLowerCase().includes(needle)));
}

// ---------- the conversation: steps, comments and stages in one thread ----------

/** What a card adds around the session's steps. comments: null is a chat, where prompts are the owner's words. */
export interface ConversationExtras {
  comments: readonly ActivityComment[] | null;
  stages: readonly ActivityStage[];
  delegations: readonly ActivityDelegation[];
}

export const NO_EXTRAS: ConversationExtras = { comments: null, stages: [], delegations: [] };

type EventRow = Extract<ActivityRow, { kind: "event" }>;
type ToolRow = Extract<ActivityRow, { kind: "tool" }>;

/** A step: work the owner reads only when curious. Messages and decisions stay outside of it. */
export type StepRow = ToolRow | EventRow;

export type ConversationRow =
  | Exclude<ActivityRow, { kind: "tool" }>
  | ToolRow
  /** The owner's comment or message, at the time it was written. */
  | { kind: "comment"; id: string; comment: ActivityComment; read: boolean }
  /** What orc itself told the session: the task statement, a failed verification, a resume after a crash. */
  | { kind: "handoff"; id: string; event: Extract<ActivityEvent, { kind: "prompt" }>; first: boolean }
  /** A moment in the task's life. */
  | { kind: "stage"; id: string; stage: ActivityStage }
  /** A call that handed work to a subagent. It is never folded: who does the work matters. */
  | { kind: "delegate"; id: string; row: ToolRow; delegation: ActivityDelegation | null; state: DelegateState }
  /** Steps in a row between two messages, folded into one line. */
  | { kind: "steps"; id: string; rows: StepRow[] }
  /**
   * The agent waits for the owner's reply. `text` is null when its last message is already in the thread,
   * right above: the row only marks it. Otherwise the transcript cannot be read, and the row carries the question.
   */
  | { kind: "waiting"; id: string; text: string | null }
  /** Why the task stopped, in full: the stage of the same moment in the event log is cut to a line. */
  | { kind: "failure"; id: string; detail: string; code?: string | null; at: string | null };

export type DelegateState = "running" | "done" | "failed" | "interrupted";

function rowTime(at: string | null | undefined): number {
  const time = at ? Date.parse(at) : NaN;
  return Number.isFinite(time) ? time : NaN;
}

function promptOf(row: ActivityRow): Extract<ActivityEvent, { kind: "prompt" }> | null {
  return row.kind === "event" && row.event.kind === "prompt" ? row.event : null;
}

/** A background task's verdict from its notification: `<task-id>` and `<status>` are in the text. */
function notifiedStates(events: readonly ActivityEvent[]): Map<string, string> {
  const states = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "prompt" || event.origin !== "task_notification") continue;
    const id = /<task-id>([^<]+)<\/task-id>/.exec(event.text)?.[1];
    const status = /<status>([^<]+)<\/status>/.exec(event.text)?.[1];
    if (id && status) states.set(id, status);
  }
  return states;
}

function delegateState(row: ToolRow, delegation: ActivityDelegation | null, notified: Map<string, string>, now: ActivityNow | null): DelegateState {
  if (delegation) {
    const verdict = notified.get(delegation.agent_id);
    const process = now?.processes.find((p) => p.id === delegation.agent_id);
    if (process?.status === "failed" || verdict === "failed") return "failed";
    if (delegation.finished || process?.status === "done" || verdict === "completed") return "done";
    return now?.live ? "running" : "interrupted";
  }
  if (row.result) return row.result.is_error ? "failed" : "done";
  return row.interrupted || !now?.live ? "interrupted" : "running";
}

/** Room for orc's own words around a message in the prompt it went into: the delivery prefix is about 60 characters. */
const PROMPT_WRAP_CHARS = 80;

/**
 * The messages this prompt carried into the session. A short answer such as "yes" is a substring of
 * almost any prompt, so a text match alone is not enough: the message must have been written before the
 * prompt, not yet taken by an earlier one, and the prompt must be about as long as the messages in it. A
 * task statement or a failed-verification note is far longer.
 */
function answeredBy(prompt: Extract<ActivityEvent, { kind: "prompt" }>, comments: readonly ActivityComment[], taken: ReadonlySet<number>): ActivityComment[] {
  const sentAt = rowTime(prompt.at);
  const matching = comments.filter((c) => {
    if (!c.sent_text || taken.has(c.id) || !prompt.text.includes(c.sent_text)) return false;
    const wrote = rowTime(c.created_at);
    return !Number.isFinite(sentAt) || !Number.isFinite(wrote) || wrote <= sentAt;
  });
  const carried = matching.reduce((sum, c) => sum + (c.sent_text?.length ?? 0), 0);
  return prompt.text.length <= carried + PROMPT_WRAP_CHARS ? matching : [];
}

/**
 * One thread out of everything that happened on a task, in time order.
 *
 * A message from the owner arrives twice: as a comment and as a prompt in the transcript. The comment
 * stays, because it is what the owner wrote and when, and the prompt only marks it as read. Any other
 * human prompt in a task came from orc itself, whatever its text: the owner has no other way into a
 * session, and the prompt template is theirs to change, so its wording proves nothing.
 */
export function buildConversation(
  events: readonly ActivityEvent[],
  extras: ConversationExtras,
  now: ActivityNow | null,
  /** The loaded events begin at the start of the transcript: only then is the first prompt the task statement. */
  fromStart = true,
): ConversationRow[] {
  const comments = extras.comments;
  // An old report stays in the thread as a muted row: the agent's final message says the same, but a card
  // from before the handoff may have nothing else.
  const shownComments = comments ?? [];
  const read = new Set<number>();
  const notified = notifiedStates(events);
  const byCall = new Map(extras.delegations.map((d) => [d.tool_use_id, d]));
  const base: ConversationRow[] = [];
  let firstPrompt = true;
  for (const row of buildRows(events)) {
    const prompt = promptOf(row);
    if (prompt && comments !== null && (prompt.origin === "human" || prompt.origin === "delivered")) {
      const answered = answeredBy(prompt, shownComments, read);
      answered.forEach((c) => read.add(c.id));
      const first = firstPrompt && fromStart;
      firstPrompt = false;
      if (answered.length === 0) base.push({ kind: "handoff", id: row.id, event: prompt, first });
      continue;
    }
    if (row.kind === "tool" && row.use.delegate) {
      const delegation = byCall.get(row.use.tool_use_id) ?? null;
      base.push({ kind: "delegate", id: row.id, row, delegation, state: delegateState(row, delegation, notified, now) });
      continue;
    }
    base.push(row);
  }
  const extra: { at: number; row: ConversationRow }[] = [
    ...shownComments.map((comment) => ({
      at: rowTime(comment.created_at),
      row: { kind: "comment" as const, id: `comment:${comment.id}`, comment, read: read.has(comment.id) || comment.delivery === "delivered" },
    })),
    ...stageRows(extras.stages, now),
  ].sort((a, b) => a.at - b.at);
  return markWaiting(mergeByTime(hideRequestedCall(base, now), extra), now);
}

/**
 * Stages, with the failure in full. The event log cuts its text to a line: the row of the same moment
 * carries the whole detail instead, and when the log no longer has it, the detail comes last.
 */
function stageRows(stages: readonly ActivityStage[], now: ActivityNow | null): { at: number; row: ConversationRow }[] {
  const rows: { at: number; row: ConversationRow }[] = stages.map((stage) => ({ at: rowTime(stage.at), row: { kind: "stage" as const, id: `stage:${stage.id}`, stage } }));
  const detail = now?.status === "failed" ? now.failed_detail : null;
  if (!detail) return rows;
  const last = [...stages].reverse().find((s) => s.level === "error" && s.text.startsWith("failed"));
  if (last) {
    const at = rows.findIndex((r) => r.row.id === `stage:${last.id}`);
    rows[at] = { at: rows[at].at, row: { kind: "failure", id: `failure:${last.id}`, detail, code: now?.detail_code, at: last.at } };
  } else {
    rows.push({ at: Infinity, row: { kind: "failure", id: "failure", detail, code: now?.detail_code, at: null } });
  }
  return rows;
}

/**
 * An open request is answered with its own form at the end of the thread. The call that raised it has no
 * result yet and would show the same question a second time, so it is left out. The request does not
 * carry the call's id: the last unanswered call of the same tool is the one.
 */
function hideRequestedCall(rows: ConversationRow[], now: ActivityNow | null): ConversationRow[] {
  const request = now?.input_request;
  if (!request) return rows;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const call = row.kind === "tool" ? row : row.kind === "delegate" ? row.row : null;
    if (call && !call.result && !call.interrupted && call.use.name === request.tool_name) {
      return [...rows.slice(0, i), ...rows.slice(i + 1)];
    }
  }
  return rows;
}

function flat(text: string): string {
  return text.replace(/…$/, "").split(/\s+/).join(" ").trim();
}

/**
 * Whether the agent's message is the question the card waits on. The dispatcher keeps the turn's final
 * text, shortened with "…"; the feed may cut a long message too, and a turn may end with several. A wait
 * the session's state reports instead (Claude Code's own dialog, when the hook missed it) is the daemon's
 * words, "Requests permission: …", which the agent never wrote.
 */
function isTheQuestion(message: string, detail: string): boolean {
  const said = flat(message);
  const asked = flat(detail);
  if (!said || !asked) return false;
  return said.startsWith(asked) || asked.includes(said);
}

/**
 * A question at the end of a turn is the agent's last message. It gets a mark instead of a copy: the
 * owner reads it once, where it was said. When the last message is not the question, or there is none,
 * the question itself comes last.
 */
function markWaiting(rows: ConversationRow[], now: ActivityNow | null): ConversationRow[] {
  if (now?.phase !== "waiting_reply") return rows;
  const detail = now.waiting_detail ?? "";
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === "event" && row.event.kind === "text") {
      // Nothing to compare with: the last message is all there is to go by
      if (!detail.trim() || isTheQuestion(row.event.text, detail)) {
        return [...rows.slice(0, i + 1), { kind: "waiting", id: "waiting", text: null }, ...rows.slice(i + 1)];
      }
      break;
    }
    // Only the current turn counts: past the owner's last word, an earlier message is not the question.
    if (row.kind === "comment" && row.comment.kind !== "comment") break;
  }
  return [...rows, { kind: "waiting", id: "waiting", text: detail }];
}

function conversationTime(row: ConversationRow): number {
  if (row.kind === "tool") return rowTime(row.use.at);
  if (row.kind === "delegate") return rowTime(row.row.use.at);
  if (row.kind === "event" || row.kind === "handoff") return rowTime(row.event.at);
  return NaN;
}

/** Comments have whole seconds and steps milliseconds: an equal time goes to the step already there. */
function mergeByTime(base: ConversationRow[], extra: { at: number; row: ConversationRow }[]): ConversationRow[] {
  const merged: ConversationRow[] = [];
  let next = 0;
  for (const row of base) {
    const time = conversationTime(row);
    while (next < extra.length && Number.isFinite(time) && extra[next].at < Math.floor(time / 1000) * 1000) {
      merged.push(extra[next++].row);
    }
    merged.push(row);
  }
  while (next < extra.length) merged.push(extra[next++].row);
  return merged;
}

function isStep(row: ConversationRow): row is StepRow {
  if (row.kind === "tool") return true;
  if (row.kind !== "event") return false;
  const { event } = row;
  if (event.kind === "thinking") return true;
  return event.kind === "prompt" && (event.origin === "task_notification" || event.origin === "scheduled");
}

/** Steps in a row become one line. The group keeps its first step's id, so it stays open as it grows. */
export function foldSteps(rows: readonly ConversationRow[]): ConversationRow[] {
  const folded: ConversationRow[] = [];
  let group: StepRow[] | null = null;
  for (const row of rows) {
    if (isStep(row)) {
      if (!group) {
        group = [];
        folded.push({ kind: "steps", id: `steps:${row.id}`, rows: group });
      }
      group.push(row);
    } else {
      group = null;
      folded.push(row);
    }
  }
  return folded;
}

/** Filter and search see single steps: folded, a match would stay hidden in its group. */
export function filterConversation(rows: readonly ConversationRow[], filter: ActivityFilter, search: string): ConversationRow[] {
  const needle = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (needle && !conversationText(row).toLowerCase().includes(needle)) return false;
    if (filter === "all") return true;
    switch (row.kind) {
      case "comment":
      case "handoff":
        return filter === "messages";
      case "delegate":
        return filter === "tools" || (filter === "errors" && row.state === "failed");
      case "stage":
        return filter === "errors" && row.stage.level === "error";
      case "waiting":
        return filter === "messages";
      case "failure":
        return filter === "errors";
      case "tool":
      case "event":
      case "session":
        return rowMatches(row, filter);
      default:
        return false;
    }
  });
}

function conversationText(row: ConversationRow): string {
  switch (row.kind) {
    case "comment":
      return row.comment.body;
    case "handoff":
      return row.event.text;
    case "stage":
      return row.stage.text;
    case "delegate":
      return `${row.delegation?.agent_type ?? row.row.use.delegate?.agent_type ?? ""} ${row.row.use.summary} ${row.row.result?.text ?? ""}`;
    case "steps":
      return "";
    case "waiting":
      return row.text ?? "";
    case "failure":
      return row.detail;
    default:
      return rowText(row);
  }
}

/**
 * What the composer offers, by the state of the card (one row of the table in docs/internals/activity.md).
 * null: nothing to write here. A task out of work sends its status as the phase.
 */
export type ComposerMode =
  | "not_started"
  | "working"
  | "waiting_reply"
  /** An open request: its form takes the composer's place. */
  | "request"
  | "quota"
  /** Asleep until a wakeup: a message wakes it now. */
  | "sleeping"
  | "failed"
  | "done"
  /** Verifying or merging: the work is out of the agent's hands. */
  | "finishing"
  /** Nothing to send, only a note: an archived card, a session that stopped a moment ago. */
  | "note"
  | "chat";

export function composerMode(kind: ActivitySource["kind"], now: Pick<ActivityNow, "phase" | "live"> | null, archived = false): ComposerMode | null {
  if (!now) return null;
  // Text sent to a chat past its question would not reach it: a chat turn sits on its dialog the same way.
  if (kind === "chat") return now.live && now.phase !== "stopped" && now.phase !== "waiting_input" ? "chat" : null;
  if (archived) return "note";
  switch (now.phase) {
    case "waiting_input":
      return "request";
    case "waiting_reply":
      return "waiting_reply";
    case "quota":
      return "quota";
    case "sleeping":
      return "sleeping";
    case "starting":
    case "working":
    case "background":
    case "idle":
    case "delivering":
    case "in_progress":
      return "working";
    case "backlog":
    case "todo":
      return "not_started";
    case "failed":
      return "failed";
    case "done":
      return "done";
    case "verifying":
    case "merging":
      return "finishing";
    default:
      return "note";
  }
}

/**
 * The card's own idea of the session state, for the moment before the feed answers: the composer must not
 * wait for a poll, and must still work when the feed cannot be read.
 */
export function nowFromTask(task: TaskDetail): ActivityNow {
  const working = task.status === "in_progress";
  const phase: ActivityNow["phase"] = !working
    ? task.status
    : task.input_request
      ? "waiting_input"
      : task.blocker === "needs_input"
        ? "waiting_reply"
        : task.blocker === "quota"
          ? "quota"
          : task.blocker === "sleeping" && !task.outbox_state
            ? "sleeping"
            : task.outbox_state === "stopping"
            ? "delivering"
            : "working";
  return {
    phase, live: working, status: task.status, has_session: Boolean(task.session_id), agent_id: task.agent_id ?? null,
    waiting_detail: phase === "waiting_reply" ? task.blocker_detail : task.input_request?.summary ?? null,
    failed_detail: task.status === "failed" ? task.blocker_detail : null, detail_code: task.detail_code ?? null,
    detail: "", current_tool: null, tempo: null, silent_sec: null, in_flight: 0, processes: [], todos: [],
    input_request: task.input_request ?? null, blocker: task.blocker, blocker_detail: task.blocker_detail, outbox_state: task.outbox_state,
  };
}

/** What stage of its plan the agent is at: the item in progress, otherwise the next one to do. */
export function planStep(now: ActivityNow | null): { label: string; index: number; total: number } | null {
  const todos = now?.todos ?? [];
  if (todos.length === 0) return null;
  const at = todos.findIndex((x) => x.status === "in_progress");
  const index = at >= 0 ? at : todos.findIndex((x) => x.status === "pending");
  return index < 0 ? null : { label: todos[index].label, index: index + 1, total: todos.length };
}

/** A background-task notification is XML for the model: the owner needs its one-line summary. */
export function notificationSummary(text: string): string {
  return /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1].trim() ?? text;
}

/** The one line about what the agent is busy with: its command if one is running, otherwise the daemon's words. */
export function doingNow(now: ActivityNow | null | undefined): string {
  if (!now?.live) return "";
  const tool = now.current_tool;
  return tool ? `${tool.name}: ${tool.summary}`.replace(/: $/, "") : now.detail;
}

/** How often to ask: nearly live while a session works, rarely once it does not (a rework may revive it). */
const LIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 8000;

/**
 * An append-only feed by polling with a cursor. Not usePolling: that one replaces its data with every
 * answer, and here each answer is a piece to add.
 *
 * Polling rather than a socket, like the rest of the dashboard: a transcript grows message by message,
 * so a push would win under a second, and open streams hold up a server restart. While the tab is
 * hidden nothing is asked. Requests never overlap: the next one is scheduled after the previous answer.
 */
export function useActivityFeed(source: ActivitySource) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [now, setNow] = useState<ActivityNow | null>(null);
  const [extras, setExtras] = useState<ConversationExtras | null>(null);
  const [earlier, setEarlier] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const cursor = useRef<string | null>(null);
  const seen = useRef(new Set<string>());
  const live = useRef(false);
  const nowJson = useRef("");
  const extrasJson = useRef("");
  const pokeRef = useRef<() => void>(() => {});

  const fresh = useCallback((incoming: ActivityEvent[]) => {
    // A session copy repeats the history of the original with the same ids.
    const added = incoming.filter((e) => !seen.current.has(e.id));
    added.forEach((e) => seen.current.add(e.id));
    return added;
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (!alive || document.visibilityState === "hidden") return;
      timer = setTimeout(() => void poll(), live.current ? LIVE_POLL_MS : IDLE_POLL_MS);
    };

    const poll = async () => {
      if (inFlight || !alive) return;
      inFlight = true;
      try {
        const first = cursor.current === null;
        const page = await fetchPage(source, cursor.current ? { cursor: cursor.current } : {});
        if (!alive) return;
        const added = fresh(page.events);
        if (added.length > 0) setEvents((prev) => [...prev, ...added]);
        // A forward read says nothing about what lies behind the tail: the first answer has decided that.
        if (first && page.cursor !== null) setEarlier(page.earlier);
        cursor.current = page.cursor;
        live.current = page.now.live;
        const json = JSON.stringify(page.now);
        if (json !== nowJson.current) {
          nowJson.current = json;
          setNow(page.now);
        }
        const nextExtras: ConversationExtras = {
          comments: page.comments ?? null,
          stages: page.stages ?? [],
          delegations: page.delegations ?? [],
        };
        const extrasText = JSON.stringify(nextExtras);
        if (extrasText !== extrasJson.current) {
          extrasJson.current = extrasText;
          setExtras(nextExtras);
        }
        setError((prev) => (prev === null ? prev : null));
        setLoaded(true);
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setLoaded(true);
        }
      } finally {
        inFlight = false;
        schedule();
      }
    };

    pokeRef.current = () => void poll();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      } else {
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // One feed per instance: the caller keys the component by its source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind, source.id, source.agent, fresh]);

  const loadEarlier = useCallback(async () => {
    if (!earlier) return;
    setLoadingEarlier(true);
    try {
      const page = await fetchPage(source, { before: earlier });
      const added = fresh(page.events);
      if (added.length > 0) setEvents((prev) => [...added, ...prev]);
      setEarlier(page.earlier);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingEarlier(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earlier, source.kind, source.id, source.agent, fresh]);

  /** Ask right now, after a command: the answer should not wait for the next tick. */
  const refresh = useCallback(() => pokeRef.current(), []);

  return { events, now, extras, earlier, error, loaded, loadingEarlier, loadEarlier, refresh };
}
