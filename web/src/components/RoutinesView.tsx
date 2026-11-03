import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Coins, Pause, Pencil, Play, Plus, Repeat, Trash2, Zap } from "lucide-react";
import { api } from "../api";
import type { Project, Routine, RoutineInput, RoutineRun } from "../types";
import { usePolling } from "../hooks/usePolling";
import { useNow } from "../hooks/useNow";
import { useTranslation } from "../i18n";
import { statusLabel } from "../labels";
import { STATUS_META } from "../status";
import { formatDuration, fullDateTime, relativeTime } from "../dates";
import { formatTokens } from "../usage";
import { runDuration, runOutcome, scheduleText, slotTime, successRate, untilLabel } from "../routines";
import { Badge, Dot } from "../ui/Badge";
import { Button, IconButton } from "../ui/Button";
import { Tip } from "../ui/Overlays";
import { Modal } from "../ui/Modal";
import { Confirm } from "../ui/Confirm";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { RoutineForm } from "./RoutineForm";

interface Props {
  project: Project;
  /** Whether runs can be created in the project: the folder is in place and the project is not
   * archived. */
  canCreate: boolean;
  onOpenTask: (id: number) => void;
  /** The board must learn about a new run right away, not on the next poll. */
  onTasksChanged: () => void;
}

/**
 * Project recurring tasks: what runs, when the next run is, how many there have been and how they
 * ended. Each run is an ordinary card on the board; here is their history in one place and the
 * routine's levers: run now, pause, edit, delete.
 */
export function RoutinesView({ project, canCreate, onOpenTask, onTasksChanged }: Props) {
  const { t } = useTranslation();
  const routines = usePolling(() => api.routines(project.id), 5000, [project.id]);
  const [form, setForm] = useState<{ routine?: Routine } | null>(null);
  const [formPending, setFormPending] = useState(false);
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const list = routines.data ?? [];

  const act = (id: number, action: () => Promise<unknown>, success?: string) => {
    setBusy(id);
    action()
      .then(() => {
        if (success) toast.success(success);
        void routines.refresh();
        onTasksChanged();
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const submit = (values: RoutineInput) => {
    setFormPending(true);
    const editing = form?.routine;
    const request = editing
      ? api.patchRoutine(editing.id, values)
      : api.addRoutine({ project_id: project.id, ...values });
    request
      .then(() => {
        toast.success(editing ? t("routines.savedToast") : t("routines.createdToast"));
        setForm(null);
        void routines.refresh();
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setFormPending(false));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-3 pb-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-[var(--ink)]">
            <Repeat size={14} aria-hidden className="text-[var(--ink-faint)]" />
            {t("routines.heading")}
          </h2>
          <p className="text-[12px] text-[var(--ink-muted)]">{t("routines.subheading")}</p>
        </div>
        <Button icon={Plus} variant="primary" className="ml-auto" disabled={!canCreate} onClick={() => setForm({})}>
          {t("routines.newButton")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-2">
        {routines.data === null ? (
          routines.error ? (
            <p className="text-[12px] text-[var(--danger)]">{routines.error}</p>
          ) : (
            <div className="h-20 animate-pulse rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)]" />
          )
        ) : list.length === 0 ? (
          <div className="mx-auto mt-10 max-w-md space-y-2 text-center">
            <Repeat size={28} aria-hidden className="mx-auto text-[var(--ink-faint)]" />
            <p className="text-[14px] font-semibold text-[var(--ink)]">{t("routines.emptyTitle")}</p>
            <p className="text-[12px] leading-relaxed text-[var(--ink-muted)]">{t("routines.emptyBody")}</p>
            {canCreate && (
              <Button icon={Plus} variant="primary" onClick={() => setForm({})}>
                {t("routines.newButton")}
              </Button>
            )}
          </div>
        ) : (
          list.map((r) => (
            <RoutineRow
              key={r.id}
              routine={r}
              expanded={expanded === r.id}
              busy={busy === r.id}
              onToggleExpand={() => setExpanded((cur) => (cur === r.id ? null : r.id))}
              onRunNow={() => act(r.id, () => api.runRoutine(r.id), t("routines.runStartedToast"))}
              onToggleEnabled={() =>
                act(r.id, () => api.patchRoutine(r.id, { enabled: !r.enabled }),
                  r.enabled ? t("routines.pausedToast") : t("routines.resumedToast"))
              }
              onEdit={() => setForm({ routine: r })}
              onDelete={() => setDeleting(r)}
              onOpenTask={onOpenTask}
            />
          ))
        )}
      </div>

      {form && (
        <Modal
          open
          onOpenChange={(o) => !o && setForm(null)}
          title={form.routine ? t("routines.editTitle") : t("routines.newTitle")}
          size="lg"
          sticky
        >
          <RoutineForm
            project={project}
            initial={form.routine}
            pending={formPending}
            submitLabel={form.routine ? t("common.save") : t("routines.createSubmit")}
            onSubmit={submit}
            onCancel={() => setForm(null)}
          />
        </Modal>
      )}

      {deleting && (
        <Confirm
          open
          title={t("routines.deleteTitle")}
          confirmLabel={t("common.delete")}
          pending={deletePending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            setDeletePending(true);
            api
              .deleteRoutine(deleting.id)
              .then(() => {
                setDeleting(null);
                void routines.refresh();
              })
              .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
              .finally(() => setDeletePending(false));
          }}
        >
          <p>{t("routines.deleteBody", { title: deleting.title })}</p>
        </Confirm>
      )}
    </div>
  );
}

interface RowProps {
  routine: Routine;
  expanded: boolean;
  busy: boolean;
  onToggleExpand: () => void;
  onRunNow: () => void;
  onToggleEnabled: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenTask: (id: number) => void;
}

function RoutineRow({ routine: r, expanded, busy, onToggleExpand, onRunNow, onToggleEnabled, onEdit, onDelete, onOpenTask }: RowProps) {
  const { t, language } = useTranslation();
  const now = useNow();
  const next = r.next_run_at ? Date.parse(r.next_run_at) : null;
  const rate = successRate(r);
  const last = r.last_run;
  const lastMeta = last ? STATUS_META[last.status] : null;
  const capReached = !r.enabled && r.max_runs !== null && r.run_count >= r.max_runs;

  return (
    <article
      className={cn(
        "rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)]",
        !r.enabled && "opacity-80",
      )}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={t("routines.historyToggle", { title: r.title })}
          className={cn("flex min-w-0 flex-1 items-start gap-2 text-left", focusRing, "rounded-[var(--radius-sm)]")}
        >
          {expanded ? (
            <ChevronDown size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--ink-faint)]" />
          ) : (
            <ChevronRight size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--ink-faint)]" />
          )}
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <Dot tone={r.enabled ? "bg-[var(--ok)]" : "bg-[var(--ink-faint)]"} pulse={r.enabled && r.stats.active > 0} />
              <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{r.title}</span>
            </span>
            <span className="mt-0.5 block text-[12px] text-[var(--ink-muted)]">
              <span className="font-mono text-[11px]">{scheduleText(t, r)}</span>
              {" · "}
              {r.enabled && next !== null ? (
                <span title={fullDateTime(next, language)}>
                  {t("routines.nextRun", { when: untilLabel(next, language, now), time: slotTime(next, language, now) })}
                </span>
              ) : capReached ? (
                <span>{t("routines.capReached", { count: r.max_runs ?? 0 })}</span>
              ) : (
                <span>{t("routines.paused")}</span>
              )}
            </span>
          </span>
        </button>

        <dl className="flex shrink-0 items-center gap-3 text-[11px] text-[var(--ink-muted)]">
          <Stat label={t("routines.stats.runs")} value={r.max_runs ? `${r.run_count}/${r.max_runs}` : String(r.run_count)} />
          <Stat label={t("routines.stats.done")} value={String(r.stats.done)} tone="text-[var(--st-done)]" />
          <Stat label={t("routines.stats.failed")} value={String(r.stats.failed)} tone={r.stats.failed ? "text-[var(--st-failed)]" : undefined} />
          <Stat label={t("routines.stats.skipped")} value={String(r.stats.skipped)} />
          {rate !== null && <Stat label={t("routines.stats.success")} value={`${Math.round(rate * 100)}%`} />}
        </dl>

        <div className="flex shrink-0 items-center gap-0.5">
          <Tip text={r.stats.active > 0 ? t("routines.runNowBusy") : t("routines.runNow")}>
            <span className="inline-flex">
              <IconButton icon={Zap} label={t("routines.runNow")} size="sm" disabled={busy || r.stats.active > 0} onClick={onRunNow} />
            </span>
          </Tip>
          <Tip text={r.enabled ? t("routines.pause") : t("routines.resume")}>
            <IconButton
              icon={r.enabled ? Pause : Play}
              label={r.enabled ? t("routines.pause") : t("routines.resume")}
              size="sm"
              disabled={busy}
              onClick={onToggleEnabled}
            />
          </Tip>
          <Tip text={t("common.edit")}>
            <IconButton icon={Pencil} label={t("common.edit")} size="sm" onClick={onEdit} />
          </Tip>
          <Tip text={t("common.delete")}>
            <IconButton icon={Trash2} label={t("common.delete")} size="sm" onClick={onDelete} />
          </Tip>
        </div>
      </div>

      {last && lastMeta && !expanded && (
        <button
          type="button"
          onClick={() => onOpenTask(last.task_id)}
          className={cn(
            "flex w-full items-center gap-2 border-t border-[var(--line)] px-3 py-1.5 text-left text-[12px] hover:bg-[var(--sunken)]",
            focusRing,
          )}
        >
          <span className="shrink-0 text-[var(--ink-faint)]">{t("routines.lastRun", { run: last.run ?? "?" })}</span>
          <Badge icon={lastMeta.icon} tone={lastMeta.chip}>
            {statusLabel(t, last.status)}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-[var(--ink-muted)]">{runOutcome(last)}</span>
          <span className="shrink-0 text-[11px] text-[var(--ink-faint)]">
            {relativeTime(Date.parse(last.created_at), language, now)}
          </span>
        </button>
      )}

      {expanded && <RunHistory routine={r} onOpenTask={onOpenTask} />}
    </article>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col items-end">
      <dt className="text-[10px] uppercase tracking-wide text-[var(--ink-faint)]">{label}</dt>
      <dd className={cn("tnum text-[13px] font-semibold text-[var(--ink)]", tone)}>{value}</dd>
    </div>
  );
}

/** Run history: all routine runs, newest on top, including those moved to the archive. */
function RunHistory({ routine, onOpenTask }: { routine: Routine; onOpenTask: (id: number) => void }) {
  const { t, language } = useTranslation();
  const now = useNow();
  // Poll while the history is expanded: the status of a running run changes before your eyes.
  const runs = usePolling(() => api.routineRuns(routine.id), 5000, [routine.id]);

  if (runs.data === null) {
    return <p className="border-t border-[var(--line)] px-3 py-2 text-[12px] text-[var(--ink-faint)]">{runs.error ?? t("common.loading")}</p>;
  }
  if (runs.data.length === 0) {
    return <p className="border-t border-[var(--line)] px-3 py-2 text-[12px] text-[var(--ink-faint)]">{t("routines.noRuns")}</p>;
  }
  return (
    <div className="border-t border-[var(--line)]">
      <table className="w-full table-fixed text-left text-[12px]">
        <thead className="text-[10px] uppercase tracking-wide text-[var(--ink-faint)]">
          <tr>
            <th className="w-12 px-3 py-1.5 font-medium">#</th>
            <th className="w-32 px-2 py-1.5 font-medium">{t("routines.history.status")}</th>
            <th className="w-36 px-2 py-1.5 font-medium">{t("routines.history.created")}</th>
            <th className="w-24 px-2 py-1.5 font-medium">{t("routines.history.duration")}</th>
            <th className="px-2 py-1.5 font-medium">{t("routines.history.outcome")}</th>
            <th className="w-20 px-3 py-1.5 text-right font-medium">{t("routines.history.tokens")}</th>
          </tr>
        </thead>
        <tbody>
          {runs.data.map((run) => (
            <RunRow key={run.task_id} run={run} now={now} language={language} onOpen={() => onOpenTask(run.task_id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunRow({ run, now, language, onOpen }: { run: RoutineRun; now: number; language: string; onOpen: () => void }) {
  const { t } = useTranslation();
  const meta = STATUS_META[run.status];
  const duration = runDuration(run);
  const created = Date.parse(run.created_at);
  return (
    <tr
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title={t("routines.history.openTitle", { id: run.task_id })}
      className={cn("cursor-pointer border-t border-[var(--line)] hover:bg-[var(--sunken)]", focusRing)}
    >
      <td className="tnum px-3 py-1.5 text-[var(--ink-muted)]">{run.run ?? "—"}</td>
      <td className="px-2 py-1.5">
        <Badge icon={meta.icon} tone={meta.chip}>
          {statusLabel(t, run.status)}
        </Badge>
      </td>
      <td className="tnum px-2 py-1.5 text-[var(--ink-muted)]" title={fullDateTime(created, language)}>
        {relativeTime(created, language, now)}
      </td>
      <td className="tnum px-2 py-1.5 text-[var(--ink-muted)]">{duration !== null ? formatDuration(t, duration) : "—"}</td>
      <td className="truncate px-2 py-1.5 text-[var(--ink)]" title={runOutcome(run)}>
        {runOutcome(run) || <span className="text-[var(--ink-faint)]">—</span>}
      </td>
      <td className="tnum px-3 py-1.5 text-right font-mono text-[11px] text-[var(--ink-muted)]">
        {run.tokens ? (
          <span className="inline-flex items-center gap-1">
            <Coins size={10} aria-hidden />
            {formatTokens(run.tokens)}
          </span>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}
