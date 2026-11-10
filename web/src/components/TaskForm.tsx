import { useEffect, useRef, useState } from "react";
import { ListTree, PlayCircle, X } from "lucide-react";
import type { Priority, Project, Task } from "../types";
import { useAgents } from "../agents";
import { defaultAgentId, effectiveCardSettings, useAppCardSettings } from "../cardSettings";
import { BaseMismatchNotice, baseMismatch, useProjectBranches } from "./cardProperties/BranchProperty";
import { PropertyPills } from "./cardProperties/CardProperties";
import { DescriptionEditor } from "./DescriptionEditor";
import { Button } from "../ui/Button";
import { AutoGrowTextarea } from "../ui/Field";
import { useTranslation } from "../i18n";
import { readLastBranch, writeLastBranch } from "../lastBranch";

export interface TaskFormValues {
  title: string;
  description: string;
  priority: Priority;
  target_branch: string | null;
  depends_on: number[];
  /** Who the card is assigned to. null means a person: the card cannot go to work. */
  agent_id: number | null;
  /** Label names; a missing label is created by the server. */
  labels: string[];
  /** Planning days, `YYYY-MM-DD`. They are a plan for people: the queue never reads them. */
  start_date: string | null;
  due_date: string | null;
  /** The card this one is a subtask of: grouping only, the queue never reads it. null means top-level. */
  parent_task_id: number | null;
  /** backlog waits for a decision, todo goes straight to the queue. */
  status: "backlog" | "todo";
}

interface Props {
  projectId: number;
  project?: Project | null;
  /** All projects: used to label the repositories of blocker tasks from other projects. */
  projects?: Project[];
  initial?: Partial<TaskFormValues>;
  allTasks: Task[];
  onSubmit: (values: TaskFormValues) => void;
  onCancel: () => void;
  /** While true, the buttons are disabled: the request is still in flight. */
  pending?: boolean;
  /** Label of the main button. */
  submitLabel?: string;
  /** Open with the branch picked for the previous task of this project and remember the one picked now. */
  rememberBranch?: boolean;
}

/**
 * Creating a task: what to do, and a row of properties under it.
 *
 * Who does it and how it runs is the agent's business: the model, the effort and the mode live in the
 * agent and in the project, not in every card. Which properties are in the row is a setting, and
 * the properties themselves are in cardProperties/registry.tsx.
 */
export function TaskForm({ projectId, project, projects, initial, allTasks, onSubmit, onCancel, pending = false, submitLabel, rememberBranch = false }: Props) {
  const { t } = useTranslation();
  const agents = useAgents();
  const settings = effectiveCardSettings(project, useAppCardSettings());
  const [v, setV] = useState<TaskFormValues>(() => ({
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    priority: initial?.priority ?? settings.default_priority ?? "normal",
    target_branch: initial?.target_branch ?? null,
    depends_on: initial?.depends_on ?? [],
    agent_id: initial?.agent_id ?? defaultAgentId(settings, agents, projectId),
    labels: initial?.labels ?? [],
    start_date: initial?.start_date ?? null,
    due_date: initial?.due_date ?? null,
    parent_task_id: initial?.parent_task_id ?? null,
    status: "backlog",
  }));

  // The agent list arrives with a poll and may come after the form opened. The default is applied then,
  // but only until the person has picked, or "Unassigned" would be overwritten.
  const touchedAgent = useRef(initial?.agent_id !== undefined);
  const fallbackAgent = defaultAgentId(settings, agents, projectId);
  useEffect(() => {
    if (!touchedAgent.current && fallbackAgent !== null) setV((s) => (s.agent_id === null ? { ...s, agent_id: fallbackAgent } : s));
  }, [fallbackAgent]);

  // The default is the branch of the previous task (if it still exists), otherwise the project base:
  // the "Base branch for new tasks" setting, and if it is not set, the one checked out in the repository.
  const branches = useProjectBranches(projectId, true, ({ branches: list, base }) => {
    const last = rememberBranch ? readLastBranch(projectId) : null;
    const fallback = last && list.includes(last) ? last : base;
    setV((s) => ({ ...s, target_branch: s.target_branch ?? fallback }));
  });

  const mismatch = baseMismatch(allTasks, v.depends_on, projectId, v.target_branch);
  const hasTitle = v.title.trim() !== "";
  const canStart = hasTitle && v.agent_id !== null && v.description.trim() !== "";

  function submit(status: TaskFormValues["status"]) {
    if (!hasTitle || pending) return;
    if (rememberBranch) writeLastBranch(projectId, v.target_branch);
    onSubmit({ ...v, status, title: v.title.trim() });
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit("backlog");
      }}
    >
      <AutoGrowTextarea
        aria-label={t("taskForm.titleLabel")}
        className="min-h-9 border-transparent bg-transparent px-0 py-[7px] text-[15px] font-semibold leading-snug hover:border-transparent focus:border-transparent focus:ring-0"
        placeholder={t("taskForm.titlePlaceholder")}
        value={v.title}
        // A long title wraps instead of running off the edge, and stays one paragraph
        onChange={(e) => setV({ ...v, title: e.target.value.replace(/\s*\n\s*/g, " ") })}
        onKeyDown={(e) => {
          // A one-line field submitted the form on Enter; a textarea would add a line instead
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        autoFocus
      />

      <DescriptionEditor
        label={t("taskForm.descriptionLabel")}
        placeholder={t("taskForm.descriptionPlaceholder")}
        value={v.description}
        onChange={(description) => setV({ ...v, description })}
      />

      {v.parent_task_id !== null && (
        <ParentPill parentId={v.parent_task_id} title={allTasks.find((t) => t.id === v.parent_task_id)?.title} onRemove={() => setV({ ...v, parent_task_id: null })} />
      )}

      <PropertyPills
        settings={settings}
        values={v}
        onChange={(patch) => {
          if ("agent_id" in patch) touchedAgent.current = true;
          setV({ ...v, ...patch });
        }}
        projectId={projectId}
        projects={projects}
        allTasks={allTasks}
        branches={branches}
      />

      {v.target_branch && mismatch.length > 0 && (
        <BaseMismatchNotice branches={mismatch} branch={v.target_branch} onFix={(target_branch) => setV({ ...v, target_branch })} />
      )}

      {/* The buttons stick to the bottom of the scrollable area: this is the window's main action. */}
      <div className="sticky -bottom-4 -mx-5 -mb-4 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] bg-[var(--surface)] px-5 py-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={pending} disabled={!hasTitle}>
          {submitLabel ?? t("taskForm.save")}
        </Button>
        <Button
          type="button"
          variant="primary"
          icon={PlayCircle}
          disabled={!canStart || pending}
          title={canStart ? undefined : t("card.form.startNeeds")}
          onClick={() => submit("todo")}
        >
          {t("card.form.createAndStart")}
        </Button>
      </div>
    </form>
  );
}

/** The parent a subtask was opened from: named, and removable for a card that should stand on its own after all. */
function ParentPill({ parentId, title, onRemove }: { parentId: number; title?: string; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-[var(--ink-muted)]">
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--line)] py-0.5 pl-2 pr-0.5">
        <ListTree size={12} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
        <span className="shrink-0">{t("card.relations.formParent", { id: parentId })}</span>
        {title && <span className="truncate text-[var(--ink-faint)]">{title}</span>}
        <button
          type="button"
          aria-label={t("card.relations.formParentRemove")}
          title={t("card.relations.formParentRemove")}
          onClick={onRemove}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--ink-faint)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]"
        >
          <X size={12} aria-hidden />
        </button>
      </span>
    </div>
  );
}
