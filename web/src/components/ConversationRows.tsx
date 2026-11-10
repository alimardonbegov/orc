import { explainFailure } from "../failures";
import { useState } from "react";
import { Bot, Check, ChevronRight, CornerDownRight, Flag, Loader2, MessageCircleQuestion, StickyNote, XCircle } from "lucide-react";
import { buildRows, useActivityFeed, type ActivitySource, type ConversationRow, type StepRow } from "../activity";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { useTranslation, type TFunction } from "../i18n";
import { DescriptionView } from "./DescriptionView";
import type { Agent } from "../types";
import { EventRow, ToolRow, clock } from "./ActivityFeed";
import { PersonAvatar } from "./cardProperties/AgentProperty";

type Of<K extends ConversationRow["kind"]> = Extract<ConversationRow, { kind: K }>;

/** Steps as a list: a call with its result, or an event as it is. */
export function StepList({ rows, source, live }: { rows: readonly StepRow[]; source: ActivitySource; live: boolean }) {
  return (
    <ul className="space-y-0.5">
      {rows.map((row) =>
        row.kind === "tool" ? (
          <ToolRow key={row.id} use={row.use} result={row.result} interrupted={row.interrupted} source={source} live={live} />
        ) : (
          <EventRow key={row.id} event={row.event} />
        ),
      )}
    </ul>
  );
}

function commentLabel(t: TFunction, kind: string): string {
  if (kind === "comment") return t("activity.noteLabel");
  if (kind === "rework") return t("activity.rework");
  if (kind === "subtasks_done") return t("activity.subtasksDone");
  if (kind === "report") return t("taskModal.reportArchivedLabel");
  return t("activity.toAgent");
}

/** What became of a message on its way to the agent. Plain notes and old reports have no receipt. */
function receipt(row: Of<"comment">): "read" | "failed" | "waiting" | null {
  if (row.comment.kind !== "answer" && row.comment.kind !== "rework") return null;
  if (row.read) return "read";
  if (row.comment.delivery === "failed") return "failed";
  return row.comment.delivery ? "waiting" : null;
}

export function CommentLine({ row }: { row: Of<"comment"> }) {
  const { t } = useTranslation();
  const { comment } = row;
  const note = comment.kind === "comment";
  const state = receipt(row);
  return (
    <li
      className={cn(
        "rounded-[var(--radius-sm)] border-l-2 bg-[var(--sunken)] px-2.5 py-1.5 text-[13px] leading-relaxed",
        note ? "border-[var(--line-strong)]" : "border-[var(--st-todo)]",
        comment.kind === "report" && "border-dashed opacity-80",
      )}
    >
      <span className="mb-0.5 flex items-center gap-1.5 text-[11px] text-[var(--ink-faint)]">
        {/* The label already says "you, to the agent": here the owner only needs a face */}
        {comment.author === "user" ? (
          <PersonAvatar size={16} />
        ) : note ? (
          <StickyNote size={11} aria-hidden />
        ) : (
          <CornerDownRight size={11} aria-hidden />
        )}
        {commentLabel(t, comment.kind)} · {clock(comment.created_at)}
        {state && (
          <span className={cn("ml-auto inline-flex items-center gap-0.5", state === "failed" ? "text-[var(--danger)]" : state === "read" ? "text-[var(--st-todo)]" : undefined)}>
            {state === "read" && <Check size={11} aria-hidden />}
            {state === "read" ? t("activity.receiptRead") : state === "failed" ? t("activity.receiptFailed") : t("activity.receiptWaiting")}
          </span>
        )}
      </span>
      <DescriptionView text={comment.body} compact />
    </li>
  );
}

/** What orc itself said to the session: the task statement, a failed check, a resume after a crash. */
export function HandoffLine({ row }: { row: Of<"handoff"> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <li className="px-1.5 py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn("flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] text-left text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink-muted)]", focusRing)}
      >
        <ChevronRight size={11} aria-hidden className={cn("transition-transform duration-100", open && "rotate-90")} />
        {row.first ? t("activity.handoffFirst") : t("activity.handoff")} · {clock(row.event.at)}
      </button>
      {open && (
        <div className="ml-4 mt-1 max-h-60 overflow-y-auto rounded-[var(--radius-sm)] bg-[var(--sunken)] px-2.5 py-1.5">
          <DescriptionView text={row.event.text} compact className="text-[12px] leading-relaxed text-[var(--ink-muted)]" />
        </div>
      )}
    </li>
  );
}

/** A moment in the task's life: the work started, verification failed, the result was merged. */
export function StageLine({ row }: { row: Of<"stage"> }) {
  const error = row.stage.level === "error";
  return (
    <li className={cn("flex items-center gap-2 py-1 text-[11px]", error ? "text-[var(--danger)]" : "text-[var(--ink-faint)]")}>
      <span className="h-px flex-1 bg-[var(--line)]" />
      <Flag size={10} aria-hidden />
      <span className="min-w-0 truncate" title={row.stage.text}>{row.stage.text}</span>
      <span className="tnum shrink-0">{clock(row.stage.at)}</span>
      <span className="h-px flex-1 bg-[var(--line)]" />
    </li>
  );
}

/** The question at the end of a turn waits for the owner: a mark under the message, or the message itself. */
export function WaitingLine({ row, agent }: { row: Of<"waiting">; agent: Pick<Agent, "id" | "name" | "avatar"> | undefined }) {
  const { t } = useTranslation();
  const mark = (
    <span data-testid="waiting-mark" className="ml-7 inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--st-blocked)_14%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--st-blocked)]">
      <MessageCircleQuestion size={11} aria-hidden />
      {t("activity.phase.waiting_reply")}
    </span>
  );
  if (!row.text) return <li className="px-1.5">{mark}</li>;
  return (
    <>
      <EventRow event={{ id: row.id, session: 0, offset: 0, at: null, kind: "text", text: row.text, truncated: false }} agent={agent} agentFace />
      <li className="px-1.5">{mark}</li>
    </>
  );
}

/** Why the task stopped, in full and in its place in time: a crash or a check can run long, so it folds. */
export function FailureLine({ row }: { row: Of<"failure"> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // A known reason reads as a sentence with a next step; the raw text waits behind a click
  const explained = explainFailure(t, row.code);
  const long = row.detail.length > 240 || row.detail.split("\n").length > 4;
  return (
    <li data-testid="failure-row" className="rounded-[var(--radius-sm)] border border-[color-mix(in_oklab,var(--st-failed)_40%,transparent)] px-2.5 py-1.5">
      <span className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-[var(--st-failed)]">
        <XCircle size={11} aria-hidden />
        {t("taskModal.failedHeading")}
        {row.at && <span className="tnum ml-auto font-normal text-[var(--ink-faint)]">{clock(row.at)}</span>}
      </span>
      {explained && (
        <>
          <p data-testid="failure-reason" className="text-[12px] font-medium leading-relaxed text-[var(--ink)]">{explained.reason}</p>
          <p data-testid="failure-hint" className="text-[12px] leading-relaxed text-[var(--ink-muted)]">{explained.hint}</p>
          {row.detail && (
            <>
              <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn("mt-0.5 text-[11px] text-[var(--ink-muted)] underline underline-offset-2 hover:text-[var(--ink)]", focusRing)}>
                {open ? t("card.failure.hideDetails") : t("card.failure.details")}
              </button>
              {open && <p data-testid="failure-detail" className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--ink-muted)]">{row.detail}</p>}
            </>
          )}
        </>
      )}
      {!explained && <p className={cn("whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--ink)]", long && !open && "line-clamp-4")}>{row.detail}</p>}
      {!explained && long && (
        <button type="button" onClick={() => setOpen(!open)} className={cn("mt-0.5 text-[11px] text-[var(--ink-muted)] underline underline-offset-2 hover:text-[var(--ink)]", focusRing)}>
          {open ? t("activity.showLess") : t("activity.showMore")}
        </button>
      )}
    </li>
  );
}

/** Steps in a row, folded: the owner reads the messages and opens the steps when curious. */
export function StepsLine({ row, source, live, openByDefault }: { row: Of<"steps">; source: ActivitySource; live: boolean; openByDefault: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(openByDefault);
  const errors = row.rows.filter((r) => (r.kind === "tool" && r.result?.is_error) || (r.kind === "event" && r.event.kind === "notice" && r.event.level === "error")).length;
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn("flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left text-[11px] text-[var(--ink-faint)] hover:bg-[var(--sunken)]", focusRing)}
      >
        <ChevronRight size={11} aria-hidden className={cn("transition-transform duration-100", open && "rotate-90")} />
        {t("activity.steps", { count: row.rows.length })}
        {errors > 0 && <span className="text-[var(--danger)]">· {t("activity.errors", { count: errors })}</span>}
      </button>
      {open && (
        <div className="ml-3 border-l border-[var(--line)] pl-1.5">
          <StepList rows={row.rows} source={source} live={live} />
        </div>
      )}
    </li>
  );
}

/** The steps of one subagent. A separate component so that its feed is polled only while it is open. */
function SubagentSteps({ source, live }: { source: ActivitySource; live: boolean }) {
  const { t } = useTranslation();
  const feed = useActivityFeed(source);
  const rows = buildRows(feed.events).filter((r): r is StepRow => r.kind === "tool" || r.kind === "event");
  if (rows.length === 0) return <p className="py-1 text-[11px] text-[var(--ink-faint)]">{feed.loaded ? t("activity.empty") : t("common.loading")}</p>;
  return <StepList rows={rows} source={source} live={live} />;
}

/** Work handed to a subagent. It is never folded away: who does the work is part of the story. */
export function DelegateLine({ row, source, live }: { row: Of<"delegate">; source: ActivitySource; live: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { use } = row.row;
  const name = row.delegation?.agent_type ?? use.delegate?.agent_type ?? t("activity.aSubagent");
  const answer = row.state === "done" ? row.row.result?.text : "";
  return (
    <li className="min-w-0 rounded-[var(--radius-sm)] border border-[var(--line)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn("flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-[var(--sunken)]", focusRing)}
      >
        <ChevronRight size={12} aria-hidden className={cn("shrink-0 text-[var(--ink-faint)] transition-transform duration-100", open && "rotate-90")} />
        <Bot size={13} aria-hidden className="shrink-0 text-[var(--ink-muted)]" />
        <span className="shrink-0 text-[12px] font-medium text-[var(--ink)]">{t("activity.delegated", { name })}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink-muted)]" title={use.delegate?.description}>{use.delegate?.description}</span>
        {row.state === "running" && <Loader2 size={12} aria-label={t("activity.toolRunning")} className="shrink-0 animate-spin text-[var(--ink-muted)]" />}
        {row.state === "done" && <Check size={12} aria-label={t("activity.processDone")} className="shrink-0 text-[var(--ink-faint)]" />}
        {row.state === "failed" && <XCircle size={12} aria-label={t("activity.processFailed")} className="shrink-0 text-[var(--danger)]" />}
        {row.state === "interrupted" && <span className="shrink-0 text-[11px] text-[var(--ink-faint)]">{t("activity.toolInterrupted")}</span>}
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2">
          {row.delegation && <SubagentSteps source={{ ...source, agent: row.delegation.agent_id }} live={live && row.state === "running"} />}
          {answer && (
            <div className="max-h-60 overflow-y-auto rounded-[var(--radius-sm)] bg-[var(--sunken)] px-2.5 py-1.5">
              <DescriptionView text={answer} compact className="text-[12px] leading-relaxed text-[var(--ink-muted)]" />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
