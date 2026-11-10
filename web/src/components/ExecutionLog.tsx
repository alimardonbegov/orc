import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleSlash,
  Gauge,
  GitMerge,
  GitPullRequestClosed,
  Maximize2,
  MessageSquareText,
  Moon,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Undo2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api";
import { useAgents } from "../agents";
import { formatDuration, fullDateTime, relativeTime } from "../dates";
import { explainFailure } from "../failures";
import { clock, latestRun, logRows, visiblePast, type LogEntry } from "../executionLog";
import { useNow } from "../hooks/useNow";
import { useTranslation, type TFunction } from "../i18n";
import { cn } from "../lib/cn";
import type { ExecutionLog as Log, RunOutcome, TaskCheck, TaskDetail, TaskRun, TaskUsage } from "../types";
import { IconButton } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { Modal } from "../ui/Modal";
import { SidebarSection } from "../ui/SidebarSection";
import { focusRing } from "../ui/tokens";
import { formatCost, formatTokens } from "../usage";
import { AgentAvatar } from "./AgentAvatar";
import { UsageSection } from "./UsageSection";

const OUTCOME: Record<RunOutcome, { icon: LucideIcon; tone: string }> = {
  handed_in: { icon: CheckCircle2, tone: "text-[var(--ok)]" },
  failed: { icon: XCircle, tone: "text-[var(--danger)]" },
  stopped: { icon: CircleSlash, tone: "text-[var(--ink-muted)]" },
  quota: { icon: Gauge, tone: "text-[var(--warn)]" },
  superseded: { icon: Undo2, tone: "text-[var(--ink-faint)]" },
  sleeping: { icon: Moon, tone: "text-[var(--ink-muted)]" },
};

interface Props {
  task: TaskDetail;
  usage: TaskUsage | null;
  pending: boolean;
  /** Runs a card action and reloads the card: the same path the composer's buttons take. */
  onAction: (action: () => Promise<unknown>) => Promise<boolean>;
  /** The active run talks in the thread: this takes the reader to its live end. */
  onOpenThread: () => void;
}

/**
 * The card's accounting next to its conversation, after multica's execution log: what was spent, then the runs
 * of the agent, the checks of its work and the merges. Active runs come first and are never cut; the past shows
 * three rows, the rest are behind "Show all".
 */
export function ExecutionLog({ task, usage, pending, onAction, onOpenThread }: Props) {
  const { t } = useTranslation();
  const [log, setLog] = useState<Log | null>(null);
  const [all, setAll] = useState(false);
  const [check, setCheck] = useState<TaskCheck | null>(null);
  const [stopping, setStopping] = useState(false);

  // The card re-reads itself when the task changes; the log follows the same stamp.
  const stamp = `${task.updated_at}|${task.status}|${task.job_id ?? ""}`;
  useEffect(() => {
    let current = true;
    api
      .taskRuns(task.id)
      .then((fresh) => {
        if (current) setLog(fresh);
      })
      .catch(() => {
        // The log is accounting, not control: an older server without the endpoint leaves the card without it.
      });
    return () => {
      current = false;
    };
  }, [task.id, stamp]);

  const rows = useMemo(() => (log ? logRows(log) : null), [log]);
  if (!log || !rows || (rows.active.length === 0 && rows.past.length === 0)) return null;

  const latest = latestRun(log);
  const shown = visiblePast(rows);
  const hidden = rows.past.length - shown.length;
  const actions: RowActions = {
    pending,
    canStop: (run) => run.active && task.status === "in_progress",
    // Retry continues the same session in the same working copy: the destructive "from scratch" stays in the composer
    canRetry: (run) => run === latest && !run.active && task.status === "failed" && Boolean(task.session_id),
    onStop: () => setStopping(true),
    onRetry: () => void onAction(() => api.resume(task.id)),
    onOpenThread,
    onOpenCheck: setCheck,
    // The failure is the latest run's: an earlier run that was resumed ended and went on
    explain: (run) => (run === latest && !run.active && task.status === "failed" ? explainFailure(t, task.detail_code) : null),
  };

  return (
    <SidebarSection
      title={t("card.log.heading")}
      count={rows.active.length + rows.past.length}
      defaultOpen
      actions={
        <>
          {rows.active.length > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-[var(--st-progress)]">
              <span aria-hidden className="size-1.5 rounded-full bg-[var(--st-progress)] motion-safe:animate-pulse" />
              {t("card.log.active", { count: rows.active.length })}
            </span>
          )}
          <IconButton icon={Maximize2} size="sm" label={t("card.log.showAll")} onClick={() => setAll(true)} />
        </>
      }
    >
      {/* The rows carry their own padding for the hover band: the content lines up with the header's text */}
      <div className="-mx-1.5">
      <Totals log={log} t={t} />
      <ul className="space-y-0.5">
        {rows.active.map((entry) => <Row key={entry.key} entry={entry} actions={actions} />)}
        {shown.map((entry) => <Row key={entry.key} entry={entry} actions={actions} />)}
      </ul>
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)} className={cn("mt-0.5 px-1.5 text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink)]", focusRing)}>
          {t("card.log.showAllMore", { count: hidden })}
        </button>
      )}
      </div>

      <Modal open={all} onOpenChange={setAll} title={t("card.log.dialogTitle", { id: task.id })} size="lg">
        <div className="space-y-3">
          <Totals log={log} t={t} />
          <ul className="space-y-0.5">
            {[...rows.active, ...rows.past].map((entry) => <Row key={entry.key} entry={entry} actions={actions} detailed />)}
          </ul>
          {usage && usage.total_tokens > 0 && <UsageSection usage={usage} live={task.status === "in_progress"} />}
        </div>
      </Modal>

      <Modal open={check !== null} onOpenChange={(open) => !open && setCheck(null)} title={check ? checkLabel(t, check) : ""} size="lg">
        {check && (
          <div className="space-y-2">
            <code className="block break-all font-mono text-[12px] text-[var(--ink-muted)]">{check.cmd}</code>
            {/* Output of a command in the agent's working copy: plain text, never rendered */}
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[var(--sunken)] p-3 font-mono text-[11px] leading-relaxed text-[var(--ink)]">
              {check.output_tail || emptyOutputText(t, check)}
            </pre>
          </div>
        )}
      </Modal>

      <Confirm
        open={stopping}
        title={t("card.log.stopTitle")}
        confirmLabel={t("card.log.stop")}
        confirmVariant="danger"
        pending={pending}
        onCancel={() => setStopping(false)}
        onConfirm={() => void onAction(() => api.stopTask(task.id)).then(() => setStopping(false))}
      >
        <p>{t("card.log.stopBody")}</p>
      </Confirm>
    </SidebarSection>
  );
}

/** Spent, tokens and agent time at a glance. A dash where nothing was counted, never a zero that reads as free. */
function Totals({ log, t }: { log: Log; t: TFunction }) {
  const counted = log.totals.tokens > 0 || log.totals.cost_usd > 0;
  const stats: [string, string][] = [
    [t("card.log.spent"), counted ? formatCost(log.totals.cost_usd) : "—"],
    [t("card.log.tokens"), counted ? formatTokens(log.totals.tokens) : "—"],
    [t("card.log.agentTime"), log.totals.agent_sec > 0 ? formatDuration(t, log.totals.agent_sec * 1000) : "—"],
  ];
  return (
    <dl className="grid grid-cols-3 gap-2 px-1.5 py-1.5">
      {stats.map(([label, value]) => (
        <div key={label} className="flex min-w-0 flex-col-reverse">
          <dt className="truncate text-[10px] text-[var(--ink-faint)]">{label}</dt>
          <dd className="tnum truncate text-[12px] font-medium text-[var(--ink)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface RowActions {
  pending: boolean;
  canStop: (run: TaskRun) => boolean;
  canRetry: (run: TaskRun) => boolean;
  onStop: () => void;
  onRetry: () => void;
  onOpenThread: () => void;
  onOpenCheck: (check: TaskCheck) => void;
  /** The plain-language reason a failed run ended with, and what to do next; null for any other run. */
  explain: (run: TaskRun) => { reason: string; hint: string } | null;
}

function Row({ entry, actions, detailed = false }: { entry: LogEntry; actions: RowActions; detailed?: boolean }) {
  if (entry.kind === "run") return <RunRow run={entry.run} actions={actions} detailed={detailed} />;
  if (entry.kind === "check") return <CheckRow check={entry.check} onOpen={() => actions.onOpenCheck(entry.check)} detailed={detailed} />;
  return <MergeRow entry={entry} detailed={detailed} />;
}

/** The row frame, as in multica: the left text truncates, the right column gives way to the actions on hover. */
function Shell({ lead, title, children, right, hoverActions }: { lead: React.ReactNode; title?: string; children: React.ReactNode; right: React.ReactNode; hoverActions?: React.ReactNode }) {
  return (
    <li title={title} className="group/log flex min-h-7 min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-0.5 hover:bg-[color-mix(in_oklab,var(--ink)_5%,transparent)]">
      <span className="flex size-5 shrink-0 items-center justify-center">{lead}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink)]">{children}</span>
      <span className={cn("flex shrink-0 items-center gap-1 text-[11px] text-[var(--ink-muted)]", hoverActions && "group-hover/log:hidden group-focus-within/log:hidden")}>{right}</span>
      {hoverActions && <span className="hidden shrink-0 items-center gap-0.5 group-hover/log:flex group-focus-within/log:flex">{hoverActions}</span>}
    </li>
  );
}

function When({ iso }: { iso: string }) {
  const { language } = useTranslation();
  const now = useNow();
  const at = Date.parse(iso);
  return (
    <time dateTime={iso} title={fullDateTime(at, language)} className="tnum text-[var(--ink-faint)]">
      {relativeTime(at, language, now)}
    </time>
  );
}

/** Ticks every second while the run is alive: useNow's half-minute clock is too coarse for a timer. */
function LiveTimer({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tnum text-[var(--st-progress)]">{clock((now - Date.parse(since)) / 1000)}</span>;
}

function RunRow({ run, actions, detailed }: { run: TaskRun; actions: RowActions; detailed: boolean }) {
  const { t, language } = useTranslation();
  const agent = useAgents().find((a) => a.id === run.agent_id);
  const outcome = run.outcome ? OUTCOME[run.outcome] : null;
  const OutcomeIcon = outcome?.icon;
  const trigger = run.trigger ? t(`card.log.trigger.${run.trigger}`) : t("card.log.trigger.none");
  // The server's words for what exactly started it, such as which wakeup condition held
  const detail = run.trigger_detail ?? null;
  const title = [
    detail,
    agent?.name,
    fullDateTime(Date.parse(run.started_at), language),
    run.duration_sec !== null && !run.active ? formatDuration(t, run.duration_sec * 1000) : null,
    run.outcome ? t(`card.log.outcome.${run.outcome}`) : null,
    run.tokens > 0 ? t("card.log.tokensCount", { tokens: formatTokens(run.tokens) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const hover = (
    <>
      {run.active && <IconButton icon={MessageSquareText} size="sm" label={t("card.log.openThread")} onClick={actions.onOpenThread} />}
      {actions.canStop(run) && <IconButton icon={Square} size="sm" variant="danger" label={t("card.log.stop")} disabled={actions.pending} onClick={actions.onStop} />}
      {actions.canRetry(run) && <IconButton icon={RotateCcw} size="sm" label={t("card.log.retry")} disabled={actions.pending} onClick={actions.onRetry} />}
    </>
  );
  const hasHover = run.active || actions.canStop(run) || actions.canRetry(run);
  const why = actions.explain(run);
  return (
    <Shell
      title={title}
      lead={agent ? <AgentAvatar agent={agent} size={20} /> : <span className="size-5 rounded-full bg-[var(--sunken)]" />}
      right={
        run.active ? (
          <>
            <LiveTimer since={run.started_at} />
            <span className="sr-only">{t("card.log.running")}</span>
          </>
        ) : (
          <>
            {detailed && run.ended_at && <When iso={run.ended_at} />}
            {detailed && run.duration_sec !== null && <span className="tnum">{formatDuration(t, run.duration_sec * 1000)}</span>}
            {OutcomeIcon && <OutcomeIcon size={12} aria-label={t(`card.log.outcome.${run.outcome}`)} className={outcome.tone} />}
            <span className="tnum">{run.cost_usd > 0 ? formatCost(run.cost_usd) : "—"}</span>
          </>
        )
      }
      hoverActions={hasHover ? hover : undefined}
    >
      {trigger}
      {detail && <span className="text-[var(--ink-faint)]"> · {detail}</span>}
      {why && (
        <span data-testid="run-reason" title={`${why.reason} ${why.hint}`} className="block truncate text-[11px] text-[var(--st-failed)]">
          {why.reason}
          {detailed && <span className="text-[var(--ink-muted)]"> {why.hint}</span>}
        </span>
      )}
    </Shell>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

/** A failed check says how it ended: the exit code, or the timeout (which has no code). */
function checkLabel(t: Translate, check: TaskCheck): string {
  if (check.ok) return t("card.log.checkPassed");
  if (check.timed_out) return t("card.log.timedOut");
  if (check.exit_code !== null && check.exit_code !== undefined) return t("card.log.exitCode", { code: check.exit_code });
  return t("card.log.checkFailed");
}

/** An empty output of a failed check is explained by its code; old rows without one keep the plain text. */
function emptyOutputText(t: Translate, check: TaskCheck): string {
  if (check.timed_out) return t("card.log.noOutputTimedOut");
  if (!check.ok && check.exit_code !== null && check.exit_code !== undefined) return t("card.log.noOutputCode", { code: check.exit_code });
  return t("card.log.noOutput");
}

function CheckRow({ check, onOpen, detailed }: { check: TaskCheck; onOpen: () => void; detailed: boolean }) {
  const { t } = useTranslation();
  const Icon = check.ok ? ShieldCheck : ShieldAlert;
  return (
    <Shell
      title={check.cmd}
      lead={<Icon size={14} aria-hidden className={check.ok ? "text-[var(--ok)]" : "text-[var(--danger)]"} />}
      right={
        <>
          {detailed && <When iso={check.created_at} />}
          <span className="tnum">{formatDuration(t, check.duration_sec * 1000)}</span>
        </>
      }
    >
      <button type="button" onClick={onOpen} className={cn("max-w-full truncate text-left hover:underline", focusRing)}>
        {checkLabel(t, check)}
      </button>
    </Shell>
  );
}

function MergeRow({ entry, detailed }: { entry: Extract<LogEntry, { kind: "merge" }>; detailed: boolean }) {
  const { t } = useTranslation();
  const { merge } = entry;
  const ok = merge.result === "merged";
  const Icon = ok ? GitMerge : GitPullRequestClosed;
  const label = t(`card.log.merge.${merge.result}`, { target: merge.target ?? "" });
  return (
    <Shell
      title={merge.detail ?? label}
      lead={<Icon size={14} aria-hidden className={ok ? "text-[var(--st-done)]" : merge.result === "conflict" ? "text-[var(--warn)]" : "text-[var(--danger)]"} />}
      right={<When iso={merge.at} />}
    >
      {label}
      {detailed && merge.detail && <span className="text-[var(--ink-faint)]"> · {merge.detail}</span>}
    </Shell>
  );
}
