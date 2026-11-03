import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { api } from "../api";
import type { PermissionMode, Priority, Project, Routine, RoutineInput, RoutineScheduleKind } from "../types";
import { priorityLabel } from "../labels";
import { inheritedEffort, inheritedModel, inheritedPermission, inheritedVerifyCmd, inheritNote } from "../runParams";
import {
  CRON_PRESETS,
  MIN_INTERVAL_MINUTES,
  browserTimeZone,
  joinInterval,
  slotTime,
  splitInterval,
  type IntervalUnit,
} from "../routines";
import { DescriptionEditor } from "./DescriptionEditor";
import { EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";
import { PermissionPicker } from "./PermissionPicker";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Segmented";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { useTranslation } from "../i18n";
import { useNow } from "../hooks/useNow";
import { effectiveHiddenModels } from "../models";
import { useAppHiddenModels } from "../hiddenModels";

interface Props {
  project: Project | null;
  /** Editing an existing routine; undefined means creating a new one. */
  initial?: Routine;
  pending?: boolean;
  submitLabel: string;
  onSubmit: (values: RoutineInput) => void;
  onCancel: () => void;
}

const empty = (v: string) => (v.trim() === "" ? null : v.trim());

/**
 * Recurring task form: description, schedule and run parameters.
 *
 * Under the schedule are the nearest runs, which the server computes with the same code as the
 * dispatcher: a cron expression is easy to write differently from what you think, and it should be
 * checked by eye before saving, not by the first missed morning.
 */
export function RoutineForm({ project, initial, pending = false, submitLabel, onSubmit, onCancel }: Props) {
  const { t, language } = useTranslation();
  const now = useNow();
  const start = splitInterval(initial?.interval_minutes);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? "normal");
  const [model, setModel] = useState<string | null>(initial?.model ?? null);
  const [effort, setEffort] = useState<string | null>(initial?.effort ?? null);
  const [permission, setPermission] = useState<PermissionMode | null>(initial?.permission_mode ?? null);
  const [verifyCmd, setVerifyCmd] = useState<string | null>(initial?.verify_cmd ?? null);
  const [kind, setKind] = useState<RoutineScheduleKind>(initial?.schedule_kind ?? "interval");
  const [amount, setAmount] = useState(String(start.value));
  const [unit, setUnit] = useState<IntervalUnit>(start.unit);
  const [cron, setCron] = useState(initial?.cron ?? CRON_PRESETS[1].cron);
  const [timezone, setTimezone] = useState(initial?.timezone ?? browserTimeZone());
  const [maxRuns, setMaxRuns] = useState(initial?.max_runs ? String(initial.max_runs) : "");
  const [archiveRuns, setArchiveRuns] = useState(initial?.archive_runs ?? true);
  const [preview, setPreview] = useState<{ next: string[]; error: string | null } | null>(null);

  const amountNum = Number(amount);
  const intervalMinutes = Number.isFinite(amountNum) && amountNum > 0 ? joinInterval(amountNum, unit) : null;
  const intervalError =
    kind === "interval" && (intervalMinutes === null || intervalMinutes < MIN_INTERVAL_MINUTES)
      ? t("routines.form.intervalTooShort", { min: MIN_INTERVAL_MINUTES })
      : null;
  const maxRunsNum = maxRuns.trim() === "" ? null : Number(maxRuns);
  const maxRunsError = maxRunsNum !== null && (!Number.isInteger(maxRunsNum) || maxRunsNum < 1) ? t("routines.form.maxRunsInvalid") : null;

  // Nearest runs with a pause after input: cron is typed character by character, and there is no
  // need to hit the server on every keystroke.
  useEffect(() => {
    if (intervalError) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      api
        .previewSchedule({
          schedule_kind: kind,
          interval_minutes: kind === "interval" ? intervalMinutes : null,
          cron: kind === "cron" ? cron : null,
          timezone,
        })
        .then((p) => !cancelled && setPreview({ next: p.next, error: null }))
        .catch((e: unknown) => !cancelled && setPreview({ next: [], error: e instanceof Error ? e.message : String(e) }));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [kind, intervalMinutes, cron, timezone, intervalError]);

  const scheduleError = intervalError ?? preview?.error ?? null;
  const canSubmit = title.trim() !== "" && description.trim() !== "" && !scheduleError && !maxRunsError && !pending;
  const hiddenModels = effectiveHiddenModels(project, useAppHiddenModels());

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onSubmit({
          title: title.trim(),
          description,
          priority,
          model,
          effort,
          permission_mode: permission,
          verify_cmd: verifyCmd,
          schedule_kind: kind,
          interval_minutes: kind === "interval" ? intervalMinutes : null,
          cron: kind === "cron" ? cron.trim() : null,
          timezone,
          max_runs: maxRunsNum,
          archive_runs: archiveRuns,
        });
      }}
    >
      <Field label={t("routines.form.titleLabel")}>
        <Input
          placeholder={t("routines.form.titlePlaceholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
      </Field>

      <Field label={t("routines.form.instructionLabel")} hint={t("routines.form.instructionHint")}>
        <DescriptionEditor
          label={t("routines.form.instructionLabel")}
          placeholder={t("routines.form.instructionPlaceholder")}
          value={description}
          onChange={setDescription}
        />
      </Field>

      <section className="space-y-2.5 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <CalendarClock size={13} aria-hidden className="text-[var(--ink-faint)]" />
          <h3 className="text-[12px] font-semibold text-[var(--ink-muted)]">{t("routines.form.scheduleHeading")}</h3>
          <Segmented
            className="ml-auto"
            ariaLabel={t("routines.form.scheduleHeading")}
            value={kind}
            onChange={setKind}
            options={[
              { value: "interval", label: t("routines.form.kindInterval") },
              { value: "cron", label: t("routines.form.kindCron") },
            ]}
          />
        </div>

        {kind === "interval" ? (
          <div className="flex items-end gap-2">
            <Field label={t("routines.form.every")} className="w-28">
              <Input
                type="number"
                min={1}
                aria-label={t("routines.form.every")}
                className="tnum"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label={t("routines.form.unit")} className="w-36">
              <Select aria-label={t("routines.form.unit")} value={unit} onChange={(e) => setUnit(e.target.value as IntervalUnit)}>
                {(["minutes", "hours", "days"] as IntervalUnit[]).map((u) => (
                  <option key={u} value={u}>
                    {t(`routines.units.${u}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {CRON_PRESETS.map((p) => (
                <Button
                  key={p.key}
                  type="button"
                  size="sm"
                  variant={cron.trim() === p.cron ? "secondary" : "ghost"}
                  onClick={() => setCron(p.cron)}
                >
                  {t(`routines.presets.${p.key}`)}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_14rem]">
              <Field label={t("routines.form.cronLabel")} hint={t("routines.form.cronHint")}>
                <Input
                  aria-label={t("routines.form.cronLabel")}
                  className="font-mono"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                />
              </Field>
              <Field label={t("routines.form.timezone")}>
                <Input
                  aria-label={t("routines.form.timezone")}
                  className="font-mono"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
              </Field>
            </div>
          </div>
        )}

        <div aria-live="polite" className="min-h-[1.25rem] text-[11px] leading-snug">
          {scheduleError ? (
            <span className="text-[var(--danger)]">{scheduleError}</span>
          ) : preview && preview.next.length > 0 ? (
            <span className="text-[var(--ink-faint)]">
              {t("routines.form.nextRuns")}{" "}
              <span className="tnum text-[var(--ink-muted)]">
                {preview.next.map((s) => slotTime(Date.parse(s), language, now)).join(" · ")}
              </span>
            </span>
          ) : null}
        </div>
      </section>

      <section className="space-y-2.5 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2.5">
        <h3 className="text-[12px] font-semibold text-[var(--ink-muted)]">{t("taskForm.runParamsHeading")}</h3>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-3">
          <ModelPicker value={model} defaultLabel={inheritedModel(t, project)} hidden={hiddenModels} onChange={setModel} />
          <EffortPicker value={effort} defaultLabel={inheritedEffort(t, project)} onChange={setEffort} />
          <PermissionPicker value={permission} defaultLabel={inheritedPermission(t, project)} onChange={setPermission} />
          <Field label={t("taskForm.priorityLabel")}>
            <Select aria-label={t("taskForm.priorityLabel")} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {(["high", "normal", "low"] as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {priorityLabel(t, p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("taskForm.verifyCmdLabel")}>
            <Input
              className="font-mono"
              placeholder={inheritedVerifyCmd(t, project)}
              value={verifyCmd ?? ""}
              onChange={(e) => setVerifyCmd(empty(e.target.value))}
            />
          </Field>
          <Field label={t("routines.form.maxRuns")} hint={maxRunsError ?? t("routines.form.maxRunsHint")}>
            <Input
              type="number"
              min={1}
              aria-label={t("routines.form.maxRuns")}
              className="tnum"
              placeholder="∞"
              value={maxRuns}
              onChange={(e) => setMaxRuns(e.target.value)}
            />
          </Field>
        </div>
        {project && <p className="text-[11px] leading-snug text-[var(--ink-faint)]">{inheritNote(t)}</p>}
      </section>

      <Toggle
        checked={archiveRuns}
        onChange={setArchiveRuns}
        label={t("routines.form.archiveRuns")}
        hint={t("routines.form.archiveRunsHint")}
      />

      <div className="sticky bottom-0 -mx-5 -mb-4 flex items-center justify-end gap-2 border-t border-[var(--line)] bg-[var(--surface)] px-5 py-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={pending} disabled={!canSubmit}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
