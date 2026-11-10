import { useState } from "react";
import { Sparkles } from "lucide-react";
import type { ComponentProps } from "react";
import { api } from "../api";
import type { CardDraft } from "../types";
import { TaskForm, type TaskFormValues } from "./TaskForm";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Field";
import { Segmented } from "../ui/Segmented";
import { useTranslation } from "../i18n";

type Mode = "manual" | "describe";

/** What the form starts with after a draft: the agent and the branch only when the model picked one. */
function draftInitial(d: CardDraft["draft"]): Partial<TaskFormValues> {
  return {
    title: d.title,
    description: d.description,
    priority: d.priority,
    ...(d.agent_id !== null ? { agent_id: d.agent_id } : {}),
    ...(d.target_branch !== null ? { target_branch: d.target_branch } : {}),
  };
}

/**
 * The creation form with a second way in: write a sentence and a cheap model drafts the card.
 *
 * The draft lands in the same form, to be read and edited, and the card is created by the same button as
 * ever. Manual entry stays the default. The phrase lives here, outside the request, so a failed model
 * leaves it where it was, and the manual form below is never unmounted, so switching modes loses nothing.
 */
export function NewTaskForm(props: ComponentProps<typeof TaskForm>) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("manual");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CardDraft | null>(null);
  // A new draft replaces what the form holds, so the form is rebuilt for it
  const [formKey, setFormKey] = useState(0);
  const [initial, setInitial] = useState(props.initial);

  async function draft() {
    if (!text.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const made = await api.draftTask(props.projectId, text.trim());
      setResult(made);
      setInitial({ ...props.initial, ...draftInitial(made.draft) });
      setFormKey((k) => k + 1);
      setMode("manual");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <Segmented
        ariaLabel={t("quickCreate.modeLabel")}
        value={mode}
        options={[
          { value: "manual", label: t("quickCreate.manual") },
          { value: "describe", label: t("quickCreate.describe") },
        ]}
        onChange={setMode}
      />

      {mode === "describe" && (
        <div className="space-y-3">
          <Textarea
            aria-label={t("quickCreate.textLabel")}
            className="min-h-32"
            placeholder={t("quickCreate.placeholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <p className="text-[11px] leading-snug text-[var(--ink-faint)]">{t("quickCreate.hint")}</p>
          {error && (
            <p role="alert" className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
              {t("quickCreate.failed", { reason: error })}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={props.onCancel}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="primary" icon={Sparkles} loading={pending} disabled={!text.trim()} onClick={() => void draft()}>
              {error ? t("quickCreate.retry") : t("quickCreate.draft")}
            </Button>
          </div>
        </div>
      )}

      <div hidden={mode !== "manual"}>
        {result && (
          <div className="mb-3 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
            <p>{t("quickCreate.drafted", { model: result.usage.model, tokens: result.usage.tokens.toLocaleString(), cost: result.usage.cost_usd.toFixed(4) })}</p>
            {result.warnings.map((w) => (
              <p key={w} className="mt-1 text-[var(--st-blocked)]">{w}</p>
            ))}
          </div>
        )}
        <TaskForm key={formKey} {...props} initial={initial} />
      </div>
    </div>
  );
}
