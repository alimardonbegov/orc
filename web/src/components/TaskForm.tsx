import { useEffect, useState } from "react";
import { GitBranch, RotateCcw } from "lucide-react";
import { api } from "../api";
import type { PermissionMode, Priority, Project, Task } from "../types";
import { priorityLabel } from "../labels";
import {
  inheritNote,
  hasOwnRunParams,
  inheritedEffort,
  inheritedModel,
  inheritedPermission,
  inheritedVerifyCmd,
} from "../runParams";
import { ScheduleField } from "./ScheduleField";
import { scheduleError, type ScheduleValues } from "../schedule";
import { useNow } from "../hooks/useNow";
import { DependsOnPicker } from "./DependsOnPicker";
import { DescriptionEditor } from "./DescriptionEditor";
import { EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";
import { PermissionPicker } from "./PermissionPicker";
import { Button } from "../ui/Button";
import { focusRing } from "../ui/tokens";
import { Field, Input, Select } from "../ui/Field";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";
import { effectiveHiddenModels } from "../models";
import { useAppHiddenModels } from "../hiddenModels";

export interface TaskFormValues {
  title: string;
  description: string;
  priority: Priority;
  target_branch: string | null;
  depends_on: number[];
  model: string | null;
  effort: string | null;
  permission_mode: PermissionMode | null;
  verify_cmd: string | null;
  /** Deferred start (ISO UTC): not earlier than / not later than. null means immediately / window
   * open. */
  start_after: string | null;
  start_before: string | null;
}

interface Props {
  projectId: number;
  /** Task's project: needed to show inherited values in the run parameters. */
  project?: Project | null;
  /** All projects: used to label the repositories of blocker tasks from other projects. */
  projects?: Project[];
  initial?: Partial<TaskFormValues>;
  allTasks: Task[];
  excludeId?: number;
  onSubmit: (values: TaskFormValues) => void;
  onCancel: () => void;
  /** While true, the "Save" button is disabled: the request is still in flight (controlled by the
   * calling component). */
  pending?: boolean;
  /** Label of the main button: "Save" when editing, "Create task" when creating. */
  submitLabel?: string;
}

const empty = (v: string) => (v.trim() === "" ? null : v.trim());

/**
 * Shared create-and-edit form.
 *
 * Run parameters are always expanded and stand right under the description, above the blockers.
 * They used to lie in a collapsed spoiler at the very bottom of the form, and getting to a
 * parameter changed in almost every task took two extra actions: scroll down and expand. Blockers,
 * on the contrary, are rarely needed and take up half the form as a list, so they moved down.
 */
export function TaskForm({
  projectId,
  project,
  projects,
  initial,
  allTasks,
  excludeId,
  onSubmit,
  onCancel,
  pending = false,
  submitLabel,
}: Props) {
  const { t } = useTranslation();
  // We take from initial only the form fields: in edit mode the whole task arrives there
  const [v, setV] = useState<TaskFormValues>(() => ({
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    priority: initial?.priority ?? "normal",
    target_branch: initial?.target_branch ?? null,
    depends_on: initial?.depends_on ?? [],
    model: initial?.model ?? null,
    effort: initial?.effort ?? null,
    permission_mode: initial?.permission_mode ?? null,
    verify_cmd: initial?.verify_cmd ?? null,
    start_after: initial?.start_after ?? null,
    start_before: initial?.start_before ?? null,
  }));
  // The schedule the form was opened with: unchanged with an expired end is not an error (see
  // scheduleError)
  const [initialSchedule] = useState<ScheduleValues>(() => ({
    start_after: initial?.start_after ?? null,
    start_before: initial?.start_before ?? null,
  }));
  const now = useNow();
  const scheduleErr = scheduleError(v, now, initialSchedule);
  const [branches, setBranches] = useState<string[]>([]);

  useEffect(() => {
    api
      .branches(projectId)
      .then((b) => {
        setBranches(b.branches);
        // The default branch is the project base: the "Base branch for new tasks" setting, and if
        // it is not set, the one currently checked out in the repository.
        setV((s) => ({ ...s, target_branch: s.target_branch ?? b.base }));
      })
      .catch(() => setBranches([]));
  }, [projectId]);

  // allTasks receives tasks of all projects (App does not filter them), and that is intended: a
  // blocker can be a task from another repository. Which of them to show is decided by
  // DependsOnPicker: the own project right away, others as separate groups on a button.
  const candidates = allTasks.filter((t) => t.id !== excludeId);

  // Labels of empty options: they hold the inherited value, with a note in parentheses that it came
  // from the project (see runParams.ts).
  const model = inheritedModel(t, project);
  const effort = inheritedEffort(t, project);
  const permission = inheritedPermission(t, project);
  const verifyCmd = inheritedVerifyCmd(t, project);
  const own = hasOwnRunParams(v);
  const hiddenModels = effectiveHiddenModels(project, useAppHiddenModels());

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.title.trim() && !pending && !scheduleErr) onSubmit({ ...v, title: v.title.trim() });
      }}
    >
      <Field label={t("taskForm.titleLabel")}>
        <Input placeholder={t("taskForm.titlePlaceholder")} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} autoFocus />
      </Field>

      <Field label={t("taskForm.descriptionLabel")} hint={t("taskForm.descriptionHint")}>
        <DescriptionEditor
          label={t("taskForm.descriptionLabel")}
          placeholder={t("taskForm.descriptionPlaceholder")}
          value={v.description}
          onChange={(description) => setV({ ...v, description })}
        />
      </Field>

      <section className="space-y-2.5 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h3 className="text-[12px] font-semibold text-[var(--ink-muted)]">{t("taskForm.runParamsHeading")}</h3>
          {/* There is no other way to return a field to inheritance: the empty option comes
             first in the list, but finding it in each of the four fields is a separate chore. */}
          {own && (
            <button
              type="button"
              className={cn(
                "ml-auto flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[11px] text-[var(--ink-faint)] transition-colors hover:text-[var(--ink)]",
                focusRing,
              )}
              onClick={() => setV({ ...v, model: null, effort: null, permission_mode: null, verify_cmd: null })}
            >
              <RotateCcw size={11} aria-hidden />
              {t("taskForm.resetToProject")}
            </button>
          )}
        </div>

        {/* Three columns, not two: this way the whole block is two rows of fields, and the
           description above stays on screen together with the parameters. */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-3">
          <ModelPicker
            value={v.model}
            defaultLabel={model}
            hidden={hiddenModels}
            onChange={(next) => setV({ ...v, model: next })}
          />
          <EffortPicker value={v.effort} defaultLabel={effort} onChange={(next) => setV({ ...v, effort: next })} />
          <PermissionPicker
            value={v.permission_mode}
            defaultLabel={permission}
            onChange={(next) => setV({ ...v, permission_mode: next })}
          />
          <Field label={t("taskForm.priorityLabel")}>
            <Select
              aria-label={t("taskForm.priorityLabel")}
              value={v.priority}
              onChange={(e) => setV({ ...v, priority: e.target.value as Priority })}
            >
              {(["high", "normal", "low"] as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {priorityLabel(t, p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("taskForm.baseBranchLabel")}>
            <Select
              aria-label={t("taskForm.baseBranchLabel")}
              title={t("taskForm.baseBranchTitle")}
              className="font-mono"
              value={v.target_branch ?? ""}
              onChange={(e) => setV({ ...v, target_branch: e.target.value || null })}
            >
              {/* The branch could have been deleted behind the dashboard's back. Silently
                 replacing it with the first in the list is not allowed: the task would go off
                 to be merged to the wrong place, which nobody would learn about. */}
              {v.target_branch && !branches.includes(v.target_branch) && (
                <option value={v.target_branch}>{t("taskForm.branchGone", { branch: v.target_branch })}</option>
              )}
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("taskForm.verifyCmdLabel")}>
            <Input
              className="font-mono"
              placeholder={verifyCmd}
              value={v.verify_cmd ?? ""}
              onChange={(e) => setV({ ...v, verify_cmd: empty(e.target.value) })}
            />
          </Field>
        </div>

        {project && <p className="text-[11px] leading-snug text-[var(--ink-faint)]">{inheritNote(t)}</p>}
      </section>

      <ScheduleField
        value={{ start_after: v.start_after, start_before: v.start_before }}
        onChange={(s) => setV({ ...v, ...s })}
        error={scheduleErr}
      />

      <DependsOnPicker
        candidates={candidates}
        projectId={projectId}
        projects={projects}
        value={v.depends_on}
        onChange={(ids) => setV({ ...v, depends_on: ids })}
      />

      {/* The buttons stick to the bottom of the scrollable area: in a long form one would
         otherwise have to scroll to them, and this is the window's main action. */}
      <div className="sticky bottom-0 -mx-5 -mb-4 flex items-center justify-end gap-2 border-t border-[var(--line)] bg-[var(--surface)] px-5 py-3">
        {v.target_branch && (
          <span className="mr-auto flex items-center gap-1 font-mono text-[11px] text-[var(--ink-faint)]">
            <GitBranch size={11} aria-hidden />
            {v.target_branch}
          </span>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={pending} disabled={!v.title.trim() || scheduleErr !== null}>
          {submitLabel ?? t("taskForm.save")}
        </Button>
      </div>
    </form>
  );
}
