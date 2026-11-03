import { useEffect, useState } from "react";
import { Check, GitBranch, Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, ApiError } from "../api";
import type { BranchInfo, BranchesView, Task } from "../types";
import { Badge } from "../ui/Badge";
import { Button, IconButton } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { Field, Input, Select } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { Tip } from "../ui/Overlays";
import { useTranslation } from "../i18n";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  /** The project's base branch from its settings: null means the repository's current branch is
   * used. */
  defaultBranch: string | null;
  /** All tasks: by id from target_of / branch_of we show who exactly holds the branch. */
  tasks: Task[];
  /** Something changed in branches or task cards: the board and projects need re-reading. */
  onChanged: () => void;
}

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "#3 Title": the task number alone says nothing. */
function taskLabel(tasks: Task[], id: number): string {
  const t = tasks.find((x) => x.id === id);
  return t ? `#${id} ${t.title}` : `#${id}`;
}

/** Row of one branch: name, who holds it and what can be done with it. */
function BranchRow({
  item,
  tasks,
  busyName,
  onRename,
  onDelete,
}: {
  item: BranchInfo;
  tasks: Task[];
  /** Name of the branch whose request is in flight: its buttons are disabled. */
  busyName: string | null;
  onRename: (name: string, next: string) => Promise<boolean>;
  onDelete: (item: BranchInfo) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.name);
  const pending = busyName === item.name;
  const holders = [...item.branch_of, ...item.target_of];

  async function save() {
    const next = draft.trim();
    if (!next || next === item.name) {
      setEditing(false);
      return;
    }
    if (await onRename(item.name, next)) setEditing(false);
  }

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--line)] px-3 py-2 last:border-0">
      <GitBranch size={12} className="shrink-0 text-[var(--ink-faint)]" aria-hidden />

      {editing ? (
        <>
          <Input
            aria-label={t("branchesDialog.newNameLabel", { name: item.name })}
            className="h-7 w-56 font-mono"
            value={draft}
            autoFocus
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
          />
          <IconButton icon={Check} label={t("branchesDialog.rename")} size="sm" disabled={pending} onClick={() => void save()} />
          <IconButton icon={X} label={t("common.cancel")} size="sm" disabled={pending} onClick={() => setEditing(false)} />
        </>
      ) : (
        <>
          <code className="min-w-0 truncate font-mono text-[12px] text-[var(--ink)]" title={item.name}>
            {item.name}
          </code>
          {item.is_current && <Badge>{t("branchesDialog.openInRepo")}</Badge>}
          {item.is_base && <Badge>{t("branchesDialog.baseOfNewTasks")}</Badge>}
          {!item.merged && <Badge>{t("branchesDialog.notMerged")}</Badge>}
          {item.busy && <Badge>{t("branchesDialog.busy")}</Badge>}
          {holders.length > 0 && (
            <Badge mono title={holders.map((id) => taskLabel(tasks, id)).join("\n")}>
              {holders.map((id) => `#${id}`).join(" ")}
            </Badge>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {item.rename_block ? (
              <Tip text={t("branchesDialog.renameBlocked", { reason: item.rename_block })}>
                <span className="inline-flex h-7 w-7 items-center justify-center text-[var(--ink-faint)]">
                  <Lock size={12} aria-hidden />
                  <span className="sr-only">{t("branchesDialog.renameBlocked", { reason: item.rename_block })}</span>
                </span>
              </Tip>
            ) : (
              <IconButton
                icon={Pencil}
                label={t("branchesDialog.renameNamed", { name: item.name })}
                size="sm"
                disabled={pending}
                onClick={() => {
                  setDraft(item.name);
                  setEditing(true);
                }}
              />
            )}
            {item.delete_block ? (
              <Tip text={t("branchesDialog.deleteBlocked", { reason: item.delete_block })}>
                <span className="inline-flex h-7 w-7 items-center justify-center text-[var(--ink-faint)]">
                  <Lock size={12} aria-hidden />
                  <span className="sr-only">{t("branchesDialog.deleteBlocked", { reason: item.delete_block })}</span>
                </span>
              </Tip>
            ) : (
              <IconButton
                icon={Trash2}
                label={t("branchesDialog.deleteNamed", { name: item.name })}
                size="sm"
                disabled={pending}
                onClick={() => onDelete(item)}
              />
            )}
          </div>
        </>
      )}

      {/* Reason for the prohibition as text, not only a tooltip: otherwise the lock looks
         like a malfunction rather than deliberate protection of running work. */}
      {!editing && (item.delete_block || item.rename_block) && (
        <p className="basis-full pl-5 text-[11px] leading-snug text-[var(--ink-faint)]">
          {item.delete_block ?? item.rename_block}
        </p>
      )}
    </li>
  );
}

/**
 * Project branches: what is in the repository, who holds them and how to change them.
 *
 * The "allowed/forbidden" rules are computed by the server (orc/branches.py) and sent as ready
 * text: we do not duplicate them here, otherwise the two copies would drift apart exactly when it
 * matters most.
 */
export function BranchesDialog({ open, onOpenChange, projectId, defaultBranch, tasks, onChanged }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<BranchesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [base, setBase] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<BranchInfo | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);

  // We read branches on every open: they could have been created in a terminal behind the
  // dashboard's back.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .branches(projectId)
      .then((next) => {
        if (!alive) return;
        setView(next);
        // Base for a "new branch": we keep the person's choice while such a branch exists
        setBase((b) => (b && next.branches.includes(b) ? b : next.base));
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(err(e));
      });
    return () => {
      alive = false;
    };
  }, [open, projectId]);

  const apply = (next: BranchesView) => {
    setView(next);
    setNote(next.note ?? null);
    setError(null);
    onChanged();
  };

  async function create() {
    setCreating(true);
    try {
      apply(await api.createBranch(projectId, name.trim(), base || null));
      setName("");
    } catch (e) {
      setError(err(e));
    } finally {
      setCreating(false);
    }
  }

  async function rename(from: string, to: string): Promise<boolean> {
    setBusyName(from);
    try {
      apply(await api.renameBranch(projectId, from, to));
      return true;
    } catch (e) {
      setError(err(e));
      return false;
    } finally {
      setBusyName(null);
    }
  }

  async function remove(item: BranchInfo, force: boolean) {
    setBusyName(item.name);
    try {
      apply(await api.deleteBranch(projectId, item.name, force));
      setDeleting(null);
    } catch (e) {
      // 409 is not a refusal but "confirm": the confirmation dialog is already open, we show the
      // fresh reason in it and wait for a repeated press.
      setError(err(e));
      if (!(e instanceof ApiError && e.status === 409)) setDeleting(null);
    } finally {
      setBusyName(null);
    }
  }

  async function saveDefault(next: string) {
    setSavingDefault(true);
    try {
      await api.patchProject(projectId, { default_branch: next || null });
      onChanged();
      // Re-read: changing the base moves the "base for new tasks" mark and may change the "not
      // merged" verdict of the other branches, since they are computed from the base.
      setView(await api.branches(projectId));
      setNote(next ? t("branchesDialog.noteWithBranch", { branch: next }) : t("branchesDialog.noteCurrentBranch"));
    } catch (e) {
      setError(err(e));
    } finally {
      setSavingDefault(false);
    }
  }

  const items = view?.items ?? [];

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={t("branchesDialog.title")}
        subtitle={
          view && (
            <span className="font-mono text-[11px]">
              {t("branchesDialog.subtitle", { current: view.current, base: view.base })}
            </span>
          )
        }
      >
        <div className="space-y-4">
          <p className="text-[12px] leading-relaxed text-[var(--ink-muted)]">
            {t("branchesDialog.intro1")} <code className="font-mono">orc/task-N</code>
            {t("branchesDialog.intro2")}
          </p>

          {error && (
            <p className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
              {error}
            </p>
          )}
          {note && !error && (
            <p className="rounded-[var(--radius-sm)] bg-[var(--sunken)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
              {note}
            </p>
          )}

          <Field
            label={t("projectDialog.baseBranchFieldLabel")}
            hint={t("branchesDialog.defaultBranchHint")}
          >
            <Select
              aria-label={t("projectDialog.baseBranchFieldLabel")}
              className="font-mono"
              value={defaultBranch ?? ""}
              disabled={savingDefault || view === null}
              onChange={(e) => void saveDefault(e.target.value)}
            >
              <option value="">
                {view ? t("projectDialog.currentRepoBranchWithName", { current: view.current }) : t("projectDialog.currentRepoBranch")}
              </option>
              {(view?.branches ?? []).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </Field>

          <section className="rounded-[var(--radius-sm)] border border-[var(--line)]">
            <h3 className="border-b border-[var(--line)] px-3 py-1.5 text-[12px] font-semibold text-[var(--ink)]">
              {t("branchesDialog.repoBranchesHeading")}
            </h3>
            {view === null ? (
              <p className="px-3 py-4 text-center text-[12px] text-[var(--ink-muted)]">{t("branchesDialog.readingBranches")}</p>
            ) : (
              <ul>
                {items.map((item) => (
                  <BranchRow
                    key={item.name}
                    item={item}
                    tasks={tasks}
                    busyName={busyName}
                    onRename={rename}
                    onDelete={setDeleting}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--line)] p-3">
            <h3 className="text-[12px] font-semibold text-[var(--ink)]">{t("branchesDialog.newBranchHeading")}</h3>
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t("branchesDialog.nameLabel")} className="min-w-48 flex-1">
                <Input
                  aria-label={t("branchesDialog.newBranchNameLabel")}
                  className="font-mono"
                  placeholder="feature/what-to-do"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim() && !creating) {
                      e.preventDefault();
                      void create();
                    }
                  }}
                />
              </Field>
              <Field label={t("branchesDialog.fromBranchLabel")} className="min-w-40">
                <Select
                  aria-label={t("branchesDialog.fromBranchLabel")}
                  className="font-mono"
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                >
                  {(view?.branches ?? []).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="primary"
                icon={Plus}
                loading={creating}
                disabled={!name.trim() || view === null}
                onClick={() => void create()}
              >
                {t("projectDialog.createFile")}
              </Button>
            </div>
          </section>
        </div>
      </Modal>

      {deleting && (
        <Confirm
          open
          title={t("branchesDialog.deleteTitle", { name: deleting.name })}
          confirmLabel={t("branchesDialog.deleteConfirm")}
          pending={busyName === deleting.name}
          onCancel={() => setDeleting(null)}
          // force=true right away: the warnings are listed right here, and a second identical
          // dialog after the 409 would repeat what the person has already read.
          onConfirm={() => void remove(deleting, true)}
        >
          <p>{t("branchesDialog.deleteBody", { name: deleting.name })}</p>
          {deleting.delete_warnings.map((w) => (
            <p key={w} className="text-[var(--danger)]">
              {w}
            </p>
          ))}
          {deleting.target_of.length > 0 && (
            <p className="text-[var(--ink-muted)]">
              {t("branchesDialog.deleteTargetOf", { tasks: deleting.target_of.map((id) => taskLabel(tasks, id)).join("; ") })}
            </p>
          )}
        </Confirm>
      )}
    </>
  );
}
