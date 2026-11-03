import { useMemo, useState } from "react";
import { CheckCheck, FilterX, Search, X } from "lucide-react";
import type { EventLevel, OrcEvent } from "../types";
import {
  EMPTY_FILTERS,
  LEVEL_META,
  LEVEL_ORDER,
  eventTime,
  feedProjects,
  filterEvents,
  groupByDay,
  hasActiveFilters,
  levelCounts,
  levelLabel,
  NO_PROJECT,
  type EventFilters,
} from "../events";
import { statusLabel } from "../labels";
import { STATUS_META } from "../status";
import { ProjectTag } from "./ProjectTag";
import { Badge } from "../ui/Badge";
import { Button, IconButton } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { fieldBase, focusRing } from "../ui/tokens";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: OrcEvent[];
  /** Frozen "not seen" set: the panel clears the counter itself, while the mark must remain. */
  isNew: (e: OrcEvent) => boolean;
  unread: number;
  onMarkRead: () => void;
  onOpenTask?: (taskId: number) => void;
  error?: string | null;
}

/** Filter button: the pressed state is shown by fill, the number is how many rows stand behind it. */
function Chip({
  active,
  onClick,
  children,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
  tone?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border px-2 text-[12px] font-medium transition-colors duration-100",
        focusRing,
        active
          ? cn("border-transparent bg-[color-mix(in_oklab,var(--ink)_12%,transparent)] text-[var(--ink)]", tone)
          : "border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]",
      )}
    >
      {children}
      {count !== undefined && <span className="tnum text-[var(--ink-faint)]">{count}</span>}
    </button>
  );
}

/**
 * All events full screen.
 *
 * The dropdown panel answers the question "what is new" and for that is squeezed to a line of text.
 * That is not enough when there are several projects: from "#12 is waiting for an answer" you
 * cannot tell where it is or which task it is about. Here every row has room for a project label,
 * the number and title of the task with its status, and on top there are filters by project, level
 * and search, to pull the needed slice out of a mixed feed.
 *
 * Filters live only while the dialog is open: a filter saved between launches would look like "half
 * of the events vanished", the same logic as board search.
 */
export function EventsDialog({ open, onOpenChange, events, isNew, unread, onMarkRead, onOpenTask, error }: Props) {
  const { t, language } = useTranslation();
  const [filters, setFilters] = useState<EventFilters>(EMPTY_FILTERS);
  const set = (patch: Partial<EventFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const shown = useMemo(() => filterEvents(events, filters, isNew), [events, filters, isNew]);

  // Button counters are computed over the slice WITHOUT the axis the button belongs to: for
  // projects the project filter is lifted, for levels the level filter. Otherwise next to "Errors
  // 4" there would be two lines: a number from the whole feed against the filtered list under it.
  // The button set itself is taken from the whole feed: a button that vanished under a filter would
  // take with it the way to remove that filter.
  const projectCounts = useMemo(
    () => new Map(feedProjects(filterEvents(events, { ...filters, project: null }, isNew), language).map((p) => [p.key, p.count])),
    [events, filters, isNew, language],
  );
  const levelFacet = useMemo(
    () => levelCounts(filterEvents(events, { ...filters, level: null }, isNew)),
    [events, filters, isNew],
  );
  const projects = useMemo(() => feedProjects(events, language), [events, language]);
  const levels = useMemo(() => levelCounts(events), [events]);
  // "New only" also counts over the current slice, but without itself.
  const newCount = useMemo(
    () => filterEvents(events, { ...filters, unreadOnly: false }, isNew).filter(isNew).length,
    [events, filters, isNew],
  );

  const groups = useMemo(() => groupByDay(t, shown, language), [shown, t, language]);
  const active = hasActiveFilters(filters);

  // One project: there is nothing for the project label to distinguish, it turns into noise in
  // every row.
  const multiProject = projects.length > 1;

  const openTask = (taskId: number) => {
    onOpenChange(false);
    onOpenTask?.(taskId);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      flush
      title={t("eventsPanel.title")}
      subtitle={
        <span className="tnum">
          {t("eventsDialog.subtitle", { shown: shown.length, total: events.length })}
          {newCount > 0 && <> · {t("eventsPanel.newCount", { count: newCount })}</>}
        </span>
      }
      actions={
        <Button size="sm" variant="ghost" icon={CheckCheck} disabled={unread === 0} onClick={onMarkRead}>
          {t("eventsPanel.markRead")}
        </Button>
      }
    >
      <div className="sticky top-0 z-20 space-y-2 border-b border-[var(--line)] bg-[var(--surface)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              size={13}
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-faint)]"
            />
            <input
              type="search"
              aria-label={t("eventsDialog.searchLabel")}
              placeholder={t("eventsDialog.searchPlaceholder")}
              value={filters.query}
              onChange={(e) => set({ query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape" && filters.query) {
                  // Escape in the field means "clear the query", not "close the dialog": while
                  // something is typed in the search, leaving the dialog would take away the result
                  // together with the filter.
                  e.preventDefault();
                  e.stopPropagation();
                  set({ query: "" });
                }
              }}
              className={cn(fieldBase, "h-8 pl-7 pr-7 [&::-webkit-search-cancel-button]:hidden")}
            />
            {filters.query && (
              <IconButton
                icon={X}
                label={t("topBar.clearSearch")}
                size="sm"
                className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2"
                onClick={() => set({ query: "" })}
              />
            )}
          </div>

          <Chip active={filters.unreadOnly} onClick={() => set({ unreadOnly: !filters.unreadOnly })} count={newCount}>
            {t("eventsDialog.unreadOnly")}
          </Chip>

          {active && (
            <Button size="sm" variant="ghost" icon={FilterX} onClick={() => setFilters(EMPTY_FILTERS)}>
              {t("eventsDialog.reset")}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {multiProject && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-[var(--ink-faint)]">{t("eventsDialog.projectLabel")}</span>
              <Chip active={filters.project === null} onClick={() => set({ project: null })}>
                {t("eventsDialog.all")}
              </Chip>
              {projects.map((p) => (
                <ProjectChip
                  key={String(p.key)}
                  name={p.key === NO_PROJECT ? null : p.name}
                  label={p.name}
                  count={projectCounts.get(p.key) ?? 0}
                  active={filters.project === p.key}
                  onClick={() => set({ project: filters.project === p.key ? null : p.key })}
                />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-[var(--ink-faint)]">{t("eventsDialog.levelLabel")}</span>
            <Chip active={filters.level === null} onClick={() => set({ level: null })}>
              {t("eventsDialog.all")}
            </Chip>
            {LEVEL_ORDER.filter((l) => levels[l] > 0).map((l) => (
              <LevelChip
                key={l}
                level={l}
                count={levelFacet[l]}
                active={filters.level === l}
                onClick={() => set({ level: filters.level === l ? null : l })}
              />
            ))}
          </div>
        </div>
      </div>

      {error && (
        <p className="border-b border-[var(--line)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-4 py-2 text-[12px] text-[var(--danger)]">
          {error}
        </p>
      )}

      {shown.length === 0 ? (
        <p className="px-4 py-16 text-center text-[13px] leading-relaxed text-[var(--ink-faint)]">
          {events.length === 0 ? (
            <>
              {t("eventsPanel.emptyLine1")}
              <br />
              {t("eventsPanel.emptyLine2")}
            </>
          ) : (
            <>{t("eventsDialog.noMatchesFilter")}</>
          )}
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.day}>
            {/* Not sticky, unlike the narrow panel: a filter panel of variable height is
               already stuck at the top, and a second "sticky" layer would have to be offset
               from it by an invented number of pixels. Here the day heading is just a divider. */}
            <p className="border-y border-[var(--line)] bg-[var(--sunken)] px-4 py-1 text-[11px] font-medium text-[var(--ink-faint)]">
              {g.day}
            </p>
            <ul>
              {g.items.map((e) => (
                <EventRow
                  key={e.id}
                  event={e}
                  fresh={isNew(e)}
                  showProject={multiProject}
                  onOpenTask={onOpenTask ? openTask : undefined}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </Modal>
  );
}

function ProjectChip({
  name,
  label,
  count,
  active,
  onClick,
}: {
  name: string | null;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Chip active={active} onClick={onClick} count={count}>
      <ProjectTag name={name} className="bg-transparent px-0" />
      {/* For events without a project the monogram is the whole name ("orc"): we do not
         repeat it twice */}
      {name && <span className="max-w-32 truncate">{label}</span>}
    </Chip>
  );
}

function LevelChip({
  level,
  count,
  active,
  onClick,
}: {
  level: EventLevel;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const meta = LEVEL_META[level];
  const Icon = meta.icon;
  return (
    <Chip active={active} onClick={onClick} count={count} tone={meta.fg}>
      <Icon size={12} className={cn("shrink-0", !active && meta.fg)} aria-hidden />
      {levelLabel(t, level)}
    </Chip>
  );
}

/**
 * Event row in the large dialog. On top is what it is about (project, task number and title, its
 * current status), below it the event text itself. In the narrow panel the order is reversed, there
 * is simply no room for "what it is about".
 */
function EventRow({
  event: e,
  fresh,
  showProject,
  onOpenTask,
}: {
  event: OrcEvent;
  fresh: boolean;
  showProject: boolean;
  onOpenTask?: (taskId: number) => void;
}) {
  const { t, language } = useTranslation();
  const meta = LEVEL_META[e.level];
  const Icon = meta.icon;
  const clickable = e.task_id !== null && onOpenTask;
  const status = e.task_status ? STATUS_META[e.task_status] : null;
  // There is a task title: it is the row header. There is none (a dispatcher event or the task was
  // deleted): the event text itself serves as the header, we do not repeat it a second time.
  const heading = e.task_title;

  return (
    <li className="border-b border-[var(--line)] last:border-b-0">
      <div
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? () => onOpenTask(e.task_id as number) : undefined}
        onKeyDown={
          clickable
            ? (ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onOpenTask(e.task_id as number);
                }
              }
            : undefined
        }
        className={cn(
          "relative flex gap-3 px-4 py-2 transition-colors",
          clickable && "cursor-pointer hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]",
        )}
      >
        {fresh && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-[var(--st-blocked)]" />}
        <Icon size={14} className={cn("mt-0.5 shrink-0", meta.fg)} aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {showProject && <ProjectTag name={e.project_name} full />}
            {e.task_id !== null && (
              <span className="tnum shrink-0 font-mono text-[12px] text-[var(--ink-faint)]">#{e.task_id}</span>
            )}
            <span
              className={cn(
                "min-w-0 truncate text-[13px]",
                heading ? "font-medium text-[var(--ink)]" : "text-[var(--ink)]",
              )}
            >
              {heading ?? e.message}
            </span>
            {status && e.task_status && (
              <Badge tone={status.chip} icon={status.icon}>
                {statusLabel(t, e.task_status)}
              </Badge>
            )}
          </div>
          {heading && (
            <p
              className={cn(
                "mt-0.5 break-words text-[12px] leading-snug [overflow-wrap:anywhere]",
                fresh ? "text-[var(--ink-muted)]" : "text-[var(--ink-faint)]",
              )}
            >
              {e.message}
            </p>
          )}
        </div>

        <span className="tnum shrink-0 pt-0.5 font-mono text-[11px] text-[var(--ink-faint)]">
          {eventTime(e.created_at, language)}
        </span>
      </div>
    </li>
  );
}
