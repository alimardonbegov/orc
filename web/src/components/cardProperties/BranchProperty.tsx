import { useEffect, useState } from "react";
import { GitBranch, Plus } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../ui/Button";
import { Field, Input, Select } from "../../ui/Field";
import { Picker, PickerPanel, PickerTrigger } from "../../ui/Picker";
import { focusRing } from "../../ui/tokens";
import { cn } from "../../lib/cn";
import { useTranslation } from "../../i18n";
import type { BranchesState, CardPropertyContext } from "./types";

/** The project's branches, read once. base is the branch a new card starts from. */
export function useProjectBranches(projectId: number, enabled: boolean, onLoaded?: (view: { branches: string[]; base: string | null }) => void): BranchesState {
  const [branches, setBranches] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api
      .branches(projectId)
      .then((view) => {
        if (!alive) return;
        setBranches(view.branches);
        onLoaded?.({ branches: view.branches, base: view.base });
      })
      .catch(() => {
        if (alive) setBranches([]);
      });
    return () => {
      alive = false;
    };
    // onLoaded is a one-time setup step of the form, not an input of this read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled]);
  return { branches, setBranches };
}

/**
 * The base branch: the task's working branch is cut from it and the result goes back into it.
 *
 * A new branch is created in git right away, not when the card is saved: the card must be able to start
 * from it, and the list must show it.
 */
export function BranchProperty({ values, onChange, variant, locked, open, onOpenChange, projectId, branches: { branches, setBranches } }: CardPropertyContext) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = values.target_branch;
  const label = t("card.branch.label");

  const trigger = (
    <PickerTrigger variant={variant} locked={locked} aria-label={`${label}: ${value ?? "—"}`} title={t("taskForm.baseBranchTitle")}>
      <GitBranch size={13} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
      <span className="truncate font-mono text-[11px]">{value ?? "—"}</span>
    </PickerTrigger>
  );
  if (locked) return trigger;

  async function create() {
    const branch = name.trim();
    if (!branch || busy) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.createBranch(projectId, branch, from || null);
      setBranches(view.branches);
      onChange({ target_branch: branch });
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (creating) {
    return (
      <PickerPanel trigger={trigger} open onOpenChange={(next) => !next && setCreating(false)}>
        <div className="space-y-2 p-2.5">
          <Field label={t("taskForm.newBranchNameLabel")}>
            <Input
              aria-label={t("taskForm.newBranchNameLabel")}
              className="font-mono"
              placeholder="feature/what-to-do"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // Enter must not submit the whole task form
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
              }}
            />
          </Field>
          <Field label={t("taskForm.newBranchFromLabel")}>
            <Select aria-label={t("taskForm.newBranchFromLabel")} className="font-mono" value={from} onChange={(e) => setFrom(e.target.value)}>
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </Field>
          {error && (
            <p role="alert" className="text-[12px] text-[var(--danger)]">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="primary" size="sm" icon={Plus} loading={busy} disabled={!name.trim()} onClick={() => void create()}>
              {t("taskForm.newBranchCreate")}
            </Button>
          </div>
        </div>
      </PickerPanel>
    );
  }

  // The branch could have been deleted behind the dashboard's back. Silently replacing it with the
  // first in the list is not allowed: the task would be merged to the wrong place.
  const gone = value && !branches.includes(value) ? [{ value, label: t("taskForm.branchGone", { branch: value }), mono: true }] : [];
  return (
    <Picker
      label={label}
      trigger={trigger}
      searchable={branches.length > 6}
      value={value}
      onChange={(target_branch) => onChange({ target_branch })}
      open={open}
      onOpenChange={onOpenChange}
      options={[...gone, ...branches.map((b) => ({ value: b, label: b, mono: true }))]}
      footer={
        <button
          type="button"
          className={cn("flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] text-[var(--ink-muted)] hover:bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] hover:text-[var(--ink)]", focusRing)}
          onClick={() => {
            setFrom(value && branches.includes(value) ? value : (branches[0] ?? ""));
            setName("");
            setError(null);
            setCreating(true);
          }}
        >
          <Plus size={13} aria-hidden />
          {t("taskForm.newBranchOption")}
        </button>
      }
    />
  );
}

/**
 * A task starts when its blockers are merged, from its own base: with another base it runs in the right
 * order and still does not get their work. Another project's branches say nothing about this one.
 */
export function baseMismatch(candidates: { id: number; project_id: number; target_branch: string | null }[], depends_on: number[], projectId: number, branch: string | null): string[] {
  return [
    ...new Set(
      candidates
        .filter((t) => depends_on.includes(t.id) && t.project_id === projectId && t.target_branch && t.target_branch !== branch)
        .map((t) => t.target_branch as string),
    ),
  ];
}

export function BaseMismatchNotice({ branches, branch, onFix }: { branches: string[]; branch: string; onFix: (branch: string) => void }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--warn)_14%,transparent)] px-3 py-2 text-[12px] leading-snug text-[var(--warn)]">
      <span>{t("taskForm.baseMismatch", { branches: branches.join(", "), branch })}</span>
      {branches.length === 1 && (
        <Button type="button" size="sm" variant="secondary" onClick={() => onFix(branches[0])}>
          {t("taskForm.baseMismatchFix", { branch: branches[0] })}
        </Button>
      )}
    </div>
  );
}
