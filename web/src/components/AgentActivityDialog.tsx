import { useMemo, useState } from "react";
import { doingNow, type ActivitySource } from "../activity";
import type { Agent, AgentRun, AgentsActivity } from "../types";
import { Modal } from "../ui/Modal";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { useTranslation } from "../i18n";
import { ActivityPane, PhaseBadge } from "./ActivityPanel";

/** The label of a run: a task by its number, a chat as a chat, even when it has no title yet. */
export function useRunTitle() {
  const { t } = useTranslation();
  return (run: AgentRun) => (run.kind === "task" ? `#${run.id} ${run.title}` : run.title || t("activity.untitledChat"));
}

function sameRun(a: { kind: string; id: number } | null, b: AgentRun): boolean {
  return a !== null && a.kind === b.kind && a.id === b.id;
}

function RunButton({ run, selected, onSelect }: { run: AgentRun; selected: boolean; onSelect: () => void }) {
  const title = useRunTitle();
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
      <span className="truncate text-[12px] font-medium text-[var(--ink)]" title={title(run)}>{title(run)}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <PhaseBadge phase={run.now?.phase ?? (run.status as NonNullable<AgentRun["now"]>["phase"])} />
        <span className="min-w-0 truncate text-[11px] text-[var(--ink-faint)]">{doingNow(run.now)}</span>
      </span>
    </button>
  );
}

interface Props {
  /** null: tasks without an agent. */
  agent: Agent | null;
  activity: AgentsActivity | null;
  /** The run to open with; otherwise the first live one, otherwise the latest finished one. */
  initial?: { kind: "task" | "chat"; id: number } | null;
  onClose: () => void;
  onOpenTask: (id: number) => void;
  onChanged?: () => void;
}

/** An agent's work: what it is doing now and what it did last, with the full log of the chosen run. */
export function AgentActivityDialog({ agent, activity, initial = null, onClose, onOpenTask, onChanged }: Props) {
  const { t } = useTranslation();
  const agentId = agent?.id ?? null;
  const runs = useMemo(() => (activity?.runs ?? []).filter((r) => r.agent_id === agentId), [activity, agentId]);
  const recent = useMemo(() => (activity?.recent ?? []).filter((r) => r.agent_id === agentId), [activity, agentId]);
  const [picked, setPicked] = useState(initial);
  const selected = picked ?? runs[0] ?? recent[0] ?? null;
  const source: ActivitySource | null = selected ? { kind: selected.kind, id: selected.id } : null;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="xl"
      title={agent ? t("activity.dialogTitle", { name: agent.name }) : t("activity.dialogTitleNoAgent")}
    >
      <div className="flex h-[72vh] min-h-0 flex-col gap-3 md:flex-row">
        <nav aria-label={t("activity.runsLabel")} className="flex max-h-40 shrink-0 flex-col gap-3 overflow-y-auto md:max-h-none md:w-64">
          <section>
            <h3 className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)]">{t("activity.now")}</h3>
            {runs.length === 0 ? (
              <p className="px-2 text-[12px] text-[var(--ink-faint)]">{t("activity.notWorking")}</p>
            ) : (
              runs.map((run) => <RunButton key={`${run.kind}:${run.id}`} run={run} selected={sameRun(selected, run)} onSelect={() => setPicked(run)} />)
            )}
          </section>
          {recent.length > 0 && (
            <section>
              <h3 className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)]">{t("activity.recent")}</h3>
              {recent.map((run) => (
                <RunButton key={`${run.kind}:${run.id}`} run={run} selected={sameRun(selected, run)} onSelect={() => setPicked(run)} />
              ))}
            </section>
          )}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {source ? (
            <ActivityPane
              key={`${source.kind}:${source.id}`}
              source={source}
              onOpenTask={(id) => {
                onClose();
                onOpenTask(id);
              }}
              onChanged={onChanged}
              paneClassName="flex-1"
            />
          ) : (
            <p className="m-auto text-[12px] text-[var(--ink-faint)]">{t("activity.noRuns")}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
