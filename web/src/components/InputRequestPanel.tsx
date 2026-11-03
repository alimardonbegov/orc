import { useState } from "react";
import { Check, ShieldCheck, ShieldX, X } from "lucide-react";
import type { InputDecision, InputRequest, Question } from "../types";
import { inputKindLabel } from "../labels";
import { BLOCKER_META } from "../status";
import { Button } from "../ui/Button";
import { Input, Textarea } from "../ui/Field";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { useTranslation } from "../i18n";

interface Props {
  request: InputRequest;
  pending: boolean;
  /** Submit the decision. Returns true on success: the panel then resets the draft. */
  onDecide: (decision: InputDecision) => Promise<boolean>;
}

/** Key under which a tool holds its most essential value: command, path, query. */
const MAIN_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "prompt", "description"] as const;

function mainLine(toolInput: Record<string, unknown> | null): string | null {
  if (!toolInput) return null;
  for (const key of MAIN_KEYS) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * "Agent is waiting for a human" panel: what stands at the very top of the card while the session
 * hook holds the tool and waits for a decision (see docs/internals/input-requests.md).
 *
 * Three forms for three kinds of request: permission (allow / deny), a question with options
 * (option buttons plus a custom answer), a plan (approve / send back with comments). There is
 * deliberately no general "reply for Claude" field here: text sent outside a request will not reach
 * the session, which makes no tool calls while it sits on a dialog.
 */
export function InputRequestPanel({ request, pending, onDecide }: Props) {
  const { t } = useTranslation();
  const Icon = BLOCKER_META.needs_input.icon;
  return (
    <section
      data-testid="input-request"
      className="overflow-hidden rounded-[var(--radius-sm)] border border-[color-mix(in_oklab,var(--st-blocked)_40%,transparent)]"
    >
      <div className="flex items-center gap-1.5 bg-[color-mix(in_oklab,var(--st-blocked)_14%,transparent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--st-blocked)]">
        <Icon size={13} aria-hidden />
        {t("inputRequestPanel.agentHeading", { kind: inputKindLabel(t, request.kind) })}
      </div>
      <div className="space-y-3 p-3">
        {request.kind === "permission" && <PermissionForm request={request} pending={pending} onDecide={onDecide} />}
        {request.kind === "question" && <QuestionForm request={request} pending={pending} onDecide={onDecide} />}
        {request.kind === "plan" && <PlanForm request={request} pending={pending} onDecide={onDecide} />}
      </div>
    </section>
  );
}

/** Tool input as is, for when the main line is not enough. */
function RawInput({ toolInput }: { toolInput: Record<string, unknown> | null }) {
  const { t } = useTranslation();
  if (!toolInput || Object.keys(toolInput).length === 0) return null;
  return (
    <details className="text-[11px] text-[var(--ink-faint)]">
      <summary className="cursor-pointer select-none hover:text-[var(--ink-muted)]">{t("inputRequestPanel.callParams")}</summary>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] bg-[var(--sunken)] p-2 font-mono text-[11px] text-[var(--ink-muted)]">
        {JSON.stringify(toolInput, null, 2)}
      </pre>
    </details>
  );
}

function PermissionForm({ request, pending, onDecide }: Props) {
  const { t } = useTranslation();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const line = mainLine(request.tool_input);
  return (
    <>
      <div className="space-y-1">
        <p className="text-[13px] leading-relaxed">
          {t("inputRequestPanel.permissionIntro")} <span className="font-mono text-[12px] font-medium">{request.tool_name}</span>
        </p>
        {line && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] bg-[var(--sunken)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--ink)]">
            {line}
          </pre>
        )}
        <RawInput toolInput={request.tool_input} />
      </div>
      {denying ? (
        <div className="space-y-2">
          <Textarea
            placeholder={t("inputRequestPanel.denyPlaceholder")}
            className="min-h-16"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setDenying(false)} disabled={pending}>
              {t("inputRequestPanel.back")}
            </Button>
            <Button
              variant="danger"
              icon={ShieldX}
              loading={pending}
              onClick={() => void onDecide({ behavior: "deny", message: reason.trim() || undefined })}
            >
              {t("inputRequestPanel.deny")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" icon={ShieldX} onClick={() => setDenying(true)} disabled={pending}>
            {t("inputRequestPanel.denyEllipsis")}
          </Button>
          <Button
            icon={ShieldCheck}
            loading={pending}
            title={t("inputRequestPanel.allowSessionTitle", { tool: request.tool_name })}
            onClick={() => void onDecide({ behavior: "allow", scope: "session" })}
          >
            {t("inputRequestPanel.allowSession")}
          </Button>
          <Button variant="primary" icon={Check} loading={pending} onClick={() => void onDecide({ behavior: "allow", scope: "once" })}>
            {t("inputRequestPanel.allow")}
          </Button>
        </div>
      )}
    </>
  );
}

function questionsOf(request: InputRequest): Question[] {
  const raw = request.tool_input?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((q): q is Question => typeof q === "object" && q !== null && typeof (q as Question).question === "string");
}

/**
 * AskUserQuestion questions: each has its own options, single or multiple choice, and always a
 * "custom answer" field (in the terminal it is the Other item). The answer goes as a string: the
 * selected options comma-separated, as Claude Code itself does it.
 */
function QuestionForm({ request, pending, onDecide }: Props) {
  const { t } = useTranslation();
  const questions = questionsOf(request);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

  const answerFor = (q: Question): string => {
    const own = (custom[q.question] ?? "").trim();
    if (own) return own;
    return (picked[q.question] ?? []).join(", ");
  };
  const complete = questions.length > 0 && questions.every((q) => answerFor(q) !== "");

  const toggle = (q: Question, label: string) => {
    setPicked((prev) => {
      const current = prev[q.question] ?? [];
      if (q.multiSelect) {
        return { ...prev, [q.question]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] };
      }
      return { ...prev, [q.question]: current[0] === label ? [] : [label] };
    });
  };

  if (questions.length === 0) {
    // The question came without text: rare, but the panel must not break on it.
    return <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{request.summary}</p>;
  }

  return (
    <>
      {questions.map((q) => {
        const chosen = picked[q.question] ?? [];
        return (
          <div key={q.question} className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              {q.header && (
                <span className="shrink-0 rounded-[5px] bg-[var(--sunken)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--ink-muted)]">
                  {q.header}
                </span>
              )}
              <p className="text-[13px] font-medium leading-relaxed">{q.question}</p>
            </div>
            {(q.options ?? []).length > 0 && (
              <div role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question} className="flex flex-col gap-1">
                {(q.options ?? []).map((o) => {
                  const on = chosen.includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type="button"
                      role={q.multiSelect ? "checkbox" : "radio"}
                      aria-checked={on}
                      onClick={() => toggle(q, o.label)}
                      disabled={pending}
                      className={cn(
                        "flex items-start gap-2 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-left transition-colors",
                        on
                          ? "border-[var(--st-blocked)] bg-[color-mix(in_oklab,var(--st-blocked)_10%,transparent)]"
                          : "border-[var(--line)] hover:border-[var(--line-strong)]",
                        focusRing,
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[var(--canvas)]",
                          q.multiSelect ? "rounded-[4px]" : "rounded-full",
                          on ? "border-[var(--st-blocked)] bg-[var(--st-blocked)]" : "border-[var(--line-strong)]",
                        )}
                      >
                        {on && <Check size={10} strokeWidth={3.5} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] leading-snug text-[var(--ink)]">{o.label}</span>
                        {o.description && (
                          <span className="block text-[11px] leading-snug text-[var(--ink-muted)]">{o.description}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <Input
              placeholder={(q.options ?? []).length > 0 ? t("inputRequestPanel.customAnswer") : t("inputRequestPanel.answer")}
              value={custom[q.question] ?? ""}
              onChange={(e) => setCustom((prev) => ({ ...prev, [q.question]: e.target.value }))}
              disabled={pending}
            />
          </div>
        );
      })}
      <div className="flex items-center justify-end">
        <Button
          variant="primary"
          icon={Check}
          loading={pending}
          disabled={!complete}
          onClick={() =>
            void onDecide({ answers: Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])) })
          }
        >
          {t("inputRequestPanel.reply")}
        </Button>
      </div>
    </>
  );
}

function PlanForm({ request, pending, onDecide }: Props) {
  const { t } = useTranslation();
  const [returning, setReturning] = useState(false);
  const [notes, setNotes] = useState("");
  const plan = request.tool_input?.plan;
  return (
    <>
      {typeof plan === "string" && plan.trim() ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] bg-[var(--sunken)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--ink)]">
          {plan}
        </pre>
      ) : (
        <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">
          {t("inputRequestPanel.planNoText")}
        </p>
      )}
      {returning ? (
        <div className="space-y-2">
          <Textarea
            placeholder={t("inputRequestPanel.planNotesPlaceholder")}
            className="min-h-16"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setReturning(false)} disabled={pending}>
              {t("inputRequestPanel.back")}
            </Button>
            <Button
              variant="danger"
              icon={X}
              loading={pending}
              disabled={!notes.trim()}
              onClick={() => void onDecide({ behavior: "deny", message: notes.trim() })}
            >
              {t("inputRequestPanel.returnWithNotes")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" icon={X} onClick={() => setReturning(true)} disabled={pending}>
            {t("inputRequestPanel.returnWithNotesEllipsis")}
          </Button>
          <Button variant="primary" icon={Check} loading={pending} onClick={() => void onDecide({ behavior: "allow" })}>
            {t("inputRequestPanel.approvePlan")}
          </Button>
        </div>
      )}
    </>
  );
}
