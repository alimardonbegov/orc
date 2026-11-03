import { AlertTriangle, CheckCircle2, Info, OctagonAlert, type LucideIcon } from "lucide-react";
import type { EventLevel, OrcEvent } from "./types";
import type { TFunction } from "./i18n";

/**
 * Event feed vocabulary: the level color and icon — one for the dropdown panel and for the big
 * window. The label depends on the language and is taken separately via levelLabel(t, level).
 * An event level is not a task status, so it takes no variables from the status wheel
 * and works on the traffic-light --ok/--warn/--danger.
 */
export const LEVEL_META: Record<EventLevel, { icon: LucideIcon; fg: string; chip: string }> = {
  info: {
    icon: Info,
    fg: "text-[var(--ink-faint)]",
    chip: "bg-[var(--sunken)] text-[var(--ink-muted)]",
  },
  success: {
    icon: CheckCircle2,
    fg: "text-[var(--ok)]",
    chip: "bg-[color-mix(in_oklab,var(--ok)_16%,transparent)] text-[var(--ok)]",
  },
  warn: {
    icon: AlertTriangle,
    fg: "text-[var(--warn)]",
    chip: "bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]",
  },
  error: {
    icon: OctagonAlert,
    fg: "text-[var(--danger)]",
    chip: "bg-[color-mix(in_oklab,var(--danger)_16%,transparent)] text-[var(--danger)]",
  },
};

export function levelLabel(t: TFunction, level: EventLevel): string {
  return t(`events.level.${level}`);
}

/** Order of level filters: from what calls for a human to background noise. */
export const LEVEL_ORDER: EventLevel[] = ["error", "warn", "success", "info"];

export const eventTime = (iso: string, locale: string) =>
  new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

/** "Today" / "Yesterday" / "March 3" — a group heading. */
export function dayLabel(t: TFunction, iso: string, locale: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff <= 0) return t("events.today");
  if (diff === 1) return t("events.yesterday");
  return d.toLocaleDateString(locale, { day: "numeric", month: "long" });
}

export interface EventDay {
  day: string;
  items: OrcEvent[];
}

/**
 * Newest first, then by day. The sort is our own, not "as it came": the order from
 * the server is by id, and it does not always match the time (records could land
 * retroactively), and then the "Today" heading appeared in the list twice.
 */
export function groupByDay(t: TFunction, list: OrcEvent[], locale: string): EventDay[] {
  const sorted = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const out: EventDay[] = [];
  for (const e of sorted) {
    const day = dayLabel(t, e.created_at, locale);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(e);
    else out.push({ day, items: [e] });
  }
  return out;
}

/** Project key for the filter: dispatcher events have no project, they form a separate group. */
export const NO_PROJECT = "none";
export type ProjectFilter = number | typeof NO_PROJECT;

export interface FeedProject {
  key: ProjectFilter;
  name: string;
  count: number;
}

/**
 * Projects that actually occur in the feed, with the event count. Exactly these, not
 * the whole project list: the filter must not offer options that give an empty screen.
 */
export function feedProjects(list: OrcEvent[], locale: string): FeedProject[] {
  const map = new Map<ProjectFilter, FeedProject>();
  for (const e of list) {
    const key: ProjectFilter = e.project_id ?? NO_PROJECT;
    const name = e.project_name ?? "orc";
    const cur = map.get(key);
    if (cur) cur.count += 1;
    else map.set(key, { key, name, count: 1 });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, locale));
}

/** Event count by level — labels on the filter buttons. */
export function levelCounts(list: OrcEvent[]): Record<EventLevel, number> {
  const out: Record<EventLevel, number> = { info: 0, success: 0, warn: 0, error: 0 };
  for (const e of list) out[e.level] += 1;
  return out;
}

export interface EventFilters {
  /** null — all projects. */
  project: ProjectFilter | null;
  /** null — all levels. */
  level: EventLevel | null;
  /** Only those the person has not seen yet. */
  unreadOnly: boolean;
  /** Search by event text and task title; an empty string — no search. */
  query: string;
}

export const EMPTY_FILTERS: EventFilters = { project: null, level: null, unreadOnly: false, query: "" };

export function hasActiveFilters(f: EventFilters): boolean {
  return f.project !== null || f.level !== null || f.unreadOnly || f.query.trim() !== "";
}

/**
 * Selecting feed rows. `isNew` comes from outside rather than being read from is_read: the panel
 * marks events as read automatically, and the "only new" filter must
 * hold on to the same frozen set, otherwise the list empties under the cursor.
 */
export function filterEvents(list: OrcEvent[], f: EventFilters, isNew: (e: OrcEvent) => boolean): OrcEvent[] {
  const q = f.query.trim().toLowerCase();
  return list.filter((e) => {
    if (f.project !== null && (e.project_id ?? NO_PROJECT) !== f.project) return false;
    if (f.level !== null && e.level !== f.level) return false;
    if (f.unreadOnly && !isNew(e)) return false;
    if (q) {
      const haystack = `${e.message} ${e.task_title ?? ""} ${e.task_id !== null ? `#${e.task_id}` : ""}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}
