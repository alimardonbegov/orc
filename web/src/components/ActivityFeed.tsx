import { memo, useEffect, useState } from "react";
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  FilePen,
  FileText,
  Globe,
  Loader2,
  Search,
  Terminal,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { fetchFullResult, notificationSummary, type ActivityRow, type ActivitySource } from "../activity";
import type { ActivityEvent, Agent } from "../types";
import { AgentAvatar } from "./AgentAvatar";
import { Button, IconButton } from "../ui/Button";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { useTranslation, type TFunction } from "../i18n";
import { DescriptionView } from "./DescriptionView";

const TOOL_ICONS: Record<string, LucideIcon> = {
  Bash: Terminal,
  Read: FileText,
  Write: FilePen,
  Edit: FilePen,
  NotebookEdit: FilePen,
  Grep: Search,
  Glob: Search,
  ToolSearch: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Agent: Bot,
  Task: Bot,
};

/** "12 s", "3 min 5 s", "2 h 4 min": a step's length, where "less than a minute" says nothing. */
export function shortDuration(t: TFunction, ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return t("activity.duration.seconds", { s: total });
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return t("activity.duration.minutes", { m: minutes, s: total % 60 });
  return t("activity.duration.hours", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

export function clock(at: string | null): string {
  if (!at) return "";
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Seconds for "running for N s": one timer, only while a tool is actually running. */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function Pre({ text }: { text: string }) {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[var(--sunken)] p-2 font-mono text-[11px] leading-snug text-[var(--ink-muted)]">
      {text}
    </pre>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={label}
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {
            // Clipboard unavailable: the text is on screen and can be selected.
          },
        );
      }}
    />
  );
}

type ToolProps = Pick<Extract<ActivityRow, { kind: "tool" }>, "use" | "result" | "interrupted"> & { source: ActivitySource; live: boolean };

// Events are stable objects, and rows are rebuilt on each new event: the memo holds by the events,
// otherwise every step on the screen would re-render on every new one.
export const ToolRow = memo(function ToolRow({ use, result, interrupted, source, live }: ToolProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [fullError, setFullError] = useState(false);
  const Icon = TOOL_ICONS[use.name] ?? Wrench;
  // A call without a result runs only while the session lives: after a stop it would spin forever.
  const running = result === null && !interrupted && live;
  const tick = useSecondTick(running);
  const startedAt = use.at ? Date.parse(use.at) : NaN;
  const finishedAt = result?.at ? Date.parse(result.at) : NaN;
  const elapsed = running ? tick - startedAt : finishedAt - startedAt;
  const output = full ?? result?.text ?? "";
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left hover:bg-[var(--sunken)]",
          focusRing,
        )}
      >
        <ChevronRight size={12} aria-hidden className={cn("shrink-0 text-[var(--ink-faint)] transition-transform duration-100", open && "rotate-90")} />
        <Icon size={13} aria-hidden className={cn("shrink-0", result?.is_error ? "text-[var(--danger)]" : "text-[var(--ink-muted)]")} />
        <span className="shrink-0 text-[12px] font-medium text-[var(--ink)]">{use.name}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ink-muted)]" title={use.description ?? use.summary}>
          {use.summary}
        </code>
        {result?.is_error && <XCircle size={12} aria-label={t("activity.toolFailed")} className="shrink-0 text-[var(--danger)]" />}
        {running && <Loader2 size={12} aria-label={t("activity.toolRunning")} className="shrink-0 animate-spin text-[var(--ink-muted)]" />}
        {result === null && !running && <span className="shrink-0 text-[11px] text-[var(--ink-faint)]">{t("activity.toolInterrupted")}</span>}
        {Number.isFinite(elapsed) && (
          <span className="tnum shrink-0 text-[11px] text-[var(--ink-faint)]">{shortDuration(t, elapsed)}</span>
        )}
      </button>
      {open && (
        <div className="ml-5 mt-1 space-y-1.5 pb-1">
          {use.description && <p className="text-[12px] text-[var(--ink-muted)]">{use.description}</p>}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[var(--ink-faint)]">{t("activity.input")}</span>
              <CopyButton text={use.input} label={t("activity.copy")} />
            </div>
            <Pre text={use.input} />
            {use.truncated && <p className="mt-0.5 text-[11px] text-[var(--ink-faint)]">{t("activity.inputCut")}</p>}
          </div>
          {result && (
            <div>
              <div className="flex items-center justify-between">
                <span className={cn("text-[11px]", result.is_error ? "text-[var(--danger)]" : "text-[var(--ink-faint)]")}>
                  {result.is_error ? t("activity.outputError") : t("activity.output")}
                </span>
                <CopyButton text={output} label={t("activity.copy")} />
              </div>
              {output ? <Pre text={output} /> : <p className="text-[11px] text-[var(--ink-faint)]">{t("activity.outputEmpty")}</p>}
              {result.truncated && full === null && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1"
                  onClick={() => {
                    setFullError(false);
                    fetchFullResult(source, result.session, result.offset, result.tool_use_id).then(
                      (r) => setFull(r.text),
                      () => setFullError(true),
                    );
                  }}
                >
                  {fullError ? t("activity.showAllFailed") : t("activity.showAll")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
});

function promptLabel(t: TFunction, origin: string): string {
  if (origin === "delivered") return t("activity.origin.delivered");
  if (origin === "scheduled") return t("activity.origin.scheduled");
  if (origin === "task_notification") return t("activity.origin.notification");
  return t("activity.origin.owner");
}

/** Who said it, in the same place every time: the thread is read by faces. */
export function Speaker({ face, name, at, children }: { face: React.ReactNode; name: string; at?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="mt-0.5 shrink-0">{face}</span>
      <div className="min-w-0 flex-1">
        <span className="mb-0.5 flex items-baseline gap-1.5 text-[11px] text-[var(--ink-faint)]">
          <span className="truncate text-[12px] font-medium text-[var(--ink)]">{name}</span>
          {at && <span className="tnum shrink-0">{clock(at)}</span>}
        </span>
        {children}
      </div>
    </div>
  );
}

function AgentFace({ agent }: { agent?: Pick<Agent, "id" | "name" | "avatar"> | null }) {
  if (agent) return <AgentAvatar agent={agent} size={20} title="" />;
  return (
    <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--sunken)] text-[var(--ink-muted)]">
      <Bot size={12} />
    </span>
  );
}

export const EventRow = memo(function EventRow({ event, agent, agentFace = false }: {
  event: Exclude<ActivityEvent, { kind: "tool_use" | "tool_result" }>;
  /** The agent of the session, when known: its words in the thread carry its face and name. */
  agent?: Pick<Agent, "id" | "name" | "avatar"> | null;
  /** Show the speaker: true in the thread, false in a list of steps, where the agent is implied. */
  agentFace?: boolean;
}) {
  const { t } = useTranslation();
  if (event.kind === "prompt") {
    const agentOwn = event.origin === "scheduled" || event.origin === "task_notification";
    return (
      <li className={cn("rounded-[var(--radius-sm)] border-l-2 bg-[var(--sunken)] px-2.5 py-1.5", agentOwn ? "border-[var(--line-strong)]" : "border-[var(--st-todo)]")}>
        <span className="block text-[11px] text-[var(--ink-faint)]">{promptLabel(t, event.origin)} · {clock(event.at)}</span>
        {agentOwn ? (
          <p className="text-[12px] text-[var(--ink-muted)]">{notificationSummary(event.text)}</p>
        ) : (
          <div className="max-h-48 overflow-y-auto"><DescriptionView text={event.text} compact className="text-[13px] leading-relaxed" /></div>
        )}
      </li>
    );
  }
  if (event.kind === "text") {
    const body = (
      <>
        <DescriptionView text={event.text} compact className="text-[13px] leading-relaxed text-[var(--ink)]" />
        {event.truncated && <p className="mt-0.5 text-[11px] text-[var(--ink-faint)]">{t("activity.textCut")}</p>}
      </>
    );
    return (
      <li className="px-1.5 py-1">
        {agentFace ? (
          <Speaker face={<AgentFace agent={agent} />} name={agent?.name ?? t("card.presence.noAgentName")} at={event.at}>
            {body}
          </Speaker>
        ) : (
          body
        )}
      </li>
    );
  }
  if (event.kind === "thinking") {
    return (
      <li className="flex items-start gap-1.5 px-1.5 py-1 text-[12px] leading-relaxed text-[var(--ink-muted)]">
        <Brain size={12} aria-hidden className="mt-1 shrink-0 text-[var(--ink-faint)]" />
        {event.text ? (
          <p className="min-w-0 whitespace-pre-wrap italic">{event.text}</p>
        ) : (
          <p className="text-[var(--ink-faint)]">{t("activity.thoughtFor", { duration: shortDuration(t, event.duration_ms ?? 0) })}</p>
        )}
      </li>
    );
  }
  if (event.notice === "error") {
    return (
      <li className="flex items-start gap-1.5 rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-2 py-1 text-[12px] text-[var(--danger)]">
        <XCircle size={12} aria-hidden className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{event.text || t("activity.apiError")}</span>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 py-1 text-[11px] text-[var(--ink-faint)]">
      <span className="h-px flex-1 bg-[var(--line)]" />
      {event.notice === "turn_end" ? t("activity.turnEnded", { duration: shortDuration(t, event.duration_ms ?? 0) }) : t("activity.compacted")}
      <span className="h-px flex-1 bg-[var(--line)]" />
    </li>
  );
});
