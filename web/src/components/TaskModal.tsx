import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Clock,
  PlayCircle,
  Trash2,
} from "lucide-react";
import { api, type TaskBody } from "../api";
import { useAgents } from "../agents";
import { effectiveCardSettings, useAppCardSettings } from "../cardSettings";
import { useAutosave } from "../hooks/useAutosave";
import { labelsByName, useLabels } from "../hooks/useLabels";
import { modelLabel } from "../models";
import { permissionLabel } from "../permissions";
import { composerMode, nowFromTask } from "../activity";
import { quickActionSender, resolveQuickActions } from "../quickActions";
import { QuickActionsSection } from "./QuickActionsSection";
import type { ActivityNow, Agent, Project, Task, TaskDetail } from "../types";
import { ActivityPanel } from "./ActivityPanel";
import { AgentStatusChip } from "./AgentStatusChip";
import { BaseMismatchNotice, baseMismatch, useProjectBranches } from "./cardProperties/BranchProperty";
import { PropertyRows } from "./cardProperties/CardProperties";
import type { CardPropertyValues } from "./cardProperties/types";
import { DescriptionEditor } from "./DescriptionEditor";
import { rawOffsetForView, visibleOffsetAt } from "../lib/caret";
import { DescriptionView } from "./DescriptionView";
import { NotReadyDialog } from "./NotReadyDialog";
import { CardDetails } from "./CardDetails";
import { DeliverablesSection } from "./DeliverablesSection";
import { ProgressPill, RelationsSection } from "./RelationsSection";
import { progressOf, subtasksOf } from "../relations";
import { ExecutionLog } from "./ExecutionLog";
import { WakeupsSection } from "./WakeupsSection";
import { blockerLabel, statusLabel, waitingLabel } from "../labels";
import { BLOCKER_META, STATUS_META, workIssues } from "../status";
import { isUnviewed, tracksViewed } from "../viewing";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { AutoGrowTextarea, Checkbox } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { cn } from "../lib/cn";
import { focusRing, textBox, textBoxBleed } from "../ui/tokens";
import { parseUsage } from "../usage";
import { formatDuration } from "../dates";
import { scheduleState, windowTime } from "../schedule";
import { useNow } from "../hooks/useNow";
import { useTranslation } from "../i18n";

interface Props {
  taskId: number;
  allTasks: Task[];
  /** All projects: from them, by task.project_id, the task's project is taken; its settings are
   * shown in the run parameters as inherited values. */
  projects?: Project[];
  /** Open with this field ready to fill: this is how a card refused from the board is opened. "thread"
   * opens at the end of the conversation: the owner came from "Waiting for me" to answer. */
  focusOn?: "description" | "agent" | "thread" | null;
  /** Go to another task right from the dialog, via the "after #N" badge. Without a handler the
   * badge stays a plain label. */
  onOpenTask?: (id: number) => void;
  /** Open the creation form for a subtask of this card, prefilled from it. Without a handler there is no "+". */
  onCreateSubtask?: (parent: Task) => void;
  onClose: () => void;
  onChanged: () => void;
}

/** "Subtask of #N, x/y" above the title, after multica's parent link. A parent off the board stays a number. */
function ParentLink({ parentId, allTasks, onOpenTask }: { parentId: number; allTasks: Task[]; onOpenTask?: (id: number) => void }) {
  const { t } = useTranslation();
  const parent = allTasks.find((other) => other.id === parentId);
  const progress = progressOf(subtasksOf(parentId, allTasks));
  const content = (
    <>
      <span className="shrink-0">{t("card.relations.subtaskOf")}</span>
      <span className="tnum shrink-0 font-mono">#{parentId}</span>
      {parent && <span className="truncate">{parent.title}</span>}
      {progress.total > 0 && <ProgressPill {...progress} />}
    </>
  );
  const className = "mb-1 flex max-w-full items-center gap-1.5 text-[11.5px] text-[var(--ink-muted)]";
  return parent && onOpenTask ? (
    <button
      type="button"
      aria-label={`${t("card.relations.subtaskOf")} #${parentId} ${parent.title}`}
      onClick={() => onOpenTask(parentId)}
      className={cn(className, "rounded hover:text-[var(--ink)]", focusRing)}
    >
      {content}
    </button>
  ) : (
    <p className={className}>{content}</p>
  );
}

/**
 * What a session of this card runs with. The card holds no parameters of its own: they follow the agent
 * it is tied to, and the project where the agent leaves a value empty (orc/agents.py). So this is one
 * quiet line with no controls: to run the card differently, pick another agent.
 */
function RunSummary({ agent, project }: { agent: Agent | undefined; project: Project | undefined }) {
  const { t } = useTranslation();
  const model = agent?.model || project?.default_model;
  const effort = agent?.effort || project?.default_effort;
  const mode = agent?.permission_mode || project?.default_permission_mode;
  const parts = [model && modelLabel(model), effort, mode && permissionLabel(mode)].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div className="px-1.5 text-[11px] leading-snug text-[var(--ink-faint)]" title={t("card.modal.runsWithHint")}>
      <p>{t("card.modal.runsWith", { params: parts.join(" · ") })}</p>
    </div>
  );
}

/**
 * A deferred start, as a property: when the dispatcher will take the task, and how to undo that. "Start now"
 * only removes the schedule, after which the task goes through the shared queue.
 */
function StartRow({ sched, task, now, pending, onClear }: {
  sched: NonNullable<ReturnType<typeof scheduleState>>;
  task: Task;
  now: number;
  pending: boolean;
  onClear: () => void;
}) {
  const { t, language } = useTranslation();
  const text =
    sched.kind === "missed"
      ? t("taskModal.schedule.missed")
      : task.status !== "todo"
        ? // The dispatcher does not take a task from backlog or failed: the deadline takes effect only after "To do"
          t("taskModal.schedule.notQueued", {
            time: windowTime(sched.kind === "waiting" ? sched.at : Date.parse(task.start_after ?? "") || sched.until, language, now),
          })
        : sched.kind === "waiting"
          ? t("taskModal.schedule.waiting", { duration: formatDuration(t, sched.at - now) })
          : t("taskModal.schedule.window", { time: windowTime(sched.until, language, now) });
  const startNow = sched.kind === "waiting" && task.status === "todo";
  return (
    <div data-testid="start-row" className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-1 px-1.5">
      <span className="flex items-center gap-1 pt-0.5 text-[11px] text-[var(--ink-faint)]">
        <Clock size={11} aria-hidden />
        {t("taskModal.schedule.label")}
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-[12px] leading-snug text-[var(--ink-muted)]">{text}</p>
        <Button size="sm" variant={startNow ? "primary" : "ghost"} icon={startNow ? PlayCircle : undefined} disabled={pending} onClick={onClear}>
          {startNow ? t("taskModal.schedule.startNow") : t("taskModal.schedule.clear")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The description, edited in place: a click on the text turns it into the field, a click anywhere
 * else turns it back, and saving is the autosave's business. There is no edit mode to enter or leave.
 *
 * It ends on a pointer press outside rather than on blur: picking an image opens a system dialog,
 * which takes the focus away while the person is still editing.
 */
function InlineDescription({ value, onChange, onCommit, editable, editing, onEditingChange }: {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  editable: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  // What the view knew at the click: how tall it was and which place of the text was hit. The field
  // opens with the same height and the caret there, so nothing on the screen shifts.
  const [entry, setEntry] = useState<{ caret?: number; minHeight?: number }>({});

  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        onCommit();
        onEditingChange(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [editing, onCommit, onEditingChange]);

  /** Enter edit mode from the view, taking its height and, for a click, the place that was hit. */
  function openEditor(point?: { x: number; y: number }) {
    const el = view.current;
    const visible = el && point ? visibleOffsetAt(el, point.x, point.y) : null;
    setEntry({
      minHeight: el?.getBoundingClientRect().height,
      caret: visible === null ? undefined : rawOffsetForView(value, visible),
    });
    onEditingChange(true);
  }

  if (editable && editing) {
    return (
      <div ref={box} onBlur={onCommit} className="[overflow-anchor:none]">
        <DescriptionEditor
          label={t("taskForm.descriptionLabel")}
          placeholder={t("taskForm.descriptionPlaceholder")}
          value={value}
          onChange={onChange}
          autoFocus
          bleed
          initialCaret={entry.caret}
          minHeight={entry.minHeight}
          textareaClassName="min-h-0"
        />
      </div>
    );
  }
  // The view and the field are one box: the same border (here invisible), padding and type, so the
  // first line of text stays where it was when the field opens.
  const viewBox = cn(textBox, textBoxBleed, "min-h-0 rounded-[var(--radius-sm)] border-transparent");
  if (!editable) {
    return value ? (
      <DescriptionView text={value} className={viewBox} />
    ) : (
      <p className={cn(viewBox, "text-[12px] text-[var(--ink-faint)]")}>{t("taskModal.noDescription")}</p>
    );
  }
  return (
    <div
      ref={view}
      role="button"
      tabIndex={0}
      aria-label={t("card.modal.editDescription")}
      onClick={(e) => {
        // A link or a picture in the text does its own job, and selecting text to copy it is not a wish to edit
        if ((e.target as Element).closest("a,button,img") || window.getSelection()?.toString()) return;
        openEditor({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          openEditor();
        }
      }}
      className={cn(viewBox, "cursor-text transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--ink)_5%,transparent)]", focusRing)}
    >
      {value ? <DescriptionView text={value} plain /> : <span className="text-[13px] text-[var(--ink-faint)]">{t("card.modal.emptyDescription")}</span>}
    </div>
  );
}

/**
 * The whole task card: what to do on the left with the thread under it, what it is on the right. Nothing
 * here needs an edit mode. The title and the description are edited where they are written, the
 * properties where they are shown, and everything saves itself.
 *
 * The card describes the work once. Everything between the owner and the agent happens in the thread
 * under the description: a question, a request, a failure, and the one composer pinned to the bottom of the
 * column. Nothing about the conversation sits above the task.
 */
export function TaskModal({ taskId, allTasks, projects, focusOn = null, onOpenTask, onCreateSubtask, onClose, onChanged }: Props) {
  const { t } = useTranslation();
  // The hook goes before the early return "task is still loading" (rules of hooks).
  const now = useNow();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const { labels: knownLabels } = useLabels();
  // An attempt to send an unready card to work: we show a dialog with the fix instead of the request.
  const [notReady, setNotReady] = useState(false);
  const [editingDescription, setEditingDescription] = useState(focusOn === "description");
  const [openProperty, setOpenProperty] = useState<string | null>(focusOn === "agent" ? "agent" : null);
  const [saveState, setSaveState] = useState<"saving" | "saved" | null>(null);
  const [activityNow, setActivityNow] = useState<ActivityNow | null>(null);
  // The card's scrolling body: the thread follows its end there, and the composer pins to its bottom.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const jumpToEnd = useRef<(() => void) | null>(null);
  // Text typed in the composer, or a command of it in flight: a stray click must not close the card.
  const [composerBusy, setComposerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Whether to delete the branch and the working copy together with the card. Yes by default:
  // otherwise every deleted task leaves behind orc/task-N and a copy of the repository that nobody
  // will remember later. Unchecked when the work in the branch is to be sorted out by hand.
  const [dropWorktree, setDropWorktree] = useState(true);

  const activitySource = useMemo(() => ({ kind: "task" as const, id: taskId }), [taskId]);

  // Bumped by every edit: a read that started before it answers with the old card and must not win.
  const edits = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(() => {
    const seen = edits.current;
    return api
      .getTask(taskId)
      .then((fresh) => {
        if (seen === edits.current) setTask(fresh);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [taskId]);

  /** One edit of the card, saved at once. Throws on failure: the autosave keeps the text as unsaved. */
  const save = useCallback(
    async (fields: Omit<TaskBody, "blocker">) => {
      setError(null);
      setSaveState("saving");
      edits.current += 1;
      try {
        const fresh = await api.patchTask(taskId, fields);
        edits.current += 1;
        setTask(fresh);
        setSaveState("saved");
        onChanged();
      } catch (e) {
        setSaveState(null);
        const message = e instanceof Error ? e.message : String(e);
        // The card may be closed by now, with the text typed into it: this must not pass silently
        if (mounted.current) setError(message);
        else toast.error(t("card.modal.saveFailed", { error: message }));
        throw e;
      }
    },
    [taskId, onChanged, t],
  );

  /** A property changed in the card: shown at once, and on a refusal the card is read back. */
  const changeProperties = (patch: Partial<CardPropertyValues>) => {
    // The card holds label objects, the request carries names: show the new ones at once, with their colours
    const { labels: names, ...rest } = patch;
    setTask((current) => (current ? { ...current, ...rest, ...(names ? { labels: labelsByName(names, knownLabels) } : {}) } : current));
    save(patch).catch(() => void load());
  };

  const title = useAutosave({
    value: task?.title ?? "",
    save: (next) => save({ title: next.trim() }),
    valid: (next) => next.trim() !== "",
  });
  const description = useAutosave({ value: task?.description ?? "", save: (next) => save({ description: next }) });
  const flushDescription = description.flush;
  const commitDescription = useCallback(() => void flushDescription(), [flushDescription]);
  // The card lives long, and the task under it changes without us: the agent asked a question,
  // requested permission, the dispatcher removed the badge. The board sees this by polling, and its
  // snapshot of the task is a signal to re-read the details, otherwise the open dialog would show a
  // minute-old state.
  const live = allTasks.find((task) => task.id === taskId);
  const liveStamp = live ? `${live.updated_at}|${live.status}|${live.blocker ?? ""}|${live.input_request?.id ?? ""}|${live.outbox_state ?? ""}` : "";
  useEffect(() => {
    void load();
  }, [load, liveStamp]);

  // Result viewing works like email: opened the card of a finished task, so it is viewed. The
  // decision is made once, from the first snapshot of the task: if the owner immediately cleared
  // the check mark ("I'll come back later"), the dialog must not put it back, and a task that
  // closed while the dialog was already open stays unviewed: nobody has read its report yet. The
  // project may not exist yet (the list loads after F5): then we wait for it without deciding.
  const project = task ? projects?.find((p) => p.id === task.project_id) : undefined;
  const appCardSettings = useAppCardSettings();
  const cardSettings = effectiveCardSettings(project, appCardSettings);
  const agent = useAgents().find((a) => a.id === task?.agent_id);
  // Only while the base can still change (TARGET_BRANCH_EDITABLE in orc/api/common.py)
  const beforeWork = task?.status === "backlog" || task?.status === "todo" || task?.status === "failed";
  const branches = useProjectBranches(task?.project_id ?? 0, beforeWork);
  const autoViewed = useRef(false);
  useEffect(() => {
    if (!task || !project || autoViewed.current) return;
    autoViewed.current = true;
    if (!tracksViewed(project) || !isUnviewed(task)) return;
    api
      .markViewed(task.id, true)
      .then((fresh) => {
        setTask(fresh);
        onChanged();
      })
      .catch(() => {
        // The mark is a convenience, not an owner's action: if it failed, the card simply stays
        // unviewed, there is nothing to scare with an error here.
      });
  }, [task, project, onChanged]);

  // Returns true/false instead of always resolving: this way the calling button can clear the field
  // or close the form only on real success, not on any outcome. pending blocks a repeated click
  // while the request is in flight (a merge for "Reply"/"Redo" can take seconds).
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    setPending(true);
    try {
      await action();
      await load();
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setPending(false);
    }
  }

  // The card's own idea of the session, until the feed answers: the composer must not wait for a poll
  const fallbackNow = useMemo(() => (task ? nowFromTask(task) : null), [task]);

  const change = (open: boolean) => {
    if (!open) onClose();
  };

  /** Deletion is the only action after which there is nothing to reload the card for: the task is
   * gone, the dialog closes. So it does not go through run(). */
  async function remove(force: boolean) {
    setError(null);
    setPending(true);
    try {
      await api.deleteTask(taskId, { force, dropWorktree });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    } finally {
      setPending(false);
    }
  }

  if (!task) {
    return (
      <Modal open onOpenChange={change} title={t("taskModal.loadingTitle")} titleSlot={<span className="block h-[18px]" />} size="card">
        <p className="py-8 text-center text-[12px] text-[var(--ink-muted)]">{error ?? t("common.loading")}</p>
      </Modal>
    );
  }

  const meta = STATUS_META[task.status];
  const StatusIcon = meta.icon;
  const blockerMeta = task.blocker ? BLOCKER_META[task.blocker] : null;
  const usage = parseUsage(task.usage_json);
  // Emergency exit from work is the same as dragging the card into "Done" (Board.tsx). The button
  // is needed here because a stuck task is first opened and read, not dragged: there is no way to
  // learn about the mouse move while looking at a motionless card.
  const stuck = task.status === "in_progress" || task.status === "verifying" || task.status === "merging";
  const archived = Boolean(task.archived_at);
  // The same state the composer reads, so a quick action from the panel and one from "/" take the same road
  const quickNow = activityNow ?? fallbackNow;
  const quickActions = resolveQuickActions(cardSettings, t);
  const quickSend = quickNow ? quickActionSender(composerMode("task", quickNow, archived), quickNow, task.id) : null;
  const sched = scheduleState(task, now);
  const propertyValues: CardPropertyValues = {
    agent_id: task.agent_id ?? null,
    priority: task.priority,
    target_branch: task.target_branch,
    depends_on: task.depends_on,
    labels: (task.labels ?? []).map((l) => l.name),
    start_date: task.start_date ?? null,
    due_date: task.due_date ?? null,
  };
  const mismatch = baseMismatch(allTasks, task.depends_on, task.project_id, task.target_branch);
  const issues = workIssues({ agent_id: task.agent_id, routine_id: task.routine_id, description: description.draft });

  /** Sending to work: an unready card gets a dialog with the fix, otherwise the server would refuse. */
  const toWork = (action: () => Promise<unknown>) => {
    if (issues.length > 0) {
      setNotReady(true);
      return;
    }
    // The status goes after the text: the server checks the description the card holds at that moment
    void run(async () => {
      await description.flush();
      await action();
    });
  };
  // Who waits for this task: after deletion the link disappears, and those cards will go on their
  // own.
  const dependents = allTasks.filter((t) => t.id !== task.id && t.depends_on.includes(task.id));

  return (
    <>
      <Modal
        open
        onOpenChange={change}
        size="card"
        flush
        sticky={pending || composerBusy}
        bodyRef={setBody}
        title={task.title}
        titleSlot={
          <>
          {task.parent_task_id != null && <ParentLink parentId={task.parent_task_id} allTasks={allTasks} onOpenTask={onOpenTask} />}
          <AutoGrowTextarea
            aria-label={t("taskForm.titleLabel")}
            readOnly={archived}
            value={title.draft}
            // A title is one paragraph that wraps instead of being cut off, and it has no line breaks
            onChange={(e) => title.change(e.target.value.replace(/\s*\n\s*/g, " "))}
            onBlur={() => (title.draft.trim() === "" ? title.revert() : void title.flush())}
            onKeyDown={(e) => {
              // Enter must not reach anything else: a title has no second line, and pressing it means "done"
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            wrapperClassName="-mx-1"
            className="min-h-0 rounded-[var(--radius-sm)] border-0 bg-transparent px-1 py-0 text-[15px] font-semibold leading-tight text-[var(--ink)] hover:bg-transparent read-only:cursor-default not-read-only:hover:bg-[color-mix(in_oklab,var(--ink)_5%,transparent)] focus:bg-[var(--sunken)] focus:ring-0"
          />
          </>
        }
        subtitle={
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="tnum font-mono text-[11px] text-[var(--ink-faint)]">#{task.id}</span>
            <Badge icon={StatusIcon} tone={meta.chip}>
              {statusLabel(t, task.status)}
            </Badge>
            {archived && <Badge icon={Archive}>{t("taskCard.archived")}</Badge>}
            {task.blocker && blockerMeta && (
              <Badge icon={blockerMeta.icon} tone={blockerMeta.chip}>
                {task.blocker === "needs_input" ? waitingLabel(t, task) : blockerLabel(t, task.blocker)}
              </Badge>
            )}
            {/* The card that created this one may be gone by now: the mark stays, the link does not. When it is also
               the parent, the link above the title already says it. */}
            {task.created_by_task_id != null && task.created_by_task_id !== task.parent_task_id && (
              <Badge
                mono
                title={t("taskModal.openDepTitle", { id: task.created_by_task_id })}
                onClick={onOpenTask && allTasks.some((other) => other.id === task.created_by_task_id) ? () => onOpenTask(task.created_by_task_id as number) : undefined}
              >
                {t("taskModal.createdBy", { id: task.created_by_task_id })}
              </Badge>
            )}
            {saveState && (
              <span aria-live="polite" className="text-[11px] text-[var(--ink-faint)]">
                {saveState === "saving" ? t("card.modal.saving") : t("card.modal.saved")}
              </span>
            )}
          </div>
        }
        actions={
          <>
            {/* The chip says what the agent is doing; a click goes to where it is said, the end of the thread. */}
            <button type="button" aria-label={t("card.modal.toThreadEnd")} className={cn("rounded-full", focusRing)} onClick={() => jumpToEnd.current?.()}>
              <AgentStatusChip task={task} now={activityNow} />
            </button>
            {/* The viewing check mark is only on a finished task and only where viewing is
               tracked. It is also the way to return the task to unviewed, to deal with it
               later. */}
            {task.status === "done" && !archived && tracksViewed(project) && (
              <label
                className="flex cursor-pointer select-none items-center gap-1.5 whitespace-nowrap pr-1 text-[12px] text-[var(--ink-muted)]"
                title={t("viewing.modalTitle")}
              >
                <Checkbox
                  checked={!isUnviewed(task)}
                  disabled={pending}
                  onChange={(e) => {
                    const viewed = e.target.checked;
                    void run(() => api.markViewed(task.id, viewed));
                  }}
                />
                {t("viewing.viewed")}
              </label>
            )}
          </>
        }
      >
        <div className="grid min-h-full md:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-4 px-5 py-4">
          {error && (
            <p className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
              {error}
            </p>
          )}

          {mismatch.length > 0 && task.target_branch && beforeWork && (
            <BaseMismatchNotice branches={mismatch} branch={task.target_branch} onFix={(target_branch) => changeProperties({ target_branch })} />
          )}

          <section>
            <h3 className="mb-1 text-[12px] font-medium text-[var(--ink-muted)]">{t("taskModal.descriptionHeading")}</h3>
            <InlineDescription
              value={description.draft}
              onChange={description.change}
              onCommit={commitDescription}
              editable={beforeWork && !archived}
              editing={editingDescription}
              onEditingChange={setEditingDescription}
            />
          </section>

          <RelationsSection
            task={task}
            allTasks={allTasks}
            projects={projects}
            depsEditable={beforeWork && !archived}
            subtasksEditable={!archived}
            onDepsChange={(depends_on) => changeProperties({ depends_on })}
            onOpenTask={onOpenTask}
            onCreateSubtask={onCreateSubtask ? () => onCreateSubtask(task) : undefined}
            onSetParent={(childId, parentId) => void run(() => api.patchTask(childId, { parent_task_id: parentId }))}
            onWakeChange={(wake) => void run(() => api.patchTask(task.id, { wake_on_children: wake ? 1 : 0 }))}
            onSetStage={(childId, stage) => void run(() => api.patchTask(childId, { stage }))}
          />

          {/* The thread, then the composer as the last child of this column, pinned to its bottom: see ActivityPanel. */}
          <h3 className="mb-1! text-[12px] font-medium text-[var(--ink-muted)]">{t("taskModal.commentsHeading")}</h3>
          <ActivityPanel
            source={activitySource}
            scrollRoot={body}
            startAtEnd={focusOn === "thread" || Boolean(task.input_request)}
            archived={archived}
            fallbackNow={fallbackNow}
            fallbackComments={task.comments}
            onNow={setActivityNow}
            onChanged={() => {
              void load();
              onChanged();
            }}
            startWork={toWork}
            onForceClose={() => setClosing(true)}
            quickActions={quickActions}
            onBusy={setComposerBusy}
            jumpRef={jumpToEnd}
          />
        </div>

        {/* The column keeps its place while the thread scrolls: a property is changed in the middle
           of reading, not after scrolling back up. */}
        <aside className="border-t border-[var(--line)] md:border-l md:border-t-0">
          <div className="space-y-3 px-3 py-3 md:sticky md:top-0 md:max-h-[calc(min(88vh,52rem)-5.5rem)] md:overflow-y-auto">
            <PropertyRows
              settings={cardSettings}
              status={archived ? "done" : task.status}
              onStatusChange={archived ? undefined : (to) => (to === "todo" ? toWork(() => api.patchTask(task.id, { status: to })) : void run(() => api.patchTask(task.id, { status: to })))}
              statusPending={pending}
              values={propertyValues}
              onChange={changeProperties}
              openId={openProperty}
              onOpenIdChange={setOpenProperty}
              projectId={task.project_id}
              projects={projects}
              allTasks={allTasks}
              taskId={task.id}
              branches={branches}
              onOpenTask={onOpenTask}
            />
            {sched && (
              <StartRow
                sched={sched}
                task={task}
                now={now}
                pending={pending}
                onClear={() => void run(() => api.patchTask(task.id, { start_after: null, start_before: null }))}
              />
            )}
            <RunSummary agent={agent} project={project} />
            <QuickActionsSection actions={quickActions} send={quickSend} pending={pending} run={run} />
            <WakeupsSection task={task} pending={pending} onAction={run} onOpenTask={onOpenTask} />
            <ExecutionLog task={task} usage={usage} pending={pending} onAction={run} onOpenThread={() => jumpToEnd.current?.()} />
            <DeliverablesSection task={task} />
            <CardDetails task={task} allTasks={allTasks} onOpenTask={onOpenTask} />
            {/* Card cleanup is last and quiet: one does not get here by accident, and "archive" comes
               before "delete" because it is almost always the one needed. */}
            <div className="flex flex-wrap gap-1 border-t border-[var(--line)] pt-2">
              {/* Verifying, merging and failed cards offer it in the composer, next to what else can be done */}
              {task.status === "in_progress" && (
                <Button size="sm" variant="ghost" icon={CheckCircle2} disabled={pending} title={t("taskModal.stuckHint")} onClick={() => setClosing(true)}>
                  {t("app.forceCloseConfirm")}
                </Button>
              )}
              {archived ? (
                <Button size="sm" variant="ghost" icon={ArchiveRestore} loading={pending} title={t("taskModal.archivedHint")} onClick={() => void run(() => api.unarchive(task.id))}>
                  {t("taskModal.unarchive")}
                </Button>
              ) : (
                !stuck && (
                  <Button size="sm" variant="ghost" icon={Archive} loading={pending} title={t("taskModal.archiveHint")} onClick={() => void run(() => api.archive(task.id))}>
                    {t("taskModal.archive")}
                  </Button>
                )
              )}
              <Button size="sm" variant="ghost" icon={Trash2} disabled={pending} title={stuck ? t("taskModal.stuckArchiveHint") : undefined} onClick={() => setDeleting(true)}>
                {t("common.delete")}
              </Button>
            </div>
          </div>
        </aside>
        </div>
      </Modal>

      <NotReadyDialog
        open={notReady}
        issues={issues}
        taskId={task.id}
        taskTitle={task.title}
        onClose={() => setNotReady(false)}
        onFix={() => {
          setNotReady(false);
          if (issues.includes("assignee")) setOpenProperty("agent");
          else setEditingDescription(true);
        }}
      />

      <Confirm
        open={closing}
        title={t("app.forceCloseTitle")}
        confirmLabel={t("app.forceCloseConfirm")}
        pending={pending}
        onCancel={() => setClosing(false)}
        onConfirm={() =>
          void run(() => api.patchTask(task.id, { status: "done", force: true })).then((ok) => {
            if (ok) setClosing(false);
          })
        }
      >
        <p>{t("taskModal.closeBody1")}</p>
        <p className="text-[var(--ink-muted)]">
          {t("app.forceCloseBody2", { branch: task.branch ?? t("app.forceCloseBranchFallback") })}
        </p>
      </Confirm>

      <Confirm
        open={deleting}
        title={t("taskModal.deleteTitle")}
        confirmLabel={t("common.delete")}
        pending={pending}
        onCancel={() => setDeleting(false)}
        onConfirm={() => void remove(stuck)}
      >
        <p>{t("taskModal.deleteBody1", { id: task.id, title: task.title })}</p>
        {stuck && (
          <p className="text-[var(--danger)]">
            {t("taskModal.deleteStuckWarning")}
          </p>
        )}
        {dependents.length > 0 && (
          <p className="text-[var(--ink-muted)]">
            {t("taskModal.deleteDependents", { ids: dependents.map((d) => `#${d.id}`).join(", ") })}
          </p>
        )}
        {(task.branch || task.worktree_path) && (
          <label className="flex cursor-pointer items-start gap-2 text-[var(--ink-muted)]">
            <Checkbox
              className="mt-0.5"
              checked={dropWorktree}
              disabled={pending}
              onChange={(e) => setDropWorktree(e.target.checked)}
            />
            <span>{t("taskModal.deleteWorktreeLabel", { branch: task.branch ?? t("app.forceCloseBranchFallback") })}</span>
          </label>
        )}
      </Confirm>
    </>
  );
}
