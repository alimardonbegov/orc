import { explainFailure } from "../failures";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  Clock,
  Cpu,
  ArrowDown,
  ExternalLink,
  Loader2,
  MessageCircleQuestion,
  Moon,
  PauseCircle,
  Send,
  ShieldCheck,
  Square,
  Terminal,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api";
import { useAgents } from "../agents";
import { composerMode, doingNow, fetchProcesses, planStep, useActivityFeed, type ActivitySource, type ConversationExtras } from "../activity";
import type { ActivityComment, ActivityNow, ActivityPhase, ActivityProcess, Blocker, InputDecision, OsProcess } from "../types";
import { blockerLabel } from "../labels";
import { BLOCKER_META } from "../status";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { useTranslation, type TFunction } from "../i18n";
import { AgentAvatar } from "./AgentAvatar";
import { shortDuration } from "./ActivityFeed";
import { ConversationFeed } from "./ConversationFeed";
import { InputRequestPanel } from "./InputRequestPanel";
import { TaskComposer } from "./TaskComposer";
import type { QuickAction } from "../quickActions";

/** A transcript silent for this long deserves a word: the session may be hanging. */
const SILENCE_WORTH_SAYING_SEC = 120;
const OS_POLL_MS = 4000;

const PHASE_ICON: Partial<Record<ActivityPhase, LucideIcon>> = {
  starting: Loader2,
  working: Loader2,
  background: Clock,
  idle: PauseCircle,
  stopped: Square,
  waiting_input: MessageCircleQuestion,
  waiting_reply: MessageCircleQuestion,
  quota: Clock,
  sleeping: Moon,
  delivering: Send,
  failed: XCircle,
  done: Check,
  verifying: Loader2,
  merging: Loader2,
};

const ATTENTION: ActivityPhase[] = ["waiting_input", "waiting_reply", "quota"];
const SPINNING: ActivityPhase[] = ["starting", "working", "verifying", "merging"];

export function phaseTone(phase: ActivityPhase): string | undefined {
  if (ATTENTION.includes(phase)) return "bg-[color-mix(in_oklab,var(--st-blocked)_14%,transparent)] text-[var(--st-blocked)]";
  if (phase === "failed") return "bg-[color-mix(in_oklab,var(--st-failed)_14%,transparent)] text-[var(--st-failed)]";
  if (SPINNING.includes(phase)) return "bg-[color-mix(in_oklab,var(--st-todo)_14%,transparent)] text-[var(--st-todo)]";
  return undefined;
}

/** The phase as a word. */
export function phaseLabel(t: TFunction, phase: ActivityPhase): string {
  return t(`activity.phase.${phase}`);
}

export function PhaseBadge({ phase }: { phase: ActivityPhase }) {
  const { t } = useTranslation();
  const Icon = PHASE_ICON[phase];
  return (
    <Badge tone={phaseTone(phase)}>
      {Icon && <Icon size={11} aria-hidden className={cn("mr-1 inline align-[-1px]", SPINNING.includes(phase) && "animate-spin")} />}
      {phaseLabel(t, phase)}
    </Badge>
  );
}

function Todos({ now }: { now: ActivityNow }) {
  const { t } = useTranslation();
  if (now.todos.length === 0) return null;
  const done = now.todos.filter((x) => x.status === "done").length;
  return (
    <details className="rounded-[var(--radius-sm)] border border-[var(--line)] px-2 py-1" open>
      <summary className={cn("cursor-pointer text-[12px] font-medium text-[var(--ink-muted)]", focusRing)}>
        {t("activity.todos", { done, total: now.todos.length })}
      </summary>
      <ul className="mt-1 space-y-0.5">
        {now.todos.map((todo, i) => (
          <li key={i} className="flex items-start gap-1.5 text-[12px] leading-snug">
            {todo.status === "done" ? (
              <Check size={12} aria-hidden className="mt-0.5 shrink-0 text-[var(--ink-faint)]" />
            ) : todo.status === "in_progress" ? (
              <CircleDot size={12} aria-hidden className="mt-0.5 shrink-0 text-[var(--st-todo)]" />
            ) : (
              <Circle size={12} aria-hidden className="mt-0.5 shrink-0 text-[var(--ink-faint)]" />
            )}
            <span className={cn(todo.status === "done" ? "text-[var(--ink-faint)] line-through" : "text-[var(--ink)]")}>{todo.label}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function BackgroundRow({ process }: { process: ActivityProcess }) {
  const { t } = useTranslation();
  const Icon = process.kind === "agent" ? Bot : Terminal;
  const end = process.done_at_ms;
  return (
    <li className="flex min-w-0 items-center gap-1.5 text-[12px]">
      <Icon size={12} aria-hidden className="shrink-0 text-[var(--ink-muted)]" />
      <span className="min-w-0 flex-1 truncate" title={process.label}>{process.label}</span>
      {process.started_at_ms && end && <span className="tnum shrink-0 text-[11px] text-[var(--ink-faint)]">{shortDuration(t, end - process.started_at_ms)}</span>}
      {process.status === "running" && <Loader2 size={12} aria-label={t("activity.processRunning")} className="shrink-0 animate-spin text-[var(--ink-muted)]" />}
      {process.status === "done" && <Check size={12} aria-label={t("activity.processDone")} className="shrink-0 text-[var(--ink-faint)]" />}
      {process.status === "failed" && <XCircle size={12} aria-label={t("activity.processFailed")} className="shrink-0 text-[var(--danger)]" />}
    </li>
  );
}

function memoryLabel(kb: number): string {
  return kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
}

/** Real processes: asked for only while open, `ps` is not free. */
function OsProcessList({ source }: { source: ActivitySource }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<OsProcess[] | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const data = await fetchProcesses(source);
        if (alive) setRows(data.processes);
      } catch {
        if (alive) setRows([]);
      }
      if (alive) timer = setTimeout(() => void poll(), OS_POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [source]);
  if (rows === null) return <p className="py-1 text-[12px] text-[var(--ink-faint)]">{t("common.loading")}</p>;
  if (rows.length === 0) return <p className="py-1 text-[12px] text-[var(--ink-faint)]">{t("activity.osEmpty")}</p>;
  return (
    <div className="mt-1 max-h-48 overflow-auto">
      <table className="w-full text-left text-[11px]">
        <thead className="text-[var(--ink-faint)]">
          <tr>
            <th className="pr-2 font-normal">PID</th>
            <th className="pr-2 font-normal">{t("activity.osCpu")}</th>
            <th className="pr-2 font-normal">{t("activity.osMemory")}</th>
            <th className="pr-2 font-normal">{t("activity.osTime")}</th>
            <th className="font-normal">{t("activity.osCommand")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.pid} className="tnum align-top text-[var(--ink-muted)]">
              <td className="pr-2">{p.pid}</td>
              <td className="pr-2">{Math.round(p.cpu_pct)}%</td>
              <td className="whitespace-nowrap pr-2">{memoryLabel(p.rss_kb)}</td>
              <td className="whitespace-nowrap pr-2">{p.elapsed_sec === null ? "" : shortDuration(t, p.elapsed_sec * 1000)}</td>
              <td className="max-w-0 w-full truncate font-mono" style={{ paddingLeft: p.depth * 10 }} title={p.command}>{p.command}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Processes({ source, now }: { source: ActivitySource; now: ActivityNow }) {
  const { t } = useTranslation();
  const [osOpen, setOsOpen] = useState(false);
  if (now.processes.length === 0 && !now.live) return null;
  const running = now.processes.filter((p) => p.status === "running").length;
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--line)] px-2 py-1">
      {now.processes.length > 0 && (
        <>
          <p className="text-[12px] font-medium text-[var(--ink-muted)]">{t("activity.background", { running, total: now.processes.length })}</p>
          <ul className="mb-1 mt-1 space-y-0.5">
            {now.processes.map((p) => (
              <BackgroundRow key={p.id} process={p} />
            ))}
          </ul>
        </>
      )}
      {now.live && (
        <>
          <button
            type="button"
            aria-expanded={osOpen}
            onClick={() => setOsOpen(!osOpen)}
            className={cn("flex items-center gap-1 text-[12px] font-medium text-[var(--ink-muted)]", focusRing)}
          >
            <ChevronRight size={12} aria-hidden className={cn("transition-transform duration-100", osOpen && "rotate-90")} />
            <Cpu size={12} aria-hidden />
            {t("activity.osProcesses")}
          </button>
          {osOpen && <OsProcessList source={source} />}
        </>
      )}
    </div>
  );
}

/**
 * What else holds the card, in one line above the composer, with its one action where it has one. The
 * detail can run long (a list of conflicting files), so a click unfolds it.
 */
function Notice({ blocker, detail, code, pending, onResolved, onTrust }: {
  blocker: NonNullable<Blocker>;
  detail: string | null;
  /** Why the detail says what it says (failures.ts): a known one is said in words, the text goes behind the click. */
  code?: string | null;
  pending: boolean;
  onResolved: () => void;
  onTrust: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const meta = BLOCKER_META[blocker];
  const explained = blocker === "untrusted" ? null : explainFailure(t, code);
  const text = explained ? explained.reason : blocker === "untrusted" ? t("taskModal.untrustedHint") : (detail ?? "");
  return (
    <div data-testid="notice" className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[color-mix(in_oklab,var(--warn)_40%,transparent)] bg-[color-mix(in_oklab,var(--warn)_8%,transparent)] px-2.5 py-1.5 text-[12px]">
      <meta.icon size={13} aria-hidden className={cn("mt-0.5 shrink-0", meta.fg)} />
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={open ? undefined : text}
        className={cn("min-w-0 flex-1 text-left leading-snug", focusRing)}
      >
        <span className={cn("font-medium", meta.fg)}>{blockerLabel(t, blocker)}</span>
        {text && <span className={cn("ml-1.5 text-[var(--ink-muted)]", open ? "whitespace-pre-wrap break-words" : "line-clamp-1")}>{text}</span>}
        {explained && open && (
          <span data-testid="notice-more" className="mt-1 block whitespace-pre-wrap break-words text-[var(--ink-muted)]">
            {explained.hint}
            {detail && <span className="mt-1 block text-[11px] text-[var(--ink-faint)]">{t("card.failure.details")}: {detail}</span>}
          </span>
        )}
      </button>
      {blocker === "conflict" && (
        <Button size="sm" disabled={pending} onClick={onResolved}>
          {t("taskModal.conflictResolved")}
        </Button>
      )}
      {blocker === "untrusted" && (
        <Button size="sm" variant="primary" icon={ShieldCheck} disabled={pending} onClick={onTrust}>
          {t("taskModal.trustAndStart")}
        </Button>
      )}
    </div>
  );
}

interface Props {
  source: ActivitySource;
  /** The element that scrolls the panel: the thread follows its live end there, and the composer pins to its bottom. */
  scrollRoot?: HTMLElement | null;
  /** Open at the end of the thread: the owner came to answer, not to read the task. */
  startAtEnd?: boolean;
  /** An archived card takes notes only. */
  archived?: boolean;
  /** What the card knows of the state before the feed answers, or when it cannot. */
  fallbackNow?: ActivityNow | null;
  /** The card's own comments: shown until the feed answers, and when it cannot. */
  fallbackComments?: ActivityComment[];
  /** Open the task card: from the agent window, for what only the card can do. */
  onOpenTask?: (id: number) => void;
  /** After a command: the owner of the panel re-reads its data. */
  onChanged?: () => void;
  /** The card shows the session's state at its top, in view while the thread scrolls. */
  onNow?: (now: ActivityNow | null) => void;
  /** Starting the work. The card checks readiness and saves the description first; elsewhere it runs as is. */
  startWork?: (action: () => Promise<unknown>) => void;
  /** Close the card by hand. Only the card offers it, with its confirmation. */
  onForceClose?: () => void;
  /** Canned messages offered under "/" in the composer. */
  quickActions?: readonly QuickAction[];
  /** A command in flight or text typed: the window must not close on a stray click. */
  onBusy?: (busy: boolean) => void;
  /** Filled with the jump to the end of the thread. */
  jumpRef?: React.MutableRefObject<(() => void) | null>;
  className?: string;
}

/**
 * Everything about one run in one place, the same in the task card and in the agent window: what the agent
 * is doing now, its plan and processes, one thread of everything said and done, and one composer at the
 * bottom. A request the agent waits on is the last row of the thread; a question at the end of a turn is its
 * last message. Nothing about the conversation lives anywhere else.
 *
 * It renders two siblings, the thread and the composer, so that the owner's column can pin the composer to
 * the bottom of the whole scroll: a sticky element stays inside its parent, and the thread starts well below
 * the top of a card.
 */
export function ActivityPanel({ source, scrollRoot = null, startAtEnd, archived = false, fallbackNow = null, fallbackComments, onOpenTask, onChanged, onNow, startWork, onForceClose, quickActions, onBusy, jumpRef, className }: Props) {
  const { t } = useTranslation();
  const feed = useActivityFeed(source);
  // The feed is the fresher of the two; the card's own state stands in until it answers. A server that does
  // not send the blocker yet leaves it to the card.
  const now = useMemo<ActivityNow | null>(() => {
    if (!feed.now) return fallbackNow;
    if (feed.now.blocker !== undefined || !fallbackNow) return feed.now;
    return { ...feed.now, blocker: fallbackNow.blocker, blocker_detail: fallbackNow.blocker_detail, outbox_state: fallbackNow.outbox_state };
  }, [feed.now, fallbackNow]);
  useEffect(() => onNow?.(feed.now), [onNow, feed.now]);
  // A comment just added reaches the card through its own reload; the feed is asked at once too, otherwise
  // an idle session (polled rarely) would show it only seconds later.
  const refreshFeed = feed.refresh;
  const commentCount = fallbackComments?.length ?? 0;
  useEffect(() => {
    if (commentCount > 0) refreshFeed();
  }, [commentCount, refreshFeed]);
  const fallback = useMemo<ConversationExtras>(() => ({ comments: fallbackComments ?? null, stages: [], delegations: [] }), [fallbackComments]);
  const plan = planStep(now);
  const agents = useAgents();
  const owner = agents.find((a) => a.id === now?.agent_id);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [away, setAway] = useState(false);
  const ownJump = useRef<(() => void) | null>(null);
  const jump = jumpRef ?? ownJump;
  const busy = pending || draft.trim() !== "";
  useEffect(() => onBusy?.(busy), [onBusy, busy]);

  /** Returns true on success: the caller then clears the draft or closes its dialog. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    setPending(true);
    try {
      await action();
      feed.refresh();
      onChanged?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setPending(false);
    }
  }

  const isTask = source.kind === "task";
  const phase = now?.phase;
  const mode = composerMode(source.kind, now, archived);
  const request = isTask && phase === "waiting_input" ? (now?.input_request ?? null) : null;
  const blocker = isTask && now?.blocker && now.blocker !== "needs_input" ? now.blocker : null;
  const begin = (action: () => Promise<unknown>) => (startWork ? startWork(action) : void run(action));
  const stop = () => (isTask ? setConfirmStop(true) : void run(() => api.stopChat(source.id)));

  return (
    <>
      <div className={cn("flex min-w-0 flex-col gap-2", className)}>
        <div className="flex flex-wrap items-center gap-2">
          {owner && (
            <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-[var(--ink)]">
              <AgentAvatar agent={owner} size={18} />
              {owner.name}
            </span>
          )}
          {now && <PhaseBadge phase={now.phase} />}
          <p className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink-muted)]" title={doingNow(now)}>
            {doingNow(now)}
          </p>
          {plan && now?.live && (
            <span className="shrink-0 text-[11px] text-[var(--ink-faint)]" title={plan.label}>
              {t("activity.planStep", { index: plan.index, total: plan.total, label: plan.label }).slice(0, 80)}
            </span>
          )}
          {now?.live && phase === "working" && (now.silent_sec ?? 0) >= SILENCE_WORTH_SAYING_SEC && (
            <span className="shrink-0 text-[11px] text-[var(--warn)]">
              {t("activity.silent", { duration: shortDuration(t, (now.silent_sec ?? 0) * 1000) })}
            </span>
          )}
          {isTask && onOpenTask && (
            <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => onOpenTask(source.id)}>
              {t("activity.openCard")}
            </Button>
          )}
        </div>

        {feed.error && <p className="text-[11px] text-[var(--warn)]">{t("activity.pollFailed", { error: feed.error })}</p>}

        {now && <Todos now={now} />}
        {now && <Processes source={source} now={now} />}

        <ConversationFeed
          source={source}
          events={feed.events}
          extras={feed.extras ?? fallback}
          now={now}
          loaded={feed.loaded}
          earlier={feed.earlier}
          loadingEarlier={feed.loadingEarlier}
          onLoadEarlier={() => void feed.loadEarlier()}
          scrollRoot={scrollRoot}
          startAtEnd={startAtEnd}
          onAway={setAway}
          jumpRef={jump}
          tailKey={request ? `request:${request.id}` : undefined}
          tail={
            request && (
              <InputRequestPanel
                request={request}
                pending={pending}
                onDecide={(decision: InputDecision) => run(() => api.answerInput(source.id, request.id, decision))}
              />
            )
          }
        />
      </div>

      {/* Pinned to the bottom of the scroll, on an opaque backing with a short fade above it, so the text
         scrolling under it does not show through (issue-detail.tsx in multica does the same). */}
      <div className="sticky bottom-0 z-10 -mb-4 mt-2 space-y-1.5 bg-[var(--surface)] pb-4 pt-1 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-4 before:bg-gradient-to-t before:from-[var(--surface)] before:to-transparent">
        {away && (
          <Button size="sm" icon={ArrowDown} className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 shadow" onClick={() => jump.current?.()}>
            {t("activity.jumpToLatest")}
          </Button>
        )}
        {blocker && (
          <Notice
            blocker={blocker}
            detail={now?.blocker_detail ?? null}
            code={now?.detail_code}
            pending={pending}
            onResolved={() => void run(() => api.patchTask(source.id, { blocker: null }))}
            onTrust={() => begin(() => api.trustAndRetry(source.id))}
          />
        )}
        {error && (
          <p role="alert" className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-1.5 text-[12px] text-[var(--danger)]">{error}</p>
        )}
        {now && mode && mode !== "request" && (
          <TaskComposer
            source={source}
            mode={mode}
            now={now}
            draft={draft}
            onDraft={setDraft}
            pending={pending}
            run={run}
            startWork={begin}
            onStop={stop}
            onForceClose={onForceClose}
            quickActions={quickActions}
          />
        )}
      </div>

      <Confirm
        open={confirmStop}
        title={t("activity.stopTitle")}
        confirmLabel={t("activity.stop")}
        pending={pending}
        onCancel={() => setConfirmStop(false)}
        onConfirm={() =>
          void run(() => api.stopTask(source.id)).then(() => {
            setConfirmStop(false);
          })
        }
      >
        <p>{t("activity.stopBody")}</p>
      </Confirm>
    </>
  );
}

/**
 * The panel in a pane of its own that scrolls: the agent window and the agent page. A log viewer opens at
 * the live end, where the agent is.
 */
export function ActivityPane({ paneClassName, ...props }: Omit<Props, "scrollRoot" | "startAtEnd"> & { paneClassName?: string }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setRoot} className={cn("min-h-0 overflow-y-auto overscroll-contain px-2 pb-4 pt-2", paneClassName)}>
      <ActivityPanel {...props} scrollRoot={root} startAtEnd />
    </div>
  );
}
