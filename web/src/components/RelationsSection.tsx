import { forwardRef, useMemo, useState } from "react";
import { ChevronRight, Layers, Link2, Pencil, Plus, Repeat2, X } from "lucide-react";
import { useAgents } from "../agents";
import { useTranslation } from "../i18n";
import { cn } from "../lib/cn";
import {
  TREE_OPEN_DEPTH, attachCandidates, comesNext, dependencyTree, groupByStage, progressOf, subtasksOf, treeSize, waitsFor,
  type Progress, type RelatedCard, type TreeNode,
} from "../relations";
import { STATUS_META } from "../status";
import { statusLabel } from "../labels";
import type { Project, Task } from "../types";
import { PickerPanel, Picker } from "../ui/Picker";
import { Checkbox } from "../ui/Field";
import { Segmented } from "../ui/Segmented";
import { focusRing } from "../ui/tokens";
import { AgentAvatar } from "./AgentAvatar";
import { DependsOnPicker } from "./DependsOnPicker";

type View = "list" | "tree";
const VIEW_KEY = "orc.relationsView";

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

/** The small ring of multica's sub-issues: an open arc while in progress, a full one when all are done. */
export function ProgressRing({ done, total, size = 12 }: Progress & { size?: number }) {
  const stroke = 1.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(done / total, 1) : 0;
  const complete = total > 0 && done >= total;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className={complete ? "text-[var(--st-done)]" : "text-[var(--primary)]"}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** done/total in a pill with the ring, as on the board, in the section header and in the parent link. */
export function ProgressPill({ done, total, className }: Progress & { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      title={t("card.relations.progressTitle", { done, total })}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--sunken)] px-1.5 py-0.5", className)}
    >
      <ProgressRing done={done} total={total} size={11} />
      <span className="tnum text-[10.5px] font-medium text-[var(--ink-muted)]">
        {done}/{total}
      </span>
    </span>
  );
}

/** One related card, after multica's SubIssueRow: status, number, title, its project when foreign, its agent. */
function CardRow({ id, task, projectId, projects, onOpen, warn, trailing, current, note, muted }: {
  id: number;
  task: Task | null;
  projectId: number;
  projects?: Project[];
  onOpen?: (id: number) => void;
  /** Holds this card back: a failed blocker. */
  warn?: string;
  trailing?: React.ReactNode;
  current?: boolean;
  note?: React.ReactNode;
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const agents = useAgents();
  if (!task) {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-[12px] text-[var(--ink-faint)]">
        <span className="tnum font-mono text-[11px]">#{id}</span>
        <span className="truncate italic">{t("card.relations.gone")}</span>
        {note}
      </div>
    );
  }
  const meta = STATUS_META[task.status];
  const StatusIcon = meta.icon;
  const agent = agents.find((a) => a.id === task.agent_id);
  const foreign = task.project_id !== projectId ? projects?.find((p) => p.id === task.project_id) : undefined;
  const done = task.status === "done";
  const body = (
    <>
      <StatusIcon size={13} aria-label={statusLabel(t, task.status)} className={cn("shrink-0", meta.fg)} />
      <span className="tnum shrink-0 font-mono text-[11px] text-[var(--ink-faint)]">#{task.id}</span>
      <span className={cn("min-w-0 flex-1 truncate", done || muted ? "text-[var(--ink-muted)]" : "text-[var(--ink)]")}>{task.title}</span>
      {current && <span className="shrink-0 text-[10.5px] font-medium text-[var(--primary)]">{t("card.relations.thisCard")}</span>}
      {note}
      {foreign && <span className="shrink-0 truncate text-[10.5px] text-[var(--ink-faint)]">{foreign.name}</span>}
      {agent && <AgentAvatar agent={agent} size={16} />}
    </>
  );
  const rowClass = cn(
    "group/row flex min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-[12px]",
    warn && "bg-[color-mix(in_oklab,var(--danger)_10%,transparent)]",
    current && "bg-[color-mix(in_oklab,var(--primary)_10%,transparent)]",
  );
  return (
    <div className={rowClass} title={warn}>
      {onOpen && !current ? (
        <button
          type="button"
          // Spans side by side give a name without spaces ("#3Schema"): say it the way it reads
          aria-label={`#${task.id} ${task.title}${foreign ? ` · ${foreign.name}` : ""} (${statusLabel(t, task.status)})`}
          onClick={() => onOpen(task.id)}
          title={warn ?? t("taskModal.openDepTitle", { id: task.id })}
          className={cn("flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:[&>span:nth-child(3)]:underline", focusRing)}
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {trailing}
    </div>
  );
}

function GroupHeading({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-1.5 px-1.5">
      <h4 className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-medium text-[var(--ink-faint)]">{children}</h4>
      {actions}
    </div>
  );
}

const IconButton = forwardRef<HTMLButtonElement, { label: string; icon: typeof Plus } & React.ButtonHTMLAttributes<HTMLButtonElement>>(
  function IconButton({ label, icon: Icon, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        className={cn("inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--ink-faint)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]", focusRing, className)}
        {...rest}
      >
        <Icon size={13} aria-hidden />
      </button>
    );
  },
);

function TreeRows({ nodes, projectId, projects, onOpen }: { nodes: TreeNode[]; projectId: number; projects?: Project[]; onOpen?: (id: number) => void }) {
  return (
    <ul role="group" className="space-y-px">
      {nodes.map((node, i) => (
        <TreeItem key={`${node.id}-${i}`} node={node} projectId={projectId} projects={projects} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function TreeItem({ node, projectId, projects, onOpen }: { node: TreeNode; projectId: number; projects?: Project[]; onOpen?: (id: number) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(node.depth < TREE_OPEN_DEPTH || node.leadsToCurrent);
  const hasChildren = node.children.length > 0;
  const note = node.cycle ? (
    <span className="shrink-0 text-[10.5px] text-[var(--danger)]" title={t("card.relations.cycleHint")}>
      {t("card.relations.cycle")}
    </span>
  ) : node.repeat ? (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-[var(--ink-faint)]" title={t("card.relations.repeatHint")}>
      <Repeat2 size={11} aria-hidden />
      {t("card.relations.repeat")}
    </span>
  ) : null;
  return (
    <li role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-current={node.current && !node.repeat ? "true" : undefined}>
      <div className="flex items-center" style={{ paddingLeft: node.depth * 14 }}>
        {hasChildren ? (
          <button
            type="button"
            aria-label={open ? t("card.relations.collapse") : t("card.relations.expand")}
            onClick={() => setOpen(!open)}
            className={cn("inline-flex h-5 w-4 shrink-0 items-center justify-center rounded text-[var(--ink-faint)] hover:text-[var(--ink)]", focusRing)}
          >
            <ChevronRight size={12} aria-hidden className={cn("transition-transform duration-100", open && "rotate-90")} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <CardRow
            id={node.id}
            task={node.task}
            projectId={projectId}
            projects={projects}
            onOpen={onOpen}
            current={node.current && !node.repeat}
            muted={node.repeat}
            note={note}
          />
        </div>
      </div>
      {hasChildren && open && <TreeRows nodes={node.children} projectId={projectId} projects={projects} onOpen={onOpen} />}
    </li>
  );
}

interface Props {
  task: Task;
  /** Live cards of every project: relations cross repositories. */
  allTasks: Task[];
  projects?: Project[];
  /** What it waits for can still change: the card has not started and is not archived. */
  depsEditable: boolean;
  /** Subtasks can be added, attached and detached: the card is not archived. */
  subtasksEditable: boolean;
  onDepsChange: (ids: number[]) => void;
  onOpenTask?: (id: number) => void;
  onCreateSubtask?: () => void;
  /** Make a card a subtask of this one, or (null) take it out. */
  onSetParent: (childId: number, parentId: number | null) => void;
  /** Put a subtask into a stage, or (null) take it out of the stages. */
  onSetStage: (childId: number, stage: number | null) => void;
  /** Ask orc to wake this card when all its subtasks are done (the card's own choice; off by default). */
  onWakeChange?: (wake: boolean) => void;
}

/**
 * Relations of a card, under its description: what it waits for, what comes next, and its subtasks. The first two
 * are `task_deps` and hold the queue; subtasks are grouping and do not. "Tree" shows the whole chain around the card.
 * Everything is computed from the board's own list (relations.ts).
 */
export function RelationsSection({ task, allTasks, projects, depsEditable, subtasksEditable, onDepsChange, onOpenTask, onCreateSubtask, onSetParent, onSetStage, onWakeChange }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>(readView);
  const [editingDeps, setEditingDeps] = useState(false);
  const blockers = waitsFor(task, allTasks);
  const next = comesNext(task.id, allTasks);
  const children = subtasksOf(task.id, allTasks);
  const progress = progressOf(children);
  const stageGroups = groupByStage(children);
  const staged = stageGroups.some((g) => g.stage !== null);
  const lastStage = Math.max(0, ...children.map((c) => c.stage ?? 0));
  const tree = useMemo(() => dependencyTree(task.id, allTasks), [task.id, allTasks]);
  const hasChain = treeSize(tree) > 1;
  const candidates = useMemo(() => (subtasksEditable ? attachCandidates(task.id, allTasks) : []), [subtasksEditable, task.id, allTasks]);

  const changeView = (value: View) => {
    setView(value);
    try {
      localStorage.setItem(VIEW_KEY, value);
    } catch {
      // A remembered view is a convenience: without storage the list is the default each time
    }
  };

  if (!hasChain && children.length === 0 && !depsEditable && !subtasksEditable) return null;

  const blockerRow = ({ id, task: dep, viaStage }: RelatedCard) => (
    <CardRow
      key={id}
      note={viaStage ? <span className="shrink-0 text-[10.5px] text-[var(--ink-faint)]" title={t("card.relations.viaStageHint")}>{t("card.relations.viaStage")}</span> : undefined}
      id={id}
      task={dep}
      projectId={task.project_id}
      projects={projects}
      onOpen={onOpenTask}
      warn={dep?.status === "failed" ? t("card.relations.failedHint", { id }) : undefined}
    />
  );

  const subtaskRow = (child: Task) => (
    <CardRow
      key={child.id}
      id={child.id}
      task={child}
      projectId={task.project_id}
      projects={projects}
      onOpen={onOpenTask}
      trailing={
        subtasksEditable && (
          <span className="flex opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
            <Picker
              label={t("card.relations.setStage", { id: child.id })}
              align="end"
              value={child.stage ?? 0}
              onChange={(stage: number) => onSetStage(child.id, stage === 0 ? null : stage)}
              options={[
                { value: 0, label: t("card.relations.noStage"), pinned: true },
                ...Array.from({ length: lastStage + 1 }, (_, i) => ({ value: i + 1, label: t("card.relations.stage", { n: i + 1 }) })),
              ]}
              trigger={<IconButton label={t("card.relations.setStage", { id: child.id })} icon={Layers} />}
            />
            <IconButton label={t("card.relations.detach", { id: child.id })} icon={X} onClick={() => onSetParent(child.id, null)} />
          </span>
        )
      }
    />
  );

  const editDeps = depsEditable && (
    <PickerPanel
      open={editingDeps}
      onOpenChange={setEditingDeps}
      align="end"
      className="w-[26rem] max-w-[calc(100vw-2rem)]"
      trigger={<IconButton label={t("card.relations.editWaits")} icon={blockers.length > 0 ? Pencil : Plus} />}
    >
      <div className="min-h-0 overflow-y-auto p-2.5">
        <DependsOnPicker
          candidates={allTasks.filter((other) => other.id !== task.id)}
          projectId={task.project_id}
          projects={projects}
          value={task.depends_on}
          onChange={onDepsChange}
        />
      </div>
    </PickerPanel>
  );

  return (
    <section aria-labelledby={`relations-${task.id}`} className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 id={`relations-${task.id}`} className="flex-1 text-[12px] font-medium text-[var(--ink-muted)]">
          {t("card.relations.heading")}
        </h3>
        {hasChain && (
          <Segmented
            ariaLabel={t("card.relations.viewLabel")}
            value={view}
            onChange={changeView}
            options={[
              { value: "list", label: t("card.relations.list") },
              { value: "tree", label: t("card.relations.tree") },
            ]}
          />
        )}
      </div>

      {view === "tree" && hasChain ? (
        <div className="space-y-1">
          <GroupHeading actions={editDeps}>{t("card.relations.chain")}</GroupHeading>
          <div role="tree" aria-label={t("card.relations.chain")}>
            <TreeRows nodes={tree} projectId={task.project_id} projects={projects} onOpen={onOpenTask} />
          </div>
        </div>
      ) : (
        <>
          {(blockers.length > 0 || depsEditable) && (
            <div className="space-y-px">
              <GroupHeading actions={editDeps}>
                {t("card.dependsOn.label")}
                {blockers.length > 0 && <span className="tnum font-normal">{blockers.length}</span>}
              </GroupHeading>
              {blockers.length > 0 ? blockers.map(blockerRow) : <p className="px-1.5 text-[12px] text-[var(--ink-faint)]">{t("card.dependsOn.none")}</p>}
            </div>
          )}
          {next.length > 0 && (
            <div className="space-y-px">
              <GroupHeading>
                {t("card.relations.comesNext")}
                <span className="tnum font-normal">{next.length}</span>
              </GroupHeading>
              {next.map((dep) => (
                <CardRow key={dep.id} id={dep.id} task={dep} projectId={task.project_id} projects={projects} onOpen={onOpenTask} />
              ))}
            </div>
          )}
        </>
      )}

      {(children.length > 0 || subtasksEditable) && (
        <div className="space-y-px">
          <GroupHeading
            actions={
              subtasksEditable && (
                <>
                  {onCreateSubtask && <IconButton label={t("card.relations.addSubtask")} icon={Plus} onClick={onCreateSubtask} />}
                  <Picker
                    label={t("card.relations.attach")}
                    searchable
                    align="end"
                    value={null}
                    onChange={(id: number) => onSetParent(id, task.id)}
                    empty={<p className="px-2.5 py-2 text-[12px] text-[var(--ink-muted)]">{t("card.relations.attachEmpty")}</p>}
                    options={candidates.map((c) => ({
                      value: c.id,
                      label: `#${c.id} ${c.title}`,
                      hint: c.project_id !== task.project_id ? projects?.find((p) => p.id === c.project_id)?.name : undefined,
                    }))}
                    trigger={<IconButton label={t("card.relations.attach")} icon={Link2} />}
                  />
                </>
              )
            }
          >
            {t("card.relations.subtasks")}
            {children.length > 0 && <ProgressPill {...progress} />}
          </GroupHeading>
          {children.length > 0 ? (
            stageGroups.map((group) => (
              <div key={group.stage ?? "none"} className="space-y-px">
                {staged && (
                  <div className="px-1.5 pt-1 text-[10.5px] font-medium uppercase tracking-wide text-[var(--ink-faint)]">
                    {group.stage === null ? t("card.relations.noStage") : t("card.relations.stage", { n: group.stage })}
                  </div>
                )}
                {group.tasks.map(subtaskRow)}
              </div>
            ))
          ) : (
            <p className="px-1.5 text-[12px] text-[var(--ink-faint)]">{t("card.relations.noSubtasks")}</p>
          )}
          {onWakeChange && subtasksEditable && (
            <label className="flex cursor-pointer items-center gap-2 px-1.5 pt-1 text-[12px] text-[var(--ink-muted)]" title={t("card.relations.wakeHint")}>
              <Checkbox checked={task.wake_on_children === 1} onChange={(e) => onWakeChange(e.target.checked)} />
              {t("card.relations.wake")}
            </label>
          )}
        </div>
      )}
    </section>
  );
}
