import { useMemo, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Activity, Brain, GripVertical, MessageSquare, Pencil, Plus, RotateCcw, Search, Users } from "lucide-react";
import { doingNow } from "../activity";
import { api } from "../api";
import { useAgents } from "../agents";
import {
  DEFAULT_VIEW, applyOrder, filterAgents, groupAgents, isFiltered, moveInOrder, readOrder, readView, sortAgents,
  writeOrder, writeView, type AgentGroup, type AgentSort, type AgentStatusFilter, type AgentView,
} from "../agentsView";
import { usePolling } from "../hooks/usePolling";
import { modelLabel } from "../models";
import type { Agent, AgentRun, Project } from "../types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/Field";
import { AgentAvatar } from "./AgentAvatar";
import { AgentActivityDialog, useRunTitle } from "./AgentActivityDialog";
import { PhaseBadge } from "./ActivityPanel";
import { AgentDetailPage } from "./AgentDetailPage";
import { AgentDialog } from "./AgentDialog";
import { useTranslation } from "../i18n";

interface Props {
  projects: Project[];
  onChanged: () => void;
  onChat: (agent: Agent) => void;
  onOpenTask?: (id: number) => void;
}

/** How often the "who is working" list is refreshed. It reads every live session's state.json. */
const ACTIVITY_POLL_MS = 3000;

/** A live run in one line: whose it is, what it is, what it is doing right now. */
function RunLine({ run, agent, onOpen }: { run: AgentRun; agent?: Agent; onOpen: () => void }) {
  const title = useRunTitle();
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-[var(--sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
    >
      {agent ? <AgentAvatar agent={agent} size={20} /> : <Users size={14} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />}
      <span className="w-28 shrink-0 truncate text-[12px] text-[var(--ink-muted)]">{agent?.name ?? t("activity.noAgent")}</span>
      <span className="min-w-0 max-w-[40%] truncate text-[13px] font-medium text-[var(--ink)]">{title(run)}</span>
      {run.now && <PhaseBadge phase={run.now.phase} />}
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink-faint)]" title={doingNow(run.now)}>{doingNow(run.now)}</span>
    </button>
  );
}

interface CardProps {
  agent: Agent;
  projects: Project[];
  live: number;
  onEdit: () => void;
  onChat: () => void;
  onOpen: () => void;
  /** Present while the manual order can be changed: the grip that starts the drag. */
  handle?: { setActivatorNodeRef: (el: HTMLElement | null) => void; listeners?: Record<string, unknown>; attributes: object };
}

function AgentCard({ agent, projects, live, onEdit, onChat, onOpen, handle }: CardProps) {
  const { t } = useTranslation();
  const scope = agent.project_id === null ? null : projects.find((p) => p.id === agent.project_id);
  const led = projects.filter((p) => p.lead_agent_id === agent.id);
  const params = [
    agent.model ? modelLabel(agent.model) : t("agents.modelInherited"),
    agent.effort,
    agent.permission_mode,
  ].filter(Boolean);
  return (
    <article className="group relative flex h-full min-w-0 flex-col gap-2.5 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-3.5">
      {handle && (
        <button
          type="button"
          ref={handle.setActivatorNodeRef}
          aria-label={t("agents.view.drag", { name: agent.name })}
          title={t("agents.view.drag", { name: agent.name })}
          className="absolute right-1.5 top-1.5 z-10 cursor-grab touch-none rounded-[var(--radius-sm)] p-1 text-[var(--ink-faint)] opacity-0 hover:bg-[var(--sunken)] hover:text-[var(--ink)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] group-hover:opacity-100"
          {...handle.attributes}
          {...handle.listeners}
        >
          <GripVertical size={14} aria-hidden />
        </button>
      )}
      <h2 className="-m-1">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("agents.detail.openAgent", { name: agent.name })}
        className="flex w-full items-start gap-3 rounded-[var(--radius-sm)] p-1 text-left hover:bg-[var(--sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
      >
        <span className="relative shrink-0">
          <AgentAvatar agent={agent} size={40} />
          {live > 0 && <span aria-hidden data-testid="agent-card-live" className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--st-progress)] ring-2 ring-[var(--surface)]" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-[var(--ink)]">{agent.name}</span>
          <span className="block truncate font-mono text-[11px] text-[var(--ink-faint)]" title={params.join(" · ")}>
            {params.join(" · ")}
          </span>
        </span>
      </button>
      </h2>
      <p className="line-clamp-2 min-h-[2.5em] text-[12px] leading-snug text-[var(--ink-muted)]">
        {agent.description || (agent.prompt ? agent.prompt : t("agents.noDescription"))}
      </p>
      <div className="flex flex-wrap gap-1">
        <Badge>{scope ? scope.name : t("agents.scopeEverywhere")}</Badge>
        {led.map((p) => (
          <Badge key={p.id}>{t("agents.leadOf", { project: p.name })}</Badge>
        ))}
        {agent.memory_enabled && <Badge icon={Brain}>{t("agents.memoryBadge")}</Badge>}
        {live > 0 && <Badge tone="bg-[color-mix(in_oklab,var(--st-progress)_16%,transparent)] text-[var(--st-progress)]">{t("agents.detail.statusWorking", { count: live })}</Badge>}
        {agent.tasks.active > 0 && <Badge>{t("agents.tasksActive", { count: agent.tasks.active })}</Badge>}
        {agent.tasks.total > 0 && <Badge>{t("agents.tasksTotal", { count: agent.tasks.total })}</Badge>}
      </div>
      <div className="mt-auto flex items-center gap-1.5 pt-0.5">
        <Button variant="secondary" size="sm" icon={MessageSquare} onClick={onChat}>
          {t("agents.chat")}
        </Button>
        <Button variant={live > 0 ? "secondary" : "ghost"} size="sm" icon={Activity} onClick={onOpen}>
          {t("agents.detail.open")}
        </Button>
        <Button variant="ghost" size="sm" icon={Pencil} onClick={onEdit}>
          {t("common.edit")}
        </Button>
      </div>
    </article>
  );
}

/** A card that can be dragged by its grip to another place of the list. */
function SortableAgentCard(props: Omit<CardProps, "handle">) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: props.agent.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 20 : undefined, opacity: isDragging ? 0.7 : 1 }}
    >
      <AgentCard {...props} handle={{ setActivatorNodeRef, listeners, attributes }} />
    </div>
  );
}

/** All agents in one place: who they are, what they run on and where they are allowed to work. */
export function AgentsPage({ projects, onChanged, onChat, onOpenTask }: Props) {
  const { t } = useTranslation();
  const agents = useAgents();
  const [dialog, setDialog] = useState<{ agent: Agent | null } | null>(null);
  const activity = usePolling(() => api.agentsActivity(), ACTIVITY_POLL_MS);
  const runs = useMemo(() => activity.data?.runs ?? [], [activity.data]);
  // agent: undefined is "closed", null is the tasks without an agent.
  // The agent whose own page is open; null is the list.
  const [openId, setOpenId] = useState<number | null>(null);
  const [watching, setWatching] = useState<{ agent: Agent | null; run: AgentRun | null } | null>(null);

  const [view, setViewState] = useState<AgentView>(readView);
  const [order, setOrderState] = useState<number[]>(readOrder);
  const setView = (patch: Partial<AgentView>) => {
    const next = { ...view, ...patch };
    setViewState(next);
    writeView(next);
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const liveIds = useMemo(() => new Set(runs.map((r) => r.agent_id).filter((id): id is number => id != null)), [runs]);
  // The full list in the person's order; filters, sorting and grouping are applied on top of it.
  const ordered = useMemo(() => applyOrder(agents, order), [agents, order]);
  const visible = useMemo(() => sortAgents(filterAgents(ordered, view, liveIds), view.sort), [ordered, view, liveIds]);
  const sections = useMemo(
    () => groupAgents(visible, view.group, (id) => projects.find((p) => p.id === id)?.name ?? `#${id}`),
    [visible, view.group, projects],
  );
  // Dragging only makes sense when the screen shows the manual order and nothing regroups it.
  const canDrag = view.sort === "manual" && view.group === "none";
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const next = moveInOrder(ordered.map((a) => a.id), Number(active.id), Number(over.id));
    setOrderState(next);
    writeOrder(next);
  };

  const opened = openId === null ? undefined : agents.find((a) => a.id === openId);

  const dialogs = (
    <>
      {dialog && (
        <AgentDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          agent={dialog.agent}
          projects={projects}
          onSaved={onChanged}
        />
      )}
      {watching && (
        <AgentActivityDialog
          agent={watching.agent}
          activity={activity.data}
          initial={watching.run}
          onClose={() => setWatching(null)}
          onOpenTask={(id) => onOpenTask?.(id)}
          onChanged={() => void activity.refresh()}
        />
      )}
    </>
  );

  // A deleted agent leaves its page for the list.
  if (opened) {
    return (
      <>
        <AgentDetailPage
          agent={opened}
          projects={projects}
          activity={activity.data}
          onBack={() => setOpenId(null)}
          onEdit={() => setDialog({ agent: opened })}
          onChat={() => onChat(opened)}
          onOpenTask={(id) => onOpenTask?.(id)}
          onActivityChanged={() => void activity.refresh()}
        />
        {dialogs}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[16px] font-semibold tracking-tight text-[var(--ink)]">{t("agents.title")}</h1>
          <p className="mt-0.5 max-w-2xl text-[12px] leading-snug text-[var(--ink-muted)]">{t("agents.subtitle")}</p>
        </div>
        <Button variant="primary" icon={Plus} onClick={() => setDialog({ agent: null })}>
          {t("agents.add")}
        </Button>
      </header>
      {runs.length > 0 && (
        <section aria-label={t("activity.workingNow")} className="mb-4 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-1.5">
          <h2 className="mb-0.5 px-2 pt-1 text-[12px] font-medium text-[var(--ink-muted)]">{t("activity.workingNow")}</h2>
          {runs.map((run) => {
            const owner = agents.find((a) => a.id === run.agent_id);
            return (
              <RunLine
                key={`${run.kind}:${run.id}`}
                run={run}
                agent={owner}
                onOpen={() => setWatching({ agent: owner ?? null, run })}
              />
            );
          })}
        </section>
      )}
      {agents.length === 0 ? (
        <div className="m-auto max-w-sm py-16 text-center">
          <Users size={22} className="mx-auto mb-2 text-[var(--ink-faint)]" aria-hidden />
          <p className="text-[14px] font-medium text-[var(--ink)]">{t("agents.empty")}</p>
          <p className="mt-1 text-[12px] leading-snug text-[var(--ink-muted)]">{t("agents.emptyHint")}</p>
        </div>
      ) : (
        <>
          <div role="toolbar" aria-label={t("agents.view.sort")} className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative w-52">
              <Search size={13} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-faint)]" />
              <Input
                type="search"
                value={view.query}
                onChange={(e) => setView({ query: e.target.value })}
                placeholder={t("agents.view.search")}
                aria-label={t("agents.view.search")}
                className="pl-7"
              />
            </div>
            <Select aria-label={t("agents.view.status")} value={view.status} onChange={(e) => setView({ status: e.target.value as AgentStatusFilter })} className="w-36">
              <option value="all">{t("agents.view.status")}: {t("agents.view.all")}</option>
              <option value="working">{t("agents.view.working")}</option>
              <option value="idle">{t("agents.view.idle")}</option>
            </Select>
            <Select aria-label={t("agents.view.project")} value={view.scope} onChange={(e) => setView({ scope: e.target.value })} className="w-44">
              <option value="all">{t("agents.view.allp")}</option>
              <option value="shared">{t("agents.view.shared")}</option>
              {projects.filter((p) => !p.archived_at).map((p) => (
                <option key={p.id} value={String(p.id)}>{p.name}</option>
              ))}
            </Select>
            <Select aria-label={t("agents.view.sort")} value={view.sort} onChange={(e) => setView({ sort: e.target.value as AgentSort })} className="w-44">
              <option value="manual">{t("agents.view.manual")}</option>
              <option value="name">{t("agents.view.name")}</option>
              <option value="newest">{t("agents.view.newest")}</option>
              <option value="oldest">{t("agents.view.oldest")}</option>
              <option value="tasks">{t("agents.view.tasks")}</option>
            </Select>
            <Select aria-label={t("agents.view.group")} value={view.group} onChange={(e) => setView({ group: e.target.value as AgentGroup })} className="w-44">
              <option value="none">{t("agents.view.none")}</option>
              <option value="scope">{t("agents.view.scope")}</option>
              <option value="model">{t("agents.view.model")}</option>
            </Select>
            {(isFiltered(view) || view.sort !== "manual" || view.group !== "none") && (
              <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => setView(DEFAULT_VIEW)}>
                {t("agents.view.reset")}
              </Button>
            )}
            {canDrag && visible.length > 1 && <span className="text-[11px] text-[var(--ink-faint)]">{t("agents.view.hint")}</span>}
          </div>
          {visible.length === 0 && <p className="py-10 text-center text-[13px] text-[var(--ink-muted)]">{t("agents.view.nothing")}</p>}
          {sections.map((section) => {
            const cards = section.agents.map((agent) => {
              const props = {
                agent,
                projects,
                live: runs.filter((r) => r.agent_id === agent.id).length,
                onEdit: () => setDialog({ agent }),
                onChat: () => onChat(agent),
                onOpen: () => setOpenId(agent.id),
              };
              return canDrag ? <SortableAgentCard key={agent.id} {...props} /> : <div key={agent.id}><AgentCard {...props} /></div>;
            });
            const grid = <div className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-3">{cards}</div>;
            const title =
              view.group === "none" ? null : view.group === "scope" ? (section.label ?? t("agents.scopeEverywhere")) : section.label ? modelLabel(section.label) : t("agents.view.noModel");
            return (
              <section key={section.key} className="mb-4" aria-label={title ?? undefined}>
                {title && <h2 className="mb-2 text-[12px] font-medium text-[var(--ink-muted)]">{title} · {section.agents.length}</h2>}
                {canDrag ? (
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                    <SortableContext items={section.agents.map((a) => a.id)} strategy={rectSortingStrategy}>
                      {grid}
                    </SortableContext>
                  </DndContext>
                ) : (
                  grid
                )}
              </section>
            );
          })}
        </>
      )}
      {dialogs}
    </div>
  );
}
