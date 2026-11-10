import { useMemo, useState } from "react";
import { ArrowLeft, MessageSquare, Pencil } from "lucide-react";
import { doingNow, type ActivitySource } from "../activity";
import { api } from "../api";
import { formatDuration, relativeTime } from "../dates";
import { useNow } from "../hooks/useNow";
import { usePolling } from "../hooks/usePolling";
import { cn } from "../lib/cn";
import { modelLabel } from "../models";
import type { ActivityPhase, Agent, AgentRun, AgentWork, AgentWorkRun, AgentsActivity, Project } from "../types";
import { formatCost, formatExact, formatTokens } from "../usage";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Segmented";
import { focusRing } from "../ui/tokens";
import { useTranslation, type TFunction } from "../i18n";
import { ActivityPane, PhaseBadge } from "./ActivityPanel";
import { AgentAvatar } from "./AgentAvatar";
import { useRunTitle } from "./AgentActivityDialog";

/** How often the history and the totals are refreshed. They come from the database, not from live sessions. */
const WORK_POLL_MS = 10_000;
const PAGE_SIZE = 50;
/** How many finished runs the activity tab lists next to the live ones. */
const RECENT_IN_LIST = 12;

type Tab = "activity" | "history" | "usage";

interface Props {
  agent: Agent;
  projects: Project[];
  /** The page's own poll of who is working (shared with the list of agents). */
  activity: AgentsActivity | null;
  onBack: () => void;
  onEdit: () => void;
  onChat: () => void;
  onOpenTask: (id: number) => void;
  onActivityChanged: () => void;
}

interface RunRef {
  kind: "task" | "chat";
  id: number;
}

const same = (a: RunRef | null, kind: string, id: number) => a !== null && a.kind === kind && a.id === id;

/** The phase badge of a history row: a task by its status, a chat by its turn state. */
function rowPhase(run: AgentWorkRun): ActivityPhase {
  if (run.kind === "task") return run.status as ActivityPhase;
  return ({ queued: "starting", running: "working", waiting: "waiting_input", idle: "idle" } as Record<string, ActivityPhase>)[run.status] ?? "idle";
}

function ms(raw: string | null): number | null {
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

function runTitle(t: TFunction, run: Pick<AgentWorkRun, "kind" | "id" | "title">): string {
  return run.kind === "task" ? `#${run.id} ${run.title}` : run.title || t("activity.untitledChat");
}

function Tile({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div data-testid={testId} className="min-w-0 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5">
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)]">{label}</p>
      <p className="mt-0.5 truncate text-[18px] font-semibold tracking-tight text-[var(--ink)]">{value}</p>
      {sub && <p className="truncate text-[11px] text-[var(--ink-muted)]" title={sub}>{sub}</p>}
    </div>
  );
}

/** Live status of the agent as one phrase with a pulsing dot while it works. */
function StatusLine({ live, runs, work }: { live: AgentRun[]; runs: AgentWorkRun[]; work: AgentWork | null }) {
  const { t, language } = useTranslation();
  const now = useNow();
  if (live.length > 0) {
    return (
      <span role="status" data-testid="agent-live-status" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--st-progress)]">
        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-[var(--st-progress)]" />
        {t("agents.detail.statusWorking", { count: live.length })}
      </span>
    );
  }
  const last = runs.map((r) => ms(r.finished_at) ?? ms(r.updated_at)).filter((x): x is number => x !== null).sort((a, b) => b - a)[0];
  return (
    <span role="status" data-testid="agent-live-status" className="inline-flex items-center gap-1.5 text-[12px] text-[var(--ink-muted)]">
      <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--line-strong)]" />
      {t("agents.detail.statusIdle")}
      <span className="text-[var(--ink-faint)]">
        · {last !== undefined ? t("agents.detail.lastActive", { when: relativeTime(last, language, now) }) : work ? t("agents.detail.neverWorked") : ""}
      </span>
    </span>
  );
}

function RunButton({ title, phase, line, selected, onSelect }: { title: string; phase: ActivityPhase; line: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 flex-col gap-0.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-[var(--sunken)]",
        selected && "bg-[var(--sunken)]",
        focusRing,
      )}
    >
      <span className="truncate text-[12px] font-medium text-[var(--ink)]" title={title}>{title}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <PhaseBadge phase={phase} />
        <span className="min-w-0 truncate text-[11px] text-[var(--ink-faint)]">{line}</span>
      </span>
    </button>
  );
}

function ActivityTab({ agent, live, recent, picked, onPick, onOpenTask, onChanged }: {
  agent: Agent;
  live: AgentRun[];
  recent: AgentWorkRun[];
  picked: RunRef | null;
  onPick: (pick: RunRef) => void;
  onOpenTask: (id: number) => void;
  onChanged: () => void;
}) {
  const { t, language } = useTranslation();
  const now = useNow();
  const title = useRunTitle();
  const finished = recent.filter((r) => !r.live && !live.some((l) => l.kind === r.kind && l.id === r.id)).slice(0, RECENT_IN_LIST);
  const selected = picked ?? (live[0] ? { kind: live[0].kind, id: live[0].id } : finished[0] ? { kind: finished[0].kind, id: finished[0].id } : null);
  const source: ActivitySource | null = selected ? { kind: selected.kind, id: selected.id } : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row" data-agent={agent.id}>
      <nav aria-label={t("activity.runsLabel")} className="flex max-h-48 shrink-0 flex-col gap-3 overflow-y-auto md:max-h-none md:w-72">
        <section>
          <h3 className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)]">{t("activity.now")}</h3>
          {live.length === 0 ? (
            <p className="px-2 text-[12px] text-[var(--ink-faint)]">{t("activity.notWorking")}</p>
          ) : (
            live.map((run) => {
              const began = ms(run.started_at);
              const since = began !== null ? t("agents.detail.workingFor", { duration: formatDuration(t, now - began) }) : "";
              return (
                <RunButton
                  key={`${run.kind}:${run.id}`}
                  title={title(run)}
                  phase={run.now?.phase ?? (run.status as ActivityPhase)}
                  line={[since, doingNow(run.now)].filter(Boolean).join(" · ")}
                  selected={same(selected, run.kind, run.id)}
                  onSelect={() => onPick({ kind: run.kind, id: run.id })}
                />
              );
            })
          )}
        </section>
        {finished.length > 0 && (
          <section>
            <h3 className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)]">{t("activity.recent")}</h3>
            {finished.map((run) => {
              const at = ms(run.finished_at) ?? ms(run.updated_at);
              return (
                <RunButton
                  key={`${run.kind}:${run.id}`}
                  title={runTitle(t, run)}
                  phase={rowPhase(run)}
                  line={at !== null ? relativeTime(at, language, now) : ""}
                  selected={same(selected, run.kind, run.id)}
                  onSelect={() => onPick({ kind: run.kind, id: run.id })}
                />
              );
            })}
          </section>
        )}
      </nav>
      <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)]">
        {source ? (
          <ActivityPane
            key={`${source.kind}:${source.id}`}
            source={source}
            onOpenTask={onOpenTask}
            onChanged={onChanged}
            paneClassName="max-h-[75vh] flex-1 rounded-[var(--radius-md)]"
          />
        ) : (
          <p className="m-auto text-[12px] text-[var(--ink-faint)]">{t("agents.detail.pickRun")}</p>
        )}
      </div>
    </div>
  );
}

function HistoryTab({ work, projects, onOpen, more }: { work: AgentWork; projects: Project[]; onOpen: (run: AgentWorkRun) => void; more: (() => void) | null }) {
  const { t, language } = useTranslation();
  const now = useNow();
  if (work.runs.length === 0) return <p className="m-auto py-12 text-[13px] text-[var(--ink-faint)]">{t("agents.detail.historyEmpty")}</p>;
  const head = "px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)]";
  return (
    <div className="min-w-0">
      <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)]">
        <table className="w-full min-w-[640px] border-collapse text-[12px]">
          <thead className="border-b border-[var(--line)]">
            <tr>
              <th className={head}>{t("agents.detail.colRun")}</th>
              <th className={head}>{t("agents.detail.colProject")}</th>
              <th className={head}>{t("agents.detail.colStatus")}</th>
              <th className={head}>{t("agents.detail.colStarted")}</th>
              <th className={cn(head, "text-right")}>{t("agents.detail.colDuration")}</th>
              <th className={cn(head, "text-right")}>{t("agents.detail.colTokens")}</th>
              <th className={cn(head, "text-right")}>{t("agents.detail.colCost")}</th>
            </tr>
          </thead>
          <tbody>
            {work.runs.map((run) => {
              const began = ms(run.started_at);
              const ended = run.live ? now : ms(run.finished_at);
              const project = run.project_id === null ? null : projects.find((p) => p.id === run.project_id);
              const label = runTitle(t, run);
              return (
                <tr key={`${run.kind}:${run.id}`} className="border-b border-[var(--line)] last:border-b-0 hover:bg-[var(--sunken)]">
                  <td className="max-w-[18rem] px-2 py-1.5">
                    <button
                      type="button"
                      aria-label={t("agents.detail.openLog", { title: label })}
                      onClick={() => onOpen(run)}
                      className={cn("flex max-w-full items-center gap-1.5 text-left font-medium text-[var(--ink)] hover:underline", focusRing)}
                    >
                      <span className="truncate" title={label}>{label}</span>
                      {run.kind === "chat" && <Badge>{t("agents.detail.kindChat")}</Badge>}
                      {run.archived && <Badge>{t("agents.detail.archived")}</Badge>}
                    </button>
                  </td>
                  <td className="max-w-[10rem] truncate px-2 py-1.5 text-[var(--ink-muted)]">{project ? project.name : t("agents.detail.noProject")}</td>
                  <td className="px-2 py-1.5"><PhaseBadge phase={rowPhase(run)} /></td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-[var(--ink-muted)]">{began !== null ? relativeTime(began, language, now) : "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-[var(--ink-muted)]">
                    {began !== null && ended !== null && ended >= began ? formatDuration(t, ended - began) : "—"}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-[var(--ink)]" title={formatExact(run.tokens)}>{run.tokens > 0 ? formatTokens(run.tokens) : "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-[var(--ink-muted)]">{run.cost_usd !== null ? formatCost(run.cost_usd) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {more && (
        <div className="mt-2 flex justify-center">
          <Button variant="secondary" size="sm" onClick={more}>
            {t("agents.detail.showMore", { count: work.total_runs - work.runs.length })}
          </Button>
        </div>
      )}
    </div>
  );
}

function UsageTab({ work }: { work: AgentWork }) {
  const { t, language } = useTranslation();
  const { summary, daily } = work;
  const peak = Math.max(...daily.map((d) => d.tokens), 1);
  const models = Object.entries(summary.models);
  const modelPeak = Math.max(...models.map(([, n]) => n), 1);
  if (summary.tokens === 0) return <p className="m-auto py-12 text-[13px] text-[var(--ink-faint)]">{t("agents.detail.usageNone")}</p>;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="min-w-0 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-3">
        <h3 className="text-[12px] font-medium text-[var(--ink)]">{t("agents.detail.usageDaily")}</h3>
        <div className="mt-3 flex h-32 items-end gap-1" role="img" aria-label={t("agents.detail.usageDaily")}>
          {daily.map((d) => (
            <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${new Date(`${d.day}T12:00:00`).toLocaleDateString(language, { day: "numeric", month: "short" })}: ${formatExact(d.tokens)}${d.cost_usd > 0 ? ` · ${formatCost(d.cost_usd)}` : ""}`}>
              <div className="w-full rounded-t-[3px] bg-[var(--st-progress)]" style={{ height: `${Math.max(d.tokens > 0 ? 4 : 0, (d.tokens / peak) * 100)}%`, opacity: d.tokens > 0 ? 1 : 0.15 }} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-[var(--ink-faint)]">
          <span>{new Date(`${daily[0].day}T12:00:00`).toLocaleDateString(language, { day: "numeric", month: "short" })}</span>
          <span>{new Date(`${daily[daily.length - 1].day}T12:00:00`).toLocaleDateString(language, { day: "numeric", month: "short" })}</span>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-[var(--ink-faint)]">{t("agents.detail.usageDailyNote")}</p>
      </section>
      <section className="min-w-0 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-3">
        <h3 className="text-[12px] font-medium text-[var(--ink)]">{t("agents.detail.usageModels")}</h3>
        <ul className="mt-3 space-y-2">
          {models.map(([model, tokens]) => (
            <li key={model} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="truncate text-[var(--ink)]" title={model}>{modelLabel(model)}</span>
                <span className="shrink-0 tabular-nums text-[var(--ink-muted)]" title={formatExact(tokens)}>{formatTokens(tokens)}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-[var(--sunken)]">
                <div className="h-full rounded-full bg-[var(--st-progress)]" style={{ width: `${(tokens / modelPeak) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * One agent on its own page: whether it is at work and for how long, what it is doing, the log of any of
 * its runs, the history across all projects and what it has spent. Tasks and chats are listed together,
 * because for the agent they are the same thing: a session it ran.
 */
export function AgentDetailPage({ agent, projects, activity, onBack, onEdit, onChat, onOpenTask, onActivityChanged }: Props) {
  const { t } = useTranslation();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("activity");
  const [picked, setPicked] = useState<RunRef | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const poll = usePolling(() => api.agentWork(agent.id, limit), WORK_POLL_MS, [agent.id, limit]);
  const work = poll.data;
  const live = useMemo(() => (activity?.runs ?? []).filter((r) => r.agent_id === agent.id), [activity, agent.id]);
  const runs = work?.runs ?? [];

  const longest = live.reduce<number | null>((max, run) => {
    const began = ms(run.started_at);
    return began !== null && (max === null || began < max) ? began : max;
  }, null);
  const summary = work?.summary;
  const params = [agent.model ? modelLabel(agent.model) : t("agents.modelInherited"), agent.effort, agent.permission_mode].filter(Boolean).join(" · ");
  const cost = summary?.cost_usd != null ? t("agents.detail.tileTokensCost", { cost: formatCost(summary.cost_usd) }) : undefined;

  const open = (run: RunRef) => {
    setPicked(run);
    setTab("activity");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack} className="mb-2 self-start">
        {t("agents.detail.back")}
      </Button>
      <header className="mb-4 flex flex-wrap items-start gap-3">
        <AgentAvatar agent={agent} size={48} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[18px] font-semibold tracking-tight text-[var(--ink)]">{agent.name}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <StatusLine live={live} runs={runs} work={work} />
            <span className="truncate font-mono text-[11px] text-[var(--ink-faint)]" title={params}>{params}</span>
          </div>
          {agent.description && <p className="mt-1 max-w-2xl text-[12px] leading-snug text-[var(--ink-muted)]">{agent.description}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" icon={MessageSquare} onClick={onChat}>{t("agents.chat")}</Button>
          <Button variant="ghost" size="sm" icon={Pencil} onClick={onEdit}>{t("common.edit")}</Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          testId="tile-now"
          label={t("agents.detail.tileNow")}
          value={live.length > 0 ? t("agents.detail.tileNowLive", { count: live.length }) : t("agents.detail.tileNowIdle")}
          sub={longest !== null ? t("agents.detail.tileLongest", { duration: formatDuration(t, now - longest) }) : undefined}
        />
        <Tile
          testId="tile-tasks"
          label={t("agents.detail.tileTasks")}
          value={String(summary?.tasks_total ?? agent.tasks.total)}
          sub={summary ? [t("agents.detail.tileTasksSub", { done: summary.tasks_done, failed: summary.tasks_failed }), summary.chats_total > 0 ? t("agents.detail.tileChats", { count: summary.chats_total }) : ""].filter(Boolean).join(" · ") : undefined}
        />
        <Tile testId="tile-tokens" label={t("agents.detail.tileTokens")} value={summary ? formatTokens(summary.tokens) : "—"} sub={cost} />
        <Tile
          testId="tile-time"
          label={t("agents.detail.tileTime")}
          value={summary && summary.busy_ms > 0 ? formatDuration(t, summary.busy_ms) : "—"}
          sub={summary ? (summary.avg_run_ms !== null ? t("agents.detail.tileTimeAvg", { duration: formatDuration(t, summary.avg_run_ms) }) : t("agents.detail.tileTimeNone")) : undefined}
        />
      </div>

      <Segmented
        ariaLabel={t("agents.detail.tabsLabel")}
        className="mb-3 self-start"
        value={tab}
        onChange={setTab}
        options={[
          { value: "activity", label: t("agents.detail.tabActivity") },
          { value: "history", label: t("agents.detail.tabHistory") },
          { value: "usage", label: t("agents.detail.tabUsage") },
        ]}
      />

      {tab === "activity" && (
        <ActivityTab agent={agent} live={live} recent={runs} picked={picked} onPick={setPicked} onOpenTask={onOpenTask} onChanged={onActivityChanged} />
      )}
      {tab === "history" && work && (
        <HistoryTab work={work} projects={projects} onOpen={open} more={work.total_runs > work.runs.length && work.runs.length >= limit ? () => setLimit((n) => n + PAGE_SIZE) : null} />
      )}
      {tab === "usage" && work && <UsageTab work={work} />}
    </div>
  );
}
