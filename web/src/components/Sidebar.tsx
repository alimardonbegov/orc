import { useMemo } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  BookOpen,
  FolderSearch,
  Info,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
} from "lucide-react";
import type { DispatcherStatus, Project, Task, UsageStatus } from "../types";
import { needsAttention } from "../status";
import { unviewedByProject } from "../viewing";
import { IconButton } from "../ui/Button";
import { focusRing } from "../ui/tokens";
import { Tip } from "../ui/Overlays";
import { SidebarRow } from "./SidebarRow";
import { UsagePanel } from "./UsagePanel";
import { DispatcherPanel } from "./DispatcherPanel";
import { EventsPanel } from "./EventsPanel";
import { OrcLogo } from "../brand/OrcLogo";
import { OrcMark } from "../brand/OrcMark";
import { cn } from "../lib/cn";
import { initials } from "../lib/initials";
import { useTranslation, type TFunction } from "../i18n";
import type { HelpPage } from "./help/HelpPages";

interface Props {
  projects: Project[];
  tasks: Task[];
  currentId: number | null;
  collapsed: boolean;
  usage: UsageStatus | null;
  onUsageRefresh: () => void;
  usagePending: boolean;
  /** Dispatcher state: one for all projects, so it lives in the column, not in the board header. */
  dispatcher: DispatcherStatus | null;
  onPause: () => void;
  onResume: () => void;
  onTick: () => void;
  dispatcherPending: boolean;
  /** Event feed: whether the panel is open and how to open/close it (the same "e" key). */
  eventsOpen: boolean;
  onEventsOpen: (open: boolean) => void;
  /** Clicking a task event opens its card. */
  onOpenTask: (taskId: number) => void;
  /** The dispatcher responds and is not paused: the orc's eyes in the mark glow. */
  awake: boolean;
  /** At least one agent is working: the eyes pulse, like the dot in the header. */
  working: boolean;
  onSelect: (id: number) => void;
  /** Manual reordering of projects in the sidebar (drag): the new order of ids top to bottom
   * (active ones only). */
  onReorderProjects: (orderedIds: number[]) => void;
  onToggleCollapsed: () => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
  /** Open help page ("About" / "How it works") or null for the board. */
  helpPage: HelpPage | null;
  onOpenHelp: (page: HelpPage) => void;
}

/** Manual project order: those with a position by ascending value, followed by never-reordered ones
 * (position=null) by id; a list nobody has touched by hand looks exactly as before. */
export function byPosition(list: Project[]): Project[] {
  return [...list].sort((a, b) => {
    const pa = a.position ?? Infinity;
    const pb = b.position ?? Infinity;
    return pa !== pb ? pa - pb : a.id - b.id;
  });
}

/** Doors to help at the bottom of the column, in the order in which they are read the first time. */
const HELP_ROWS: { page: HelpPage; icon: typeof Info; label: string }[] = [
  { page: "guide", icon: BookOpen, label: "pages.nav.guide" },
  { page: "about", icon: Info, label: "pages.nav.about" },
];

type Counters = Map<number, { running: number; attention: number; total: number }>;

/** One project row in the sidebar: it drags itself (see useSortable), like TaskCard on the board. */
function SidebarProjectRow({
  project: p,
  counters,
  unviewed,
  currentId,
  collapsed,
  onSelect,
  t,
}: {
  project: Project;
  counters: Counters;
  /** The project's finished results that the owner has not seen yet (viewing.ts). */
  unviewed: number;
  currentId: number | null;
  collapsed: boolean;
  onSelect: (id: number) => void;
  t: TFunction;
}) {
  const { setNodeRef, transform, transition, isDragging, listeners, attributes } = useSortable({ id: p.id });
  const c = counters.get(p.id) ?? { running: 0, attention: 0, total: 0 };
  const selected = p.id === currentId;
  const style = { transform: CSS.Transform.toString(transform), transition };

  const row = (
    <button
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={() => onSelect(p.id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "relative flex w-full items-center rounded-[var(--radius-sm)] transition-colors duration-100",
        focusRing,
        collapsed ? "h-9 justify-center" : "h-8 gap-2 px-2",
        selected
          ? "bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] text-[var(--ink)]"
          : "text-[var(--ink-muted)] hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] hover:text-[var(--ink)]",
        isDragging ? "z-10 cursor-grabbing opacity-90 shadow-[var(--shadow-pop)]" : "cursor-grab",
      )}
    >
      {/* Mark of the selected one: a vertical bar at the edge, not a full fill */}
      {selected && <span aria-hidden className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r bg-[var(--ink)]" />}

      {collapsed ? (
        <span className="relative">
          <span className="flex h-6 w-6 items-center justify-center rounded-[6px] bg-[var(--sunken)] font-mono text-[10px] font-semibold">
            {initials(p.name)}
          </span>
          {/* A missing folder overrides any counters: while it is gone, no task of this
             project will go anywhere anyway. */}
          {!p.path_ok && (
            <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--danger)] ring-2 ring-[var(--surface)]" />
          )}
          {p.path_ok && c.attention > 0 && (
            <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--st-blocked)] ring-2 ring-[var(--surface)]" />
          )}
          {p.path_ok && c.attention === 0 && c.running > 0 && (
            <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--st-progress)] ring-2 ring-[var(--surface)]" />
          )}
          {/* An unviewed result is the calmest of the signals: it holds nobody up, so it
             yields the dot both to the call for a human and to running work. */}
          {p.path_ok && c.attention === 0 && c.running === 0 && unviewed > 0 && (
            <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--st-done)] ring-2 ring-[var(--surface)]" />
          )}
        </span>
      ) : (
        <>
          {!p.path_ok && (
            <FolderSearch size={12} className="shrink-0 text-[var(--danger)]" aria-label={t("sidebar.folderUnavailable")} />
          )}
          <span className="truncate text-[13px]">{p.name}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {c.running > 0 && (
              <span className="tnum flex items-center gap-1 text-[11px] text-[var(--st-progress)]" title={t("sidebar.running", { count: c.running })}>
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--st-progress)]" />
                {c.running}
              </span>
            )}
            {c.attention > 0 && (
              <span className="tnum flex items-center gap-1 text-[11px] text-[var(--st-blocked)]" title={t("sidebar.needsAttention", { count: c.attention })}>
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--st-blocked)]" />
                {c.attention}
              </span>
            )}
            {/* Tasks close in several projects at once: the counter says where the results
               you have not seen yet are, without switching into each project. */}
            {unviewed > 0 && (
              <span className="tnum flex items-center gap-1 text-[11px] text-[var(--st-done)]" title={t("viewing.count", { count: unviewed })}>
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--st-done)]" />
                {unviewed}
              </span>
            )}
          </span>
        </>
      )}
    </button>
  );

  return (
    <li>
      {collapsed ? (
        <Tip
          side="right"
          text={`${p.name}${!p.path_ok ? ` · ${t("sidebar.folderUnavailableDetail", { error: p.path_error ?? "" })}` : ""}${
            c.attention > 0 ? ` · ${t("sidebar.needsAttention", { count: c.attention })}` : ""
          }${unviewed > 0 ? ` · ${t("viewing.count", { count: unviewed })}` : ""}`}
        >
          {row}
        </Tip>
      ) : (
        row
      )}
    </li>
  );
}

/**
 * Left column: projects and global actions. Collapses into a narrow rail: every 190 pixels count
 * for the board. The width is animated, and the state survives a reload (see useUiState).
 *
 * The column is laid out in three tiers, and that is its main rule: on top is where to go (projects
 * plus an "add" button right in the heading of their list), in the middle are doors to the shared
 * panels ("Events", "Settings") of the same shape as the project items, at the bottom is the system
 * state, which one glances at rather than goes to: the orchestrator and limits. Previously all
 * three tiers were dumped into four blocks of buttons of different calibre, and "New project" ended
 * up at the very bottom, farthest from the list it belongs to.
 */
export function Sidebar({
  projects,
  tasks,
  currentId,
  collapsed,
  usage,
  onUsageRefresh,
  usagePending,
  dispatcher,
  onPause,
  onResume,
  onTick,
  dispatcherPending,
  eventsOpen,
  onEventsOpen,
  onOpenTask,
  awake,
  working,
  onSelect,
  onReorderProjects,
  onToggleCollapsed,
  onAddProject,
  onOpenSettings,
  helpPage,
  onOpenHelp,
}: Props) {
  const { t } = useTranslation();
  // A click on a project must not count as a drag: we activate dragging after a 6px shift (the same
  // threshold as on the board, see Board.tsx).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // We compute per-project counters once per change of the task list, not in the markup: with ten
  // projects that is a filter on every item on every redraw.
  const counters = useMemo(() => {
    const map = new Map<number, { running: number; attention: number; total: number }>();
    for (const t of tasks) {
      const c = map.get(t.project_id) ?? { running: 0, attention: 0, total: 0 };
      c.total += 1;
      if (t.status === "in_progress" || t.status === "verifying" || t.status === "merging") c.running += 1;
      if (needsAttention(t)) c.attention += 1;
      map.set(t.project_id, c);
    }
    return map;
  }, [tasks]);

  const unviewed = useMemo(() => unviewedByProject(tasks, projects), [tasks, projects]);

  // We split out the archive here, not in App: the column itself decides how to show archived
  // projects. Manual order only for active ones: the archive section is not draggable.
  const active = useMemo(() => byPosition(projects.filter((p) => !p.archived_at)), [projects]);
  const archived = useMemo(() => projects.filter((p) => p.archived_at), [projects]);

  function handleDragEnd(e: DragEndEvent) {
    const overId = e.over?.id;
    if (overId === undefined || e.active.id === overId) return;
    const ids = active.map((p) => p.id);
    const from = ids.indexOf(e.active.id as number);
    const at = ids.indexOf(overId as number);
    if (from === -1 || at === -1) return;
    onReorderProjects(arrayMove(ids, from, at));
  }

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-[var(--line)] bg-[var(--surface)] transition-[width] duration-200 ease-out",
        collapsed ? "w-[3.5rem]" : "w-[15rem]",
      )}
    >
      {/* The orc mark lives in the column header and in the collapsed rail: the only place
         where the brand is always visible. The orc's eyes glow while the dispatcher is alive:
         the same signal as the dot in the header, only it is visible with the panel collapsed
         too. */}
      <div
        className={cn(
          "flex shrink-0 border-b border-[var(--line)]",
          collapsed ? "h-20 flex-col items-center justify-center gap-1 px-1" : "h-12 items-center gap-2 pl-3 pr-1.5",
        )}
      >
        {collapsed ? (
          <Tip
            text={awake ? (working ? t("sidebar.orcAgentsWorking") : t("sidebar.orcDispatcherAlive")) : t("sidebar.orcDispatcherAsleep")}
            side="right"
          >
            <span className="flex h-7 w-7 cursor-default items-center justify-center text-[var(--ink)]">
              <OrcMark size={22} awake={awake} working={working} title="orc" />
            </span>
          </Tip>
        ) : (
          <OrcLogo size={20} awake={awake} working={working} tagline={t("sidebar.tagline")} />
        )}
        <Tip text={collapsed ? t("sidebar.expandPanel") : t("sidebar.collapsePanel")} side="right">
          <IconButton
            icon={collapsed ? PanelLeftOpen : PanelLeftClose}
            label={collapsed ? t("sidebar.expandPanel") : t("sidebar.collapsePanel")}
            size="sm"
            className={collapsed ? "" : "ml-auto"}
            onClick={onToggleCollapsed}
          />
        </Tip>
      </div>

      <nav aria-label={t("sidebar.projectsNav")} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-1.5">
        {/* The "add" button stands in the heading of the list it belongs to, not at the
           bottom of the column among settings: that is where it is looked for in any project
           manager. */}
        {!collapsed && (
          <div className="flex h-7 items-center gap-1 pl-1.5 pr-0.5">
            <p className="text-[11px] font-medium text-[var(--ink-faint)]">{t("sidebar.projectsHeading")}</p>
            <Tip text={t("sidebar.newProject")} side="right">
              <IconButton icon={Plus} label={t("sidebar.newProject")} size="sm" className="ml-auto" onClick={onAddProject} />
            </Tip>
          </div>
        )}
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={active.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            <ul className="space-y-0.5">
              {active.map((p) => (
                <SidebarProjectRow key={p.id} project={p} counters={counters} unviewed={unviewed.get(p.id) ?? 0} currentId={currentId} collapsed={collapsed} onSelect={onSelect} t={t} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>

        {/* The rail has no heading, so the plus sits right under the project monograms:
           still next to the list, not in the footer. */}
        {collapsed && (
          <div className="pt-1">
            <Tip side="right" text={t("sidebar.newProject")}>
              <IconButton icon={Plus} label={t("sidebar.newProject")} size="sm" className="mx-auto flex" onClick={onAddProject} />
            </Tip>
          </div>
        )}

        {projects.length === 0 && !collapsed && (
          <p className="px-1.5 py-3 text-[12px] leading-snug text-[var(--ink-faint)]">
            {t("sidebar.noProjectsHint")}
          </p>
        )}

        {/* Archived projects do not vanish from the column but sink to the bottom as a muted
           section: an archived project should be visible, otherwise it can be restored only by
           remembering it ever existed. */}
        {archived.length > 0 && !collapsed && (
          <>
            <p className="flex items-center gap-1.5 px-1.5 pb-1 pt-3 text-[11px] font-medium text-[var(--ink-faint)]">
              <Archive size={11} aria-hidden />
              {t("sidebar.archiveHeading")}
            </p>
            <ul className="space-y-0.5">
              {archived.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => onSelect(p.id)}
                    aria-current={p.id === currentId ? "true" : undefined}
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-[13px] transition-colors duration-100",
                      focusRing,
                      p.id === currentId
                        ? "bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] text-[var(--ink)]"
                        : "text-[var(--ink-faint)] hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] hover:text-[var(--ink-muted)]",
                    )}
                  >
                    <span className="truncate">{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>

      {/* Second tier: doors to the shared panels. Both are about the whole orchestrator, not
         the selected project, and both look like items of the list above, so that "where to go"
         reads as one column top to bottom. Appearance moved into "Settings": keeping a separate
         button in the column for something changed once in a lifetime is expensive. */}
      <div className={cn("shrink-0 border-t border-[var(--line)] p-1.5", collapsed ? "space-y-1" : "space-y-0.5")}>
        <EventsPanel open={eventsOpen} onToggle={onEventsOpen} onOpenTask={onOpenTask} collapsed={collapsed} />
        {collapsed ? (
          <Tip side="right" text={t("sidebar.orcSettings")}>
            <IconButton icon={Settings} label={t("sidebar.orcSettings")} size="sm" className="mx-auto flex" onClick={onOpenSettings} />
          </Tip>
        ) : (
          <SidebarRow icon={Settings} onClick={onOpenSettings}>
            {t("sidebar.settings")}
          </SidebarRow>
        )}
        {/* Help is also about the whole orchestrator, so it stands in the same tier of doors
           rather than hiding in settings: it is opened exactly when one does not yet know where
           anything is configured. */}
        {HELP_ROWS.map(({ page, icon, label }) =>
          collapsed ? (
            <Tip key={page} side="right" text={t(label)}>
              <IconButton
                icon={icon}
                label={t(label)}
                size="sm"
                aria-current={helpPage === page ? "page" : undefined}
                className={cn("mx-auto flex", helpPage === page && "bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] text-[var(--ink)]")}
                onClick={() => onOpenHelp(page)}
              />
            </Tip>
          ) : (
            <SidebarRow
              key={page}
              icon={icon}
              active={helpPage === page}
              aria-current={helpPage === page ? "page" : undefined}
              onClick={() => onOpenHelp(page)}
            >
              {t(label)}
            </SidebarRow>
          ),
        )}
      </div>

      {/* Third tier is the system state: the orchestrator heartbeat and account limits. This
         is the background of work, not controls, so they are pressed to the very bottom as one
         block: not "three more buttons" but a status line. */}
      <div
        className={cn(
          "shrink-0 border-t border-[var(--line)]",
          collapsed ? "space-y-1.5 p-1.5" : "space-y-2.5 px-1.5 py-2",
        )}
      >
        <DispatcherPanel
          status={dispatcher}
          onPause={onPause}
          onResume={onResume}
          onTick={onTick}
          pending={dispatcherPending}
          collapsed={collapsed}
        />
        <UsagePanel status={usage} onRefresh={onUsageRefresh} pending={usagePending} collapsed={collapsed} />
      </div>
    </aside>
  );
}
