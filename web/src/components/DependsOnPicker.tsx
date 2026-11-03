import { useId, useState } from "react";
import { FolderGit2, Search } from "lucide-react";
import type { Project, Task } from "../types";
import { statusLabel } from "../labels";
import { STATUS_META } from "../status";
import { Checkbox } from "../ui/Field";
import { fieldBase } from "../ui/tokens";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";

interface Props {
  /** Candidate tasks from all projects: excluding the task itself is up to the caller. */
  candidates: Task[];
  /** Project of the task being edited: its tasks come first, others' are hidden until explicitly
   * requested. */
  projectId: number;
  /** Projects: to name the repository a task belongs to. */
  projects?: Project[];
  value: number[];
  onChange: (ids: number[]) => void;
}

// Below this number of rows search only gets in the way: the list is already fully visible. Counted
// over the currently visible tasks: hidden other projects do not count.
const SEARCH_FROM = 6;

interface Group {
  id: number;
  name: string;
  path: string | null;
  tasks: Task[];
}

/**
 * Selection of blocking tasks: a scrollable list with checkboxes instead of <select multiple>. A
 * native multiple-select required Ctrl/Cmd-click (a plain click reset the rest of the selection),
 * offered no search and did not show how many were selected, hence this whole component.
 *
 * A blocker can be a task from another repository (the frontend waits for the backend of the same
 * feature), so the list can show other projects, but only on explicit request and always as a
 * separate group with the project name: otherwise someone else's "#12" cannot be told apart from
 * your own.
 */
export function DependsOnPicker({ candidates, projectId, projects = [], value, onChange }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [showForeign, setShowForeign] = useState(false);
  const labelId = useId();

  const selected = new Set(value);
  const project = (id: number) => projects.find((p) => p.id === id) ?? null;
  const projectName = (id: number) => project(id)?.name ?? t("dependsOnPicker.projectFallback", { id });

  // We hide another project, but never an already chosen link: otherwise there is no way to uncheck
  // the box, and the form sends depends_on whole and would silently wipe it.
  const isOwn = (task: Task) => task.project_id === projectId;
  const hiddenForeign = candidates.filter((task) => !isOwn(task) && !selected.has(task.id));
  const byProject = showForeign ? candidates : candidates.filter((task) => isOwn(task) || selected.has(task.id));

  // A finished task blocks nobody, so by default it is not in the list. But if it was chosen
  // earlier, it must stay visible, for the same reason.
  const hiddenDone = byProject.filter((task) => task.status === "done" && !selected.has(task.id));
  const visible = showDone ? byProject : byProject.filter((task) => task.status !== "done" || selected.has(task.id));

  const needle = query.trim().toLowerCase();
  // Search also matches the project name: "backend" is a natural way to reach someone else's task.
  const matches = (task: Task) =>
    needle === "" || `#${task.id} ${task.title} ${projectName(task.project_id)}`.toLowerCase().includes(needle);
  const found = visible.filter(matches);
  // Finished ones go to the end: here they are for reference, one usually needs to choose from the
  // active ones. Within each group, recently created first: they are the ones most often looked for
  // as a blocker.
  const rows = [...found].sort(
    (a, b) => Number(a.status === "done") - Number(b.status === "done") || b.created_at.localeCompare(a.created_at) || b.id - a.id,
  );

  // We searched and the match is in hidden other projects: this must be said right in the list,
  // otherwise "nothing found" would lie.
  const foreignMatches =
    showForeign || needle === ""
      ? 0
      : hiddenForeign.filter((task) => (showDone || task.status !== "done") && matches(task)).length;

  const groups: Group[] = [];
  for (const task of rows) {
    let group = groups.find((g) => g.id === task.project_id);
    if (!group) {
      group = { id: task.project_id, name: projectName(task.project_id), path: project(task.project_id)?.path ?? null, tasks: [] };
      groups.push(group);
    }
    group.tasks.push(task);
  }
  // Own project always first: the blocker is most often looked for in it.
  groups.sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId) || a.name.localeCompare(b.name, "ru"));
  // Headings are needed as soon as the list contains another project's task: with the own project
  // alone there is nothing to label, and "#12" without a repository name says nothing.
  const headers = groups.length > 1 || groups.some((g) => g.id !== projectId);

  const toggle = (id: number) =>
    onChange(selected.has(id) ? value.filter((x) => x !== id) : [...value, id].sort((a, b) => a - b));

  const linkBtn =
    "rounded text-[11px] text-[var(--ink-muted)] underline-offset-2 hover:text-[var(--ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]";

  const row = (task: Task) => {
    const meta = STATUS_META[task.status];
    return (
      <li key={task.id} className="border-b border-[var(--line)] last:border-b-0">
        {/* The row is split into spans, so the checkbox label is set explicitly: otherwise a
           screen reader would glue it together without spaces ("#3FirstDone"). */}
        <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[12px] transition-colors hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] has-[:focus-visible]:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]">
          <Checkbox
            aria-label={`#${task.id} ${task.title} — ${statusLabel(t, task.status)}${isOwn(task) ? "" : ` · ${t("dependsOnPicker.projectSuffix", { name: projectName(task.project_id) })}`}`}
            checked={selected.has(task.id)}
            onChange={() => toggle(task.id)}
          />
          <span className="tnum shrink-0 font-mono text-[11px] text-[var(--ink-faint)]">#{task.id}</span>
          <span className="truncate text-[var(--ink)]">{task.title}</span>
          <span className={cn("ml-auto flex shrink-0 items-center gap-1 text-[11px]", meta.fg)}>
            <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
            {statusLabel(t, task.status)}
          </span>
        </label>
      </li>
    );
  };

  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span id={labelId} className="text-[12px] font-medium text-[var(--ink-muted)]">
          {t("dependsOnPicker.heading")}
        </span>
        {value.length > 0 && (
          <>
            <span className="tnum text-[11px] text-[var(--ink)]">{t("dependsOnPicker.selectedCount", { count: value.length })}</span>
            <button type="button" className={cn("ml-auto", linkBtn)} onClick={() => onChange([])}>
              {t("dependsOnPicker.clear")}
            </button>
          </>
        )}
      </div>

      {candidates.length === 0 ? (
        <p className="rounded-[var(--radius-sm)] border border-dashed border-[var(--line)] px-2 py-3 text-center text-[11px] text-[var(--ink-faint)]">
          {t("dependsOnPicker.noOtherTasks")}
        </p>
      ) : (
        <>
          {byProject.length >= SEARCH_FROM && (
            <div className="relative">
              <Search size={12} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-faint)]" />
              <input
                className={cn(fieldBase, "mb-1 h-8 pl-7")}
                placeholder={t("dependsOnPicker.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <ul
            role="group"
            aria-labelledby={labelId}
            className="max-h-44 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--sunken)]"
          >
            {groups.map((g) => (
              <li key={g.id}>
                {headers && (
                  <p
                    title={g.path ?? undefined}
                    className="sticky top-0 z-[1] flex items-center gap-1.5 border-b border-[var(--line)] bg-[var(--sunken)] px-2 py-1 text-[10px] font-medium text-[var(--ink-faint)]"
                  >
                    <FolderGit2 size={11} className="shrink-0" aria-hidden />
                    <span className="truncate">{g.name}</span>
                    {g.id === projectId && (
                      <span className="shrink-0 rounded-[4px] bg-[var(--raised)] px-1 py-0.5 text-[10px] text-[var(--ink-muted)]">
                        {t("dependsOnPicker.currentProject")}
                      </span>
                    )}
                  </p>
                )}
                <ul role="group" aria-label={g.name}>
                  {g.tasks.map(row)}
                </ul>
              </li>
            ))}
            {foreignMatches > 0 && (
              <li className="border-t border-[var(--line)] first:border-t-0">
                <button
                  type="button"
                  className="w-full rounded px-2 py-2 text-center text-[11px] text-[var(--ink-muted)] underline-offset-2 hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                  onClick={() => setShowForeign(true)}
                >
                  {t("dependsOnPicker.showMoreForeign", { count: foreignMatches })}
                </button>
              </li>
            )}
            {rows.length === 0 && foreignMatches === 0 && (
              <li className="px-2 py-3 text-center text-[11px] text-[var(--ink-faint)]">
                {needle === "" ? t("dependsOnPicker.noOtherTasksInProject") : t("dependsOnPicker.nothingFound")}
              </li>
            )}
          </ul>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {(showDone || hiddenDone.length > 0) && (
              <button type="button" className={linkBtn} onClick={() => setShowDone(!showDone)}>
                {showDone ? t("dependsOnPicker.hideDone") : t("dependsOnPicker.showDone", { count: hiddenDone.length })}
              </button>
            )}
            {(showForeign || hiddenForeign.length > 0) && (
              <button type="button" className={linkBtn} onClick={() => setShowForeign(!showForeign)}>
                {showForeign ? t("dependsOnPicker.currentProjectOnly") : t("dependsOnPicker.showForeign", { count: hiddenForeign.length })}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
