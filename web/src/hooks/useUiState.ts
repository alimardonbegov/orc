import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_DONE_SORT, isDoneSort, type DoneSort } from "../sort";
import {
  DEFAULT_BREAKDOWN,
  DEFAULT_METRIC,
  DEFAULT_PERIOD,
  isBreakdownDim,
  isFlowMetric,
  isKnownPeriod,
  type BreakdownDim,
  type FlowMetric,
} from "../analytics";
import type { AnalyticsSplit } from "../types";

/** Stacks the screen offers. The server also computes by status, but the dashboard does not draw it. */
const SPLITS: AnalyticsSplit[] = ["by_model", "by_project"];
export const DEFAULT_SPLIT: AnalyticsSplit = "by_model";

export type Theme = "system" | "light" | "dark";

/** What the main area shows: the task board, a summary of them, or recurring tasks. */
export type View = "board" | "dashboard" | "routines";

/** Everything the interface must remember between browser restarts. */
export interface UiState {
  /** Selected project. null — never selected yet, take the first from the list. */
  projectId: number | null;
  /** Open task card: after F5 the modal must open again. */
  openTaskId: number | null;
  sidebarCollapsed: boolean;
  theme: Theme;
  /** Board filter "only those needing attention". */
  attentionOnly: boolean;
  /** Whether to show the "Done" column: in long work it gets in the way more often. */
  showDone: boolean;
  /** The board shows the archive instead of live tasks: a separate view, not a blend. */
  showArchived: boolean;
  /** Card order in the "Done" column (see sort.ts). */
  doneSort: DoneSort;
  /** Board or dashboard. The view is remembered: checking the summary every morning is a common scenario. */
  view: View;
  /** The dashboard counts across all projects, not only the one selected in the sidebar. */
  dashAllProjects: boolean;
  /** Dashboard period in days; 0 — all time (see PERIODS in analytics.ts). */
  dashDays: number;
  /** Timeline chart measure: money, tokens or tasks. */
  dashMetric: FlowMetric;
  /** What to color the timeline chart stacks by: model or project. */
  dashSplit: AnalyticsSplit;
  /** Breakdown table attribute: model, project, effort or access mode. */
  dashBreakdown: BreakdownDim;
  /** The chat window floating over the app is open. */
  chatOpen: boolean;
  /** The chat window is stretched wide, with the list of chats beside the conversation. */
  chatExpanded: boolean;
}

export const DEFAULT_UI: UiState = {
  projectId: null,
  openTaskId: null,
  sidebarCollapsed: false,
  theme: "system",
  attentionOnly: false,
  showDone: true,
  showArchived: false,
  doneSort: DEFAULT_DONE_SORT,
  view: "board",
  dashAllProjects: false,
  dashDays: DEFAULT_PERIOD,
  dashMetric: DEFAULT_METRIC,
  dashSplit: DEFAULT_SPLIT,
  dashBreakdown: DEFAULT_BREAKDOWN,
  chatOpen: false,
  chatExpanded: false,
};

// Version in the key: if the set of fields changes incompatibly, the old value is simply not picked up.
const KEY = "orc.ui.v1";

function readStore(): Partial<UiState> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Partial<UiState>) : {};
  } catch {
    // Private mode, storage denied, broken JSON — the interface must open even without memory.
    return {};
  }
}

function writeStore(state: UiState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Out of space or storage denied — silently work without saving.
  }
}

const num = (v: string | null): number | null => {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The page address is the second carrier of the same state: `#p=3&t=12`.
 * It is needed so that a link to a task opens right on it for the person and so that
 * the browser's "back" returns to the previous task instead of kicking out of the app.
 */
function readHash(): { projectId?: number | null; openTaskId?: number | null } {
  if (typeof location === "undefined" || !location.hash) return {};
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  const out: { projectId?: number | null; openTaskId?: number | null } = {};
  if (p.has("p")) out.projectId = num(p.get("p"));
  if (p.has("t")) out.openTaskId = num(p.get("t"));
  return out;
}

function hashFor(state: UiState): string {
  const p = new URLSearchParams();
  if (state.projectId !== null) p.set("p", String(state.projectId));
  if (state.openTaskId !== null) p.set("t", String(state.openTaskId));
  const q = p.toString();
  return q ? `#${q}` : "";
}

function sanitize(raw: Partial<UiState>): UiState {
  const themes: Theme[] = ["system", "light", "dark"];
  return {
    projectId: typeof raw.projectId === "number" && Number.isInteger(raw.projectId) ? raw.projectId : null,
    openTaskId: typeof raw.openTaskId === "number" && Number.isInteger(raw.openTaskId) ? raw.openTaskId : null,
    sidebarCollapsed: raw.sidebarCollapsed === true,
    theme: themes.includes(raw.theme as Theme) ? (raw.theme as Theme) : "system",
    attentionOnly: raw.attentionOnly === true,
    showDone: raw.showDone !== false,
    showArchived: raw.showArchived === true,
    doneSort: isDoneSort(raw.doneSort) ? raw.doneSort : DEFAULT_DONE_SORT,
    view: raw.view === "dashboard" || raw.view === "routines" ? raw.view : "board",
    dashAllProjects: raw.dashAllProjects === true,
    // A period from storage may be left over from a version with a different list: an unknown one is replaced
    // with the default, otherwise the server answers 400 on every dashboard poll.
    dashDays: typeof raw.dashDays === "number" && isKnownPeriod(raw.dashDays) ? raw.dashDays : DEFAULT_PERIOD,
    dashMetric: isFlowMetric(raw.dashMetric) ? raw.dashMetric : DEFAULT_METRIC,
    // The "by status" breakdown from the previous version of the screen is replaced with the default, like any garbage
    dashSplit: SPLITS.includes(raw.dashSplit as AnalyticsSplit) ? (raw.dashSplit as AnalyticsSplit) : DEFAULT_SPLIT,
    dashBreakdown: isBreakdownDim(raw.dashBreakdown) ? raw.dashBreakdown : DEFAULT_BREAKDOWN,
    chatOpen: raw.chatOpen === true,
    chatExpanded: raw.chatExpanded === true,
  };
}

/** Initial state: storage first, over it — what came in the address. */
export function initialUiState(): UiState {
  return sanitize({ ...readStore(), ...readHash() });
}

/**
 * UI state that survives a page reload.
 *
 * Previously the selected project and the open task lived in useState — after F5 the
 * first project in the list always opened, and the task modal closed. Now both
 * values are written to localStorage and to the page address and restored on
 * the next start.
 */
export function useUiState() {
  const [state, setState] = useState<UiState>(initialUiState);

  const patch = useCallback((fields: Partial<UiState>) => {
    setState((prev) => {
      const next = { ...prev, ...fields };
      // Nothing changed — we touch neither storage nor browser history.
      if ((Object.keys(fields) as (keyof UiState)[]).every((k) => prev[k] === next[k])) return prev;
      writeStore(next);
      return next;
    });
  }, []);

  // We update the page address via replaceState: every click on a project must not
  // add a history entry, otherwise "back" turns into rewinding clicks.
  // The exception is opening and closing a task: there "back" closing the modal is expected.
  const prevTask = useRef(state.openTaskId);
  useEffect(() => {
    const hash = hashFor(state);
    const url = `${location.pathname}${location.search}${hash}`;
    if (url === `${location.pathname}${location.search}${location.hash}`) {
      prevTask.current = state.openTaskId;
      return;
    }
    if (prevTask.current !== state.openTaskId) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    prevTask.current = state.openTaskId;
  }, [state]);

  // The "back"/"forward" buttons change the address behind React's back — we pick them up.
  useEffect(() => {
    const onPop = () => {
      const fromHash = readHash();
      setState((prev) => {
        const next = { ...prev, projectId: fromHash.projectId ?? null, openTaskId: fromHash.openTaskId ?? null };
        if (next.projectId === prev.projectId && next.openTaskId === prev.openTaskId) return prev;
        writeStore(next);
        return next;
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Theme: an attribute on <html> so that CSS variables switch as a whole (see index.css).
  useEffect(() => {
    const root = document.documentElement;
    if (state.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", state.theme);
  }, [state.theme]);

  return { ui: state, setUi: patch };
}
