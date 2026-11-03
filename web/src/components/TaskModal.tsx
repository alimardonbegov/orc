import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  FileText,
  FolderGit2,
  GitBranch,
  MessageSquarePlus,
  OctagonPause,
  Pencil,
  PlayCircle,
  RotateCcw,
  Send,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { api } from "../api";
import type { Project, Task, TaskDetail } from "../types";
import { DescriptionEditor } from "./DescriptionEditor";
import { DescriptionView } from "./DescriptionView";
import { EmptyDescriptionDialog } from "./EmptyDescriptionDialog";
import { InputRequestPanel } from "./InputRequestPanel";
import { TaskForm, type TaskFormValues } from "./TaskForm";
import { TaskTimeline } from "./TaskTimeline";
import { UsageSection } from "./UsageSection";
import { blockerLabel, priorityLabel, statusLabel, waitingLabel } from "../labels";
import { BLOCKER_META, STATUS_META, hasDescription } from "../status";
import { isUnviewed, tracksViewed } from "../viewing";
import { Badge } from "../ui/Badge";
import { Button, IconButton } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { Checkbox, Select } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { cn } from "../lib/cn";
import { parseUsage } from "../usage";
import { formatDuration } from "../dates";
import { scheduleState, windowTime } from "../schedule";
import { useNow } from "../hooks/useNow";
import { useTranslation, type TFunction } from "../i18n";

interface Props {
  taskId: number;
  allTasks: Task[];
  /** All projects: from them, by task.project_id, the task's project is taken; its settings are
   * shown in the run parameters as inherited values. */
  projects?: Project[];
  /** Open the card straight in the editor: this is how it is opened "for repair" of an empty
   * description. */
  initialEditing?: boolean;
  /** Go to another task right from the dialog, via the "after #N" badge. Without a handler the
   * badge stays a plain label. */
  onOpenTask?: (id: number) => void;
  onClose: () => void;
  onChanged: () => void;
}

function authorLabel(t: TFunction, author: string): string {
  return author === "user" || author === "orc" || author === "claude" ? t(`taskModal.author.${author}`) : author;
}

/** Label of a conversation turn: for the archived report a separate label, not "agent", so as not
 * to confuse it with a fresh message from it. */
function commentLabel(t: TFunction, c: TaskDetail["comments"][number]): string {
  if (c.kind === "report") return t("taskModal.reportArchivedLabel");
  if (c.kind === "answer") return t("taskModal.answerAuthor");
  return authorLabel(t, c.author);
}

/** Machine string with a copy button: branches, paths and commands are copied more often than read. */
function CopyRow({ icon: Icon, label, value }: { icon: typeof GitBranch; label: string; value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 py-1">
      <Icon size={12} className="shrink-0 text-[var(--ink-faint)]" aria-hidden />
      <span className="w-24 shrink-0 text-[11px] text-[var(--ink-faint)]">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ink-muted)]" title={value}>
        {value}
      </code>
      <IconButton
        icon={copied ? Check : Copy}
        label={copied ? t("taskModal.copied") : t("taskModal.copyLabel", { label })}
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {
              // Clipboard unavailable (no https, permission denied): the string is still visible
              // and can be selected.
            },
          );
        }}
      />
    </div>
  );
}

/**
 * Task base branch: its working branch is branched from it and the result will go into it.
 *
 * A separate row, not only a badge in the header: the branch name used to stand without a label,
 * and it was impossible to tell from it what branch it is at all and where to change it.
 */
function TargetBranchRow({
  task,
  editable,
  pending,
  onChange,
}: {
  task: TaskDetail;
  /** The base can be changed only while the worktree has not been created yet (backlog / to do /
   * failed). */
  editable: boolean;
  pending: boolean;
  onChange: (branch: string) => void;
}) {
  const { t } = useTranslation();
  const [branches, setBranches] = useState<string[]>([]);
  useEffect(() => {
    if (!editable) return;
    let alive = true;
    api
      .branches(task.project_id)
      .then((b) => alive && setBranches(b.branches))
      .catch(() => alive && setBranches([]));
    return () => {
      alive = false;
    };
  }, [editable, task.project_id]);

  const value = task.target_branch ?? "";
  return (
    <div className="py-1">
      <div className="flex min-w-0 items-center gap-2">
        <GitBranch size={12} className="shrink-0 text-[var(--ink-faint)]" aria-hidden />
        <span className="w-24 shrink-0 text-[11px] text-[var(--ink-faint)]">{t("taskModal.baseBranchRowLabel")}</span>
        {editable ? (
          <Select
            aria-label={t("taskForm.baseBranchLabel")}
            className="h-7 max-w-56 font-mono text-[11px]"
            value={value}
            disabled={pending}
            onChange={(e) => e.target.value !== value && onChange(e.target.value)}
          >
            {value && !branches.includes(value) && <option value={value}>{t("taskForm.branchGone", { branch: value })}</option>}
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        ) : (
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ink-muted)]">{value || "—"}</code>
        )}
      </div>
      <p className="mt-0.5 pl-[7.5rem] text-[11px] leading-snug text-[var(--ink-faint)]">
        {editable ? t("taskModal.baseBranchHintEditable") : t("taskModal.baseBranchHintLocked")}
      </p>
    </div>
  );
}

/**
 * The whole task card: description, blockers, report, technical lines and conversation.
 *
 * The order of blocks is subordinated to a single question: "do I need to do something". So the
 * "agent is waiting for a reply" block stands above the description: when it is there, there is no
 * need to read anything else.
 */
export function TaskModal({ taskId, allTasks, projects, initialEditing = false, onOpenTask, onClose, onChanged }: Props) {
  const { t, language } = useTranslation();
  // The hook goes before the early return "task is still loading" (rules of hooks).
  const now = useNow();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [editing, setEditing] = useState(initialEditing);
  // An attempt to send a card without a description to work: we show a dialog instead of the
  // request.
  const [emptyDesc, setEmptyDesc] = useState(false);
  const [answer, setAnswer] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Whether to delete the branch and the working copy together with the card. Yes by default:
  // otherwise every deleted task leaves behind orc/task-N and a copy of the repository that nobody
  // will remember later. Unchecked when the work in the branch is to be sorted out by hand.
  const [dropWorktree, setDropWorktree] = useState(true);

  const load = useCallback(
    () =>
      api
        .getTask(taskId)
        .then(setTask)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
    [taskId],
  );
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
      <Modal open onOpenChange={change} title={t("taskModal.loadingTitle")} size="lg">
        <p className="py-8 text-center text-[12px] text-[var(--ink-muted)]">{error ?? t("common.loading")}</p>
      </Modal>
    );
  }

  const meta = STATUS_META[task.status];
  const StatusIcon = meta.icon;
  const blockerMeta = task.blocker ? BLOCKER_META[task.blocker] : null;
  // A note stays a note, but the same text can be sent to Claude. For a running task this is answer
  // (stop + resume of the same session), for a finished one it is rework, which returns the card to
  // "To do" and continues the previous session. A task under quota is not touched: the dispatcher
  // will resume it itself on schedule. The field may not come from an old server: the card must not
  // crash because of that.
  const outbox = task.outbox ?? [];
  const sendKind: "answer" | "rework" | null =
    task.status === "in_progress" && task.blocker !== "quota" ? "answer" : task.status === "done" ? "rework" : null;
  const report = task.report_json ? (JSON.parse(task.report_json) as { summary: string; notes: string }) : null;
  const usage = parseUsage(task.usage_json);
  // A failed task is also allowed to be edited: its rerun builds the prompt anew, and if it stopped
  // because of an empty description, there is nowhere else to add it (the same status list as for
  // the base branch below).
  const editable = (task.status === "backlog" || task.status === "todo" || task.status === "failed") && !editing;
  // The base can be changed for a failed task too: its rerun will create the worktree anew (the
  // same list as TARGET_BRANCH_EDITABLE in orc/api.py).
  const branchEditable = task.status === "backlog" || task.status === "todo" || task.status === "failed";
  // Emergency exit from work is the same as dragging the card into "Done" (Board.tsx). The button
  // is needed here because a stuck task is first opened and read, not dragged: there is no way to
  // learn about the mouse move while looking at a motionless card.
  const stuck = task.status === "in_progress" || task.status === "verifying" || task.status === "merging";
  const archived = Boolean(task.archived_at);
  const sched = scheduleState(task, now);
  // Who waits for this task: after deletion the link disappears, and those cards will go on their
  // own.
  const dependents = allTasks.filter((t) => t.id !== task.id && t.depends_on.includes(task.id));

  return (
    <>
      <Modal
        open
        onOpenChange={change}
        size="lg"
        sticky={editing || pending}
        title={task.title}
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
            {task.priority !== "normal" && <Badge>{t("taskModal.priorityBadge", { priority: priorityLabel(t, task.priority) })}</Badge>}
            {task.target_branch && (
              <Badge icon={GitBranch} mono title={t("taskCard.branchTitle", { branch: task.target_branch })}>
                {task.target_branch}
              </Badge>
            )}
            {/* The blocker badge leads to the blocking task itself: the question "what are
               we waiting for?" is most often asked right from here. A blocker from another
               repository is labelled with its project, otherwise someone else's "#12" cannot be
               told apart from your own. */}
            {task.depends_on.map((d) => {
              const dep = allTasks.find((task2) => task2.id === d);
              const foreign = dep && dep.project_id !== task.project_id ? projects?.find((p) => p.id === dep.project_id) : null;
              return (
                <Badge
                  key={d}
                  mono
                  title={foreign ? t("taskModal.openDepTitleForeign", { id: d, project: foreign.name }) : t("taskModal.openDepTitle", { id: d })}
                  label={foreign ? t("taskModal.dependsOnForeignLabel", { id: d, project: foreign.name }) : undefined}
                  onClick={onOpenTask ? () => onOpenTask(d) : undefined}
                >
                  {t("taskCard.dependsOn", { id: d })}
                  {foreign && <span className="ml-1 font-sans text-[var(--ink-faint)]">· {foreign.name}</span>}
                </Badge>
              );
            })}
          </div>
        }
        actions={
          <>
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
            {editable && <IconButton icon={Pencil} label={t("common.edit")} size="sm" onClick={() => setEditing(true)} />}
          </>
        }
      >
        <div className="space-y-4">
          {error && (
            <p className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
              {error}
            </p>
          )}

          {/* The card waits in the backlog: we offer to start it from here, without dragging
             between columns (the same transition as the drag backlog->todo in Board.tsx). */}
          {task.status === "backlog" && !editing && (
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2">
              <p className="min-w-40 flex-1 text-[12px] leading-relaxed text-[var(--ink-muted)]">
                {t("taskModal.backlogHint")}
              </p>
              <Button
                variant="primary"
                icon={PlayCircle}
                loading={pending}
                onClick={() => {
                  // The description goes to work, not the title: there is nothing to send if it is
                  // empty. The same refusal exists on the server; here it is caught earlier to
                  // offer the editor right away (see EmptyDescriptionDialog).
                  if (!hasDescription(task)) {
                    setEmptyDesc(true);
                    return;
                  }
                  void run(() => api.patchTask(task.id, { status: "todo" }));
                }}
              >
                {pending ? t("taskModal.sending") : t("taskModal.toWork")}
              </Button>
            </div>
          )}

          {/* Deferred start: when the dispatcher will take the task and how to cancel it.
             "Run now" simply removes the schedule: then the task goes through the shared queue. */}
          {sched && !editing && (
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2">
              <Clock size={13} aria-hidden className="text-[var(--ink-faint)]" />
              <p className="min-w-40 flex-1 text-[12px] leading-relaxed text-[var(--ink-muted)]">
                {sched.kind === "missed"
                  ? t("taskModal.schedule.missed")
                  : task.status !== "todo"
                    ? // The dispatcher does not take a task from backlog or failed: the deadline takes effect only after "To do"
                      t("taskModal.schedule.notQueued", {
                        time: windowTime(sched.kind === "waiting" ? sched.at : Date.parse(task.start_after ?? "") || sched.until, language, now),
                      })
                    : sched.kind === "waiting"
                      ? t("taskModal.schedule.waiting", { duration: formatDuration(t, sched.at - now) })
                      : t("taskModal.schedule.window", { time: windowTime(sched.until, language, now) })}
              </p>
              {(sched.kind === "waiting" && task.status === "todo") || sched.kind === "missed" ? (
                <Button
                  variant={sched.kind === "waiting" ? "primary" : undefined}
                  icon={sched.kind === "waiting" ? PlayCircle : undefined}
                  loading={pending}
                  onClick={() => void run(() => api.patchTask(task.id, { start_after: null, start_before: null }))}
                >
                  {sched.kind === "waiting" ? t("taskModal.schedule.startNow") : t("taskModal.schedule.clear")}
                </Button>
              ) : null}
            </div>
          )}

          {/* The agent stopped and waits for a human: the very top of the dialog. A hook
             request (permission, question with options, plan) is drawn with its own form;
             without it, the general reply field, which goes into the session via stop and
             resume. */}
          {task.input_request && (
            <InputRequestPanel
              request={task.input_request}
              pending={pending}
              onDecide={(decision) => run(() => api.answerInput(task.id, task.input_request!.id, decision))}
            />
          )}
          {task.blocker === "needs_input" && !task.input_request && (
            <section className="overflow-hidden rounded-[var(--radius-sm)] border border-[color-mix(in_oklab,var(--st-blocked)_40%,transparent)]">
              <div className="flex items-center gap-1.5 bg-[color-mix(in_oklab,var(--st-blocked)_14%,transparent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--st-blocked)]">
                <BLOCKER_META.needs_input.icon size={13} aria-hidden />
                {t("taskModal.agentWaitingHeading")}
              </div>
              <div className="space-y-2 p-3">
                {/* Without a hook request, this is the agent's whole final message: it can
                   run a couple of screens, so it has its own scroll so that the reply field
                   does not slide down. */}
                <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed">{task.blocker_detail}</p>
                <DescriptionEditor
                  label={t("taskModal.answerLabel")}
                  textareaClassName="min-h-20"
                  placeholder={t("taskModal.answerLabel")}
                  value={answer}
                  onChange={setAnswer}
                />
                {/* The command to attach to the session lives below, in the machine-lines
                   block: there is no need to duplicate it here, and the space under the reply
                   is needed by the button. */}
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="primary"
                    loading={pending}
                    disabled={!answer.trim()}
                    onClick={() =>
                      void run(() => api.addComment(task.id, answer.trim(), "answer")).then((ok) => {
                        if (ok) setAnswer("");
                      })
                    }
                  >
                    {pending ? t("taskModal.sending") : t("taskModal.reply")}
                  </Button>
                </div>
              </div>
            </section>
          )}

          {outbox.length > 0 && (
            <section className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--line-strong)]">
              <div className="flex items-center gap-1.5 bg-[var(--sunken)] px-3 py-1.5 text-[12px] font-semibold text-[var(--ink)]">
                <Send size={13} aria-hidden />
                {task.outbox_state === "stalled"
                  ? t("taskModal.outboxStalled")
                  : task.outbox_state === "stopping"
                    ? t("taskModal.outboxStopping")
                    : t("taskModal.outboxWaiting")}
              </div>
              <div className="space-y-2 p-3">
                {outbox.map((m) => (
                  <DescriptionView key={m.id} text={m.body} compact />
                ))}
                {/* Soft delivery waits for the nearest tool call. If waiting gets tiresome,
                   we interrupt the session: the same text goes as a resume, but with a stop. */}
                {outbox.some((m) => m.mode === "soft") && (
                  <Button
                    icon={OctagonPause}
                    loading={pending}
                    onClick={() => void run(() => api.addComment(task.id, outbox[0].body, "answer", "interrupt"))}
                  >
                    {pending ? t("taskModal.sending") : t("taskModal.interruptSession")}
                  </Button>
                )}
              </div>
            </section>
          )}

          {task.blocker && task.blocker !== "needs_input" && task.blocker !== "untrusted" && blockerMeta && (
            <section className="overflow-hidden rounded-[var(--radius-sm)] border border-[color-mix(in_oklab,var(--warn)_40%,transparent)]">
              <div className="flex items-center gap-1.5 bg-[color-mix(in_oklab,var(--warn)_14%,transparent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--warn)]">
                <blockerMeta.icon size={13} aria-hidden />
                {blockerLabel(t, task.blocker)}
              </div>
              <div className="space-y-2 p-3">
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{task.blocker_detail}</p>
                {task.blocker === "conflict" && (
                  <Button loading={pending} onClick={() => void run(() => api.patchTask(task.id, { blocker: null }))}>
                    {pending ? t("taskModal.sending") : t("taskModal.conflictResolved")}
                  </Button>
                )}
              </div>
            </section>
          )}

          {task.status === "failed" && (
            <section className="overflow-hidden rounded-[var(--radius-sm)] border border-[color-mix(in_oklab,var(--st-failed)_40%,transparent)]">
              <div className="flex items-center gap-1.5 bg-[color-mix(in_oklab,var(--st-failed)_14%,transparent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--st-failed)]">
                <STATUS_META.failed.icon size={13} aria-hidden />
                {t("taskModal.failedHeading")}
              </div>
              <div className="space-y-2 p-3">
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{task.blocker_detail}</p>
                {task.blocker === "untrusted" && (
                  <p className="text-[12px] leading-relaxed text-[var(--ink-muted)]">{t("taskModal.untrustedHint")}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  {task.blocker === "untrusted" && (
                    <Button variant="primary" icon={ShieldCheck} loading={pending} onClick={() => void run(() => api.trustAndRetry(task.id))}>
                      {pending ? t("taskModal.starting") : t("taskModal.trustAndStart")}
                    </Button>
                  )}
                  <Button icon={RotateCcw} loading={pending} onClick={() => void run(() => api.retry(task.id))}>
                    {pending ? t("taskModal.starting") : t("taskModal.retry")}
                  </Button>
                  {task.session_id && (
                    <Button icon={PlayCircle} loading={pending} onClick={() => void run(() => api.resume(task.id))}>
                      {pending ? t("taskModal.resuming") : t("taskModal.resumeSession")}
                    </Button>
                  )}
                  <Button icon={CheckCircle2} disabled={pending} onClick={() => setClosing(true)}>
                    {t("app.forceCloseConfirm")}
                  </Button>
                </div>
              </div>
            </section>
          )}

          {stuck && !editing && (
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2">
              <p className="min-w-40 flex-1 text-[12px] leading-relaxed text-[var(--ink-muted)]">
                {t("taskModal.stuckHint")}
              </p>
              <Button icon={CheckCircle2} disabled={pending} onClick={() => setClosing(true)}>
                {t("app.forceCloseConfirm")}
              </Button>
            </div>
          )}

          {editing ? (
            <TaskForm
              projectId={task.project_id}
              project={project ?? null}
              projects={projects}
              initial={task}
              allTasks={allTasks}
              excludeId={task.id}
              onCancel={() => setEditing(false)}
              onSubmit={(v: TaskFormValues) =>
                void run(() => api.patchTask(task.id, v)).then((ok) => {
                  if (ok) setEditing(false);
                })
              }
              pending={pending}
            />
          ) : (
            <section>
              <h3 className="mb-1 text-[12px] font-medium text-[var(--ink-muted)]">{t("taskModal.descriptionHeading")}</h3>
              {task.description ? (
                <DescriptionView text={task.description} />
              ) : (
                <p className="text-[12px] text-[var(--ink-faint)]">
                  {t("taskModal.noDescription")}
                </p>
              )}
            </section>
          )}

          {report && (
            <section className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--sunken)] p-3">
              <h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ink)]">
                <FileText size={12} aria-hidden />
                {t("taskModal.reportHeading")}
              </h3>
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{report.summary}</p>
              {report.notes && (
                <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--ink-muted)]">{report.notes}</p>
              )}
            </section>
          )}

          {usage && usage.total_tokens > 0 && !editing && (
            <UsageSection usage={usage} live={task.status === "in_progress"} />
          )}

          {!editing && <TaskTimeline task={task} />}

          {!editing && (
            <section className="rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-1.5">
              <TargetBranchRow
                task={task}
                editable={branchEditable}
                pending={pending}
                onChange={(branch) => void run(() => api.patchTask(task.id, { target_branch: branch }))}
              />
              {task.branch && <CopyRow icon={GitBranch} label={t("taskModal.branchRowLabel")} value={task.branch} />}
              {task.worktree_path && <CopyRow icon={FolderGit2} label={t("taskModal.worktreeRowLabel")} value={task.worktree_path} />}
              {task.job_id && <CopyRow icon={Terminal} label={t("taskModal.connectRowLabel")} value={`claude attach ${task.job_id}`} />}
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[12px] font-medium text-[var(--ink-muted)]">{t("taskModal.commentsHeading")}</h3>
            {task.comments.length > 0 && (
              <ul className="mb-2 space-y-1.5">
                {task.comments.map((c) => (
                  <li
                    key={c.id}
                    className={cn(
                      "rounded-[var(--radius-sm)] border-l-2 bg-[var(--sunken)] px-2.5 py-1.5 text-[13px] leading-relaxed",
                      c.kind === "report"
                        ? "border-dashed border-[var(--ink-faint)] opacity-80"
                        : c.author === "user"
                          ? "border-[var(--st-todo)]"
                          : "border-[var(--line-strong)]",
                    )}
                  >
                    <span className="mr-2 text-[11px] text-[var(--ink-faint)]">{commentLabel(t, c)}</span>
                    <DescriptionView text={c.body} className="inline" compact />
                  </li>
                ))}
              </ul>
            )}
            <DescriptionEditor
              label={t("taskModal.notePlaceholder")}
              placeholder={t("taskModal.notePlaceholder")}
              textareaClassName="min-h-20"
              value={note}
              onChange={setNote}
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button
                icon={MessageSquarePlus}
                loading={pending}
                disabled={!note.trim()}
                onClick={() =>
                  void run(() => api.addComment(task.id, note.trim(), "comment")).then((ok) => {
                    if (ok) setNote("");
                  })
                }
              >
                {pending ? t("taskModal.adding") : t("common.add")}
              </Button>
              {sendKind && (
                // The label does not change during the request: otherwise a card with a badge would
                // show two "Sending…" buttons at once: this one and "Reply" above.
                <Button
                  variant="primary"
                  icon={Send}
                  disabled={pending || !note.trim()}
                  onClick={() =>
                    void run(() => api.addComment(task.id, note.trim(), sendKind)).then((ok) => {
                      if (ok) setNote("");
                    })
                  }
                >
                  {sendKind === "rework" ? t("taskModal.rework") : t("taskModal.toSession")}
                </Button>
              )}
            </div>
            {sendKind === "rework" && (
              <p className="mt-1 text-[11px] text-[var(--ink-faint)]">
                {t("taskModal.reworkHint")}
              </p>
            )}
            {sendKind === "answer" && task.blocker !== "needs_input" && (
              <p className="mt-1 text-[11px] text-[var(--ink-faint)]">
                {t("taskModal.answerHint")}
              </p>
            )}
          </section>

          {/* Card cleanup is at the very bottom and in a separate frame: one does not get
             here by accident, and "archive" comes before "delete" because it is almost always
             the one needed. */}
          {!editing && (
            <section className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2">
              <p className="min-w-40 flex-1 text-[12px] leading-relaxed text-[var(--ink-muted)]">
                {archived
                  ? t("taskModal.archivedHint")
                  : stuck
                    ? t("taskModal.stuckArchiveHint")
                    : t("taskModal.archiveHint")}
              </p>
              {archived ? (
                <Button
                  icon={ArchiveRestore}
                  loading={pending}
                  onClick={() => void run(() => api.unarchive(task.id))}
                >
                  {t("taskModal.unarchive")}
                </Button>
              ) : (
                !stuck && (
                  <Button icon={Archive} loading={pending} onClick={() => void run(() => api.archive(task.id))}>
                    {t("taskModal.archive")}
                  </Button>
                )
              )}
              <Button variant="danger" icon={Trash2} disabled={pending} onClick={() => setDeleting(true)}>
                {t("common.delete")}
              </Button>
            </section>
          )}
        </div>
      </Modal>

      <EmptyDescriptionDialog
        open={emptyDesc}
        taskId={task.id}
        taskTitle={task.title}
        onClose={() => setEmptyDesc(false)}
        onFix={() => {
          setEmptyDesc(false);
          setEditing(true);
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
