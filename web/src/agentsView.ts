import type { Agent } from "./types";

/**
 * How the Agents page shows its cards: the person's own order, sorting, filters and grouping.
 *
 * It is a per-browser preference, so it lives in localStorage. Storage can be unavailable (private
 * mode, blocked data), so every access is guarded and a failure just means "default view".
 */
export type AgentSort = "manual" | "name" | "newest" | "oldest" | "tasks";
export type AgentGroup = "none" | "scope" | "model";
export type AgentStatusFilter = "all" | "working" | "idle";

export interface AgentView {
  sort: AgentSort;
  group: AgentGroup;
  status: AgentStatusFilter;
  /** "all", "shared" (no project) or a project id as a string. */
  scope: string;
  query: string;
}

export const DEFAULT_VIEW: AgentView = { sort: "manual", group: "none", status: "all", scope: "all", query: "" };

const VIEW_KEY = "orc.agents.view";
const ORDER_KEY = "orc.agents.order";

const SORTS: AgentSort[] = ["manual", "name", "newest", "oldest", "tasks"];
const GROUPS: AgentGroup[] = ["none", "scope", "model"];
const STATUSES: AgentStatusFilter[] = ["all", "working", "idle"];

export function readView(): AgentView {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as Partial<AgentView> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_VIEW;
    return {
      sort: SORTS.includes(raw.sort as AgentSort) ? (raw.sort as AgentSort) : DEFAULT_VIEW.sort,
      group: GROUPS.includes(raw.group as AgentGroup) ? (raw.group as AgentGroup) : DEFAULT_VIEW.group,
      status: STATUSES.includes(raw.status as AgentStatusFilter) ? (raw.status as AgentStatusFilter) : DEFAULT_VIEW.status,
      scope: typeof raw.scope === "string" ? raw.scope : DEFAULT_VIEW.scope,
      query: typeof raw.query === "string" ? raw.query : "",
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function writeView(view: AgentView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // The preference is not worth failing the page over.
  }
}

export function readOrder(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export function writeOrder(order: readonly number[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // See writeView.
  }
}

/** True when anything narrows the list, so "nothing found" differs from "no agents". */
export function isFiltered(view: AgentView): boolean {
  return view.status !== "all" || view.scope !== "all" || view.query.trim() !== "";
}

/**
 * Agents in the saved order. Unknown ids of the saved order are dropped; agents created since
 * go to the end in their natural order.
 */
export function applyOrder(agents: readonly Agent[], order: readonly number[]): Agent[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const seen = new Set<number>();
  const out: Agent[] = [];
  for (const id of order) {
    const a = byId.get(id);
    if (a && !seen.has(id)) {
      out.push(a);
      seen.add(id);
    }
  }
  for (const a of agents) if (!seen.has(a.id)) out.push(a);
  return out;
}

/**
 * Moves `activeId` to the place of `overId` in the full order. The visible list may be filtered,
 * so the move is made in the full list, which keeps the hidden agents where they were.
 */
export function moveInOrder(order: readonly number[], activeId: number, overId: number): number[] {
  const from = order.indexOf(activeId);
  const to = order.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

export function filterAgents(agents: readonly Agent[], view: AgentView, liveIds: ReadonlySet<number>): Agent[] {
  const q = view.query.trim().toLowerCase();
  return agents.filter((a) => {
    if (view.status === "working" && !liveIds.has(a.id)) return false;
    if (view.status === "idle" && liveIds.has(a.id)) return false;
    if (view.scope === "shared" && a.project_id !== null) return false;
    if (view.scope !== "all" && view.scope !== "shared" && String(a.project_id) !== view.scope) return false;
    if (q && !`${a.name} ${a.description ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Sorts a copy. "manual" keeps the given order. */
export function sortAgents(agents: readonly Agent[], sort: AgentSort): Agent[] {
  const list = [...agents];
  switch (sort) {
    case "name":
      return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    case "newest":
      return list.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
    case "oldest":
      return list.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
    case "tasks":
      return list.sort((a, b) => b.tasks.active - a.tasks.active || b.tasks.total - a.tasks.total);
    default:
      return list;
  }
}

export interface AgentSection {
  key: string;
  /** Project name for "scope"; null means the shared bucket, or the model's id for "model". */
  label: string | null;
  agents: Agent[];
}

/** Splits the (already sorted) list into sections; order inside a section is kept. */
export function groupAgents(
  agents: readonly Agent[],
  group: AgentGroup,
  projectName: (id: number) => string,
): AgentSection[] {
  if (group === "none") return [{ key: "all", label: null, agents: [...agents] }];
  const sections = new Map<string, AgentSection>();
  for (const a of agents) {
    const key = group === "scope" ? (a.project_id === null ? "shared" : `p${a.project_id}`) : a.model ?? "inherit";
    const label = group === "scope" ? (a.project_id === null ? null : projectName(a.project_id)) : a.model;
    const s = sections.get(key) ?? { key, label, agents: [] };
    s.agents.push(a);
    sections.set(key, s);
  }
  const result = [...sections.values()];
  // Model groups: strongest family first (fable, opus, sonnet, haiku), newer versions first, unknown last.
  if (group === "model") result.sort((a, b) => compareModels(a.label, b.label));
  return result;
}

const FAMILY_RANK = ["fable", "opus", "sonnet", "haiku"];

function modelRank(id: string | null | undefined): [number, number[]] {
  const m = /^claude-([a-z]+)-([\d-]+)/.exec(id ?? "");
  if (!m) return [FAMILY_RANK.length, []];
  const family = FAMILY_RANK.indexOf(m[1]);
  const version = m[2].split("-").filter((x) => x.length < 8).map(Number);
  return [family < 0 ? FAMILY_RANK.length : family, version];
}

function compareModels(a: string | null | undefined, b: string | null | undefined): number {
  const [fa, va] = modelRank(a);
  const [fb, vb] = modelRank(b);
  if (fa !== fb) return fa - fb;
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
