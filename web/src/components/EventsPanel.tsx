import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, CheckCheck, Maximize2 } from "lucide-react";
import { api } from "../api";
import { usePolling } from "../hooks/usePolling";
import type { OrcEvent } from "../types";
import { LEVEL_META, eventTime, feedProjects, groupByDay } from "../events";
import { EventsDialog } from "./EventsDialog";
import { ProjectTag } from "./ProjectTag";
import { SidebarRow } from "./SidebarRow";
import { Button, IconButton } from "../ui/Button";
import { Popover, Tip } from "../ui/Overlays";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";

interface Props {
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Clicking a task event opens its card. */
  onOpenTask?: (taskId: number) => void;
  /** Collapsed sidebar rail: instead of a labelled row, a single bell with a tooltip. */
  collapsed?: boolean;
}

/**
 * Event feed: a bell with a counter and a slide-out panel.
 *
 * Lives at the bottom of the left column, not in the board header: events come from all projects at
 * once, and the place next to the board filters did not suit them. The panel opens to the right and
 * is equally available in the expanded column and in the collapsed rail.
 *
 * The main question the feed must answer at a glance is "what is new since last time". So unread
 * ones are separated by a "New" strip and marked with a dot, while read ones are muted. The set of
 * "new" is frozen at the moment of opening: the panel marks events as read automatically, but the
 * divider does not vanish from under the cursor, otherwise one could not finish reading.
 *
 * The narrow panel does not let one dig into events and should not: for that there is "All events",
 * a full-screen dialog with filters (see EventsDialog).
 */
export function EventsPanel({ open, onToggle, onOpenTask, collapsed }: Props) {
  const { t, language } = useTranslation();
  const events = usePolling(() => api.events(), 5000);
  const [error, setError] = useState<string | null>(null);
  const [frozenNew, setFrozenNew] = useState<Set<number>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  // Stable reference: otherwise the grouping below would be recomputed on every render.
  const list = useMemo(() => events.data ?? [], [events.data]);
  const unread = list.filter((e) => !e.is_read).length;

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) orc` : "orc";
  }, [unread]);

  // A separate function instead of inline: markEventsRead can fail (network, 5xx) on its own, and
  // that must not fly away as an unhandled promise, the same discipline as in App.tsx.
  async function markRead() {
    setError(null);
    try {
      await api.markEventsRead();
      await events.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // When the panel or the large dialog is opened, we remember what the person has not seen yet, and
  // after a pause clear the counter. The pause is needed so that the "read" mark does not fire on
  // an accidental open-close.
  const openedRef = useRef(false);
  const shown = open || dialogOpen;
  useEffect(() => {
    if (!shown) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    setFrozenNew(new Set(list.filter((e) => !e.is_read).map((e) => e.id)));
    const id = setTimeout(() => void markRead(), 1200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const groups = useMemo(() => groupByDay(t, list, language), [list, t, language]);

  // useCallback: isNew goes to EventsDialog as a dependency of its useMemo; a new function on every
  // render would recompute the whole selection there for nothing.
  const isNew = useCallback((e: OrcEvent) => frozenNew.has(e.id) || !e.is_read, [frozenNew]);
  const newCount = list.filter(isNew).length;

  // We show the project label only when the feed really has several projects: with one project it
  // would be pure noise in every row.
  const multiProject = useMemo(() => feedProjects(list, language).length > 1, [list, language]);

  const openTask = (taskId: number) => {
    onToggle(false);
    onOpenTask?.(taskId);
  };

  // The unread counter is drawn the same in both column views: a ring in the sidebar background
  // colour so that the digit does not merge with the icon.
  const badge = unread > 0 && (
    <span className="tnum pointer-events-none absolute -right-1 -top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-[var(--st-blocked)] px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-[var(--surface)]">
      {unread > 99 ? "99+" : unread}
    </span>
  );
  const label = unread > 0 ? t("eventsPanel.labelWithUnread", { count: unread }) : t("eventsPanel.label");

  const railTrigger = (
    <span className="relative mx-auto flex w-7">
      <Tip side="right" text={label}>
        <IconButton icon={Bell} label={label} size="sm" />
      </Tip>
      {badge}
    </span>
  );

  const rowTrigger = (
    <SidebarRow
      icon={Bell}
      aria-label={label}
      active={open}
      trailing={
        unread > 0 && (
          <span className="tnum flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[var(--st-blocked)] px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )
      }
    >
      {t("eventsPanel.label")}
    </SidebarRow>
  );

  return (
    <>
      <Popover
        open={open}
        onOpenChange={onToggle}
        side="right"
        align="end"
        title={<span>{t("eventsPanel.title")}{newCount > 0 ? <span className="ml-1.5 text-[var(--ink-faint)]">{t("eventsPanel.newCount", { count: newCount })}</span> : null}</span>}
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={CheckCheck}
            disabled={unread === 0}
            onClick={() => void markRead()}
          >
            {t("eventsPanel.markRead")}
          </Button>
        }
        trigger={collapsed ? railTrigger : rowTrigger}
      >
        {error && (
          <p className="border-b border-[var(--line)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
            {error}
          </p>
        )}

        {list.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] leading-relaxed text-[var(--ink-faint)]">
            {t("eventsPanel.emptyLine1")}
            <br />
            {t("eventsPanel.emptyLine2")}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.day}>
              <p className="sticky top-0 z-10 bg-[color-mix(in_oklab,var(--surface)_92%,transparent)] px-3 py-1 text-[11px] font-medium text-[var(--ink-faint)] backdrop-blur">
                {g.day}
              </p>
              <ul>
                {g.items.map((e) => {
                  const level = LEVEL_META[e.level];
                  const Icon = level.icon;
                  const fresh = isNew(e);
                  const clickable = e.task_id !== null && onOpenTask;
                  // The second line answers "and what is this about at all": where and which task.
                  // We build it only when there is something to say, otherwise the row stays
                  // single-line.
                  const meta = multiProject || e.task_title !== null;
                  return (
                    <li key={e.id}>
                      <div
                        role={clickable ? "button" : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        onClick={clickable ? () => openTask(e.task_id as number) : undefined}
                        onKeyDown={
                          clickable
                            ? (ev) => {
                                if (ev.key === "Enter" || ev.key === " ") {
                                  ev.preventDefault();
                                  openTask(e.task_id as number);
                                }
                              }
                            : undefined
                        }
                        className={cn(
                          "relative flex gap-2 px-3 py-1.5 text-[12px] leading-snug transition-colors",
                          clickable && "cursor-pointer hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]",
                          !fresh && "text-[var(--ink-muted)]",
                        )}
                      >
                        {/* A bar at the left edge is the only "this is new" mark */}
                        {fresh && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-[var(--st-blocked)]" />}
                        <Icon size={13} className={cn("mt-0.5 shrink-0", level.fg)} aria-hidden />
                        {/* break-words: messages contain worktree paths without spaces;
                           without wrapping they slid under the timestamp and past the panel
                           edge. */}
                        <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                          <span className={cn(fresh && "text-[var(--ink)]")}>{e.message}</span>
                          {meta && (
                            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--ink-faint)]">
                              {multiProject && <ProjectTag name={e.project_name} />}
                              {e.task_title && <span className="min-w-0 truncate">{e.task_title}</span>}
                            </span>
                          )}
                        </span>
                        <span className="tnum shrink-0 font-mono text-[10px] text-[var(--ink-faint)]">{eventTime(e.created_at, language)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}

        {list.length > 0 && (
          <div className="sticky bottom-0 border-t border-[var(--line)] bg-[var(--surface)] p-1.5">
            <Button
              size="sm"
              variant="ghost"
              icon={Maximize2}
              className="w-full justify-center"
              onClick={() => {
                onToggle(false);
                setDialogOpen(true);
              }}
            >
              {t("eventsPanel.allEventsButton")}
            </Button>
          </div>
        )}
      </Popover>

      <EventsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        events={list}
        isNew={isNew}
        unread={unread}
        onMarkRead={() => void markRead()}
        onOpenTask={onOpenTask}
        error={error}
      />
    </>
  );
}
