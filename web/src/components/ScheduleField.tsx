import { useState } from "react";
import { Clock } from "lucide-react";
import { Segmented } from "../ui/Segmented";
import { Field, Input } from "../ui/Field";
import { cn } from "../lib/cn";
import { focusRing } from "../ui/tokens";
import { useTranslation } from "../i18n";
import { useNow } from "../hooks/useNow";
import { formatDuration } from "../dates";
import {
  SCHEDULE_PRESETS,
  fromLocalInput,
  presetStart,
  toLocalInput,
  type ScheduleError,
  type ScheduleValues,
} from "../schedule";

interface Props {
  value: ScheduleValues;
  onChange: (v: ScheduleValues) => void;
  /** The pair's error is computed in the form (which also blocks saving with it) and only drawn
   * here. */
  error: ScheduleError | null;
}

type Mode = "now" | "later";

/**
 * The "Start" block of the task form: immediately or on a schedule, with "not earlier than" and an
 * optional "not later than". Time is entered in the local time zone, ISO UTC goes to the server
 * (see schedule.ts).
 */
export function ScheduleField({ value, onChange, error }: Props) {
  const { t } = useTranslation();
  const now = useNow();
  const [mode, setMode] = useState<Mode>(value.start_after || value.start_before ? "later" : "now");

  const switchMode = (next: Mode) => {
    setMode(next);
    if (next === "now") onChange({ start_after: null, start_before: null });
    // An empty "on schedule" would be no different from "immediately": we offer a reasonable
    // deadline right away
    else if (!value.start_after) onChange({ ...value, start_after: presetStart("1h", Date.now()) });
  };

  const startsAt = value.start_after ? Date.parse(value.start_after) : NaN;

  return (
    <section className="space-y-2.5 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ink-muted)]">
          <Clock size={12} aria-hidden />
          {t("taskForm.schedule.heading")}
        </h3>
        <Segmented<Mode>
          className="ml-auto"
          ariaLabel={t("taskForm.schedule.modeLabel")}
          value={mode}
          onChange={switchMode}
          options={[
            { value: "now", label: t("taskForm.schedule.now") },
            { value: "later", label: t("taskForm.schedule.later") },
          ]}
        />
      </div>

      {mode === "later" && (
        <>
          <div className="flex flex-wrap gap-1">
            {SCHEDULE_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={cn(
                  "rounded-[var(--radius-sm)] border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--ink-muted)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--ink)]",
                  focusRing,
                )}
                onClick={() => onChange({ ...value, start_after: presetStart(p, Date.now()) })}
              >
                {t(`taskForm.schedule.presets.${p}`)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
            <Field label={t("taskForm.schedule.notBefore")}>
              <Input
                type="datetime-local"
                aria-label={t("taskForm.schedule.notBefore")}
                value={toLocalInput(value.start_after)}
                onChange={(e) => onChange({ ...value, start_after: fromLocalInput(e.target.value) })}
              />
            </Field>
            <Field label={t("taskForm.schedule.notAfter")} hint={t("taskForm.schedule.notAfterHint")}>
              <Input
                type="datetime-local"
                aria-label={t("taskForm.schedule.notAfter")}
                value={toLocalInput(value.start_before)}
                onChange={(e) => onChange({ ...value, start_before: fromLocalInput(e.target.value) })}
              />
            </Field>
          </div>
          {error ? (
            <p role="alert" className="text-[11px] leading-snug text-[var(--danger)]">
              {t(`taskForm.schedule.errors.${error}`)}
            </p>
          ) : (
            <p className="text-[11px] leading-snug text-[var(--ink-faint)]">
              {/* An empty "Not earlier than" will be saved as "no schedule": we say so
                 directly */}
              {Number.isNaN(startsAt)
                ? t("taskForm.schedule.noStart")
                : startsAt > now
                  ? t("taskForm.schedule.startsIn", { duration: formatDuration(t, startsAt - now) })
                  : t("taskForm.schedule.startsAsap")}
              {" · "}
              {t("taskForm.schedule.hint")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
