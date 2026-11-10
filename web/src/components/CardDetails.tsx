import { useState } from "react";
import { Check, Copy, FolderGit2, GitBranch, Terminal } from "lucide-react";
import type { Task } from "../types";
import { formatDuration, fullDateTime, relativeTime, timeline } from "../dates";
import { useNow } from "../hooks/useNow";
import { useTranslation } from "../i18n";
import { IconButton } from "../ui/Button";
import { SidebarSection } from "../ui/SidebarSection";

/** Machine string with a copy button: branches, paths and commands are copied more often than read. */
export function CopyRow({ icon: Icon, label, value }: { icon: typeof GitBranch; label: string; value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5 py-0.5" title={label}>
      <Icon size={12} className="shrink-0 text-[var(--ink-faint)]" aria-hidden />
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

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-1">
      <dt className="text-[11px] text-[var(--ink-faint)]">{name}</dt>
      <dd className="min-w-0 text-[12px] text-[var(--ink-muted)]">{children}</dd>
    </div>
  );
}

function Moment({ at, since, sinceKey }: { at: number | string | null | undefined; since?: number; sinceKey?: string }) {
  const { t, language } = useTranslation();
  const now = useNow();
  const ms = typeof at === "string" ? Date.parse(at) : at;
  if (ms === null || ms === undefined || Number.isNaN(ms)) return <span className="text-[var(--ink-faint)]">—</span>;
  return (
    <>
      <time dateTime={new Date(ms).toISOString()} className="tnum text-[var(--ink)]" title={relativeTime(ms, language, now)}>
        {fullDateTime(ms, language)}
      </time>
      {since !== undefined && sinceKey && <span className="tnum text-[11px] text-[var(--ink-faint)]"> · {t(sinceKey, { duration: formatDuration(t, since) })}</span>}
    </>
  );
}

interface Props {
  task: Task;
  allTasks: Task[];
  onOpenTask?: (id: number) => void;
  /** What sits above the rows: the tokens of the card. */
  children?: React.ReactNode;
}

/**
 * Details: the facts about a card that nobody edits. Closed by default, because the column above is for what the owner
 * changes. Who made the card, when it was made, started, finished, and where its work lives, with copy buttons.
 * The queue wait and the working time that the timeline used to show sit beside "started" and "finished".
 */
export function CardDetails({ task, allTasks, onOpenTask, children }: Props) {
  const { t } = useTranslation();
  const steps = timeline(task);
  const started = steps.find((s) => s.kind === "started");
  const finished = steps.find((s) => s.kind === "done" || s.kind === "failed");
  const creator = task.created_by_task_id;
  const maker = allTasks.find((x) => x.id === creator);
  return (
    <SidebarSection title={t("card.modal.details")}>
      <div className="space-y-3">
        {children}
        <dl className="space-y-1">
          <Row name={t("card.details.createdBy")}>
            {creator ? (
              onOpenTask ? (
                <button type="button" className="underline underline-offset-2 hover:text-[var(--ink)]" onClick={() => onOpenTask(creator)} title={maker?.title}>
                  {t("card.details.byCard", { id: creator })}
                </button>
              ) : (
                t("card.details.byCard", { id: creator })
              )
            ) : task.routine_id ? (
              t("card.details.byRoutine", { run: task.routine_run ?? 0 })
            ) : (
              t("card.details.byOwner")
            )}
          </Row>
          <Row name={t("dates.timeline.created")}>
            <Moment at={task.created_at} />
          </Row>
          <Row name={t("card.details.updated")}>
            <Moment at={task.updated_at} />
          </Row>
          <Row name={t("dates.timeline.started")}>
            {started ? <Moment at={started.at} since={started.since} sinceKey="dates.timeline.waited" /> : <span className="text-[var(--ink-faint)]">{t("dates.timeline.notStarted")}</span>}
          </Row>
          <Row name={t("card.details.finished")}>
            {finished ? <Moment at={finished.at} since={finished.since} sinceKey="dates.timeline.worked" /> : <span className="text-[var(--ink-faint)]">—</span>}
          </Row>
        </dl>
        {(task.branch || task.worktree_path || task.job_id) && (
          <div>
            {task.branch && <CopyRow icon={GitBranch} label={t("taskModal.branchRowLabel")} value={task.branch} />}
            {task.worktree_path && <CopyRow icon={FolderGit2} label={t("taskModal.worktreeRowLabel")} value={task.worktree_path} />}
            {task.job_id && <CopyRow icon={Terminal} label={t("taskModal.connectRowLabel")} value={`claude attach ${task.job_id}`} />}
          </div>
        )}
      </div>
    </SidebarSection>
  );
}
