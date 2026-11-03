import { useEffect, useMemo, useState } from "react";
import { FolderGit2, Lock, RefreshCw, Trash2 } from "lucide-react";
import { api, ApiError } from "../api";
import type { WorktreeInfo, WorktreesView } from "../types";
import { Badge } from "../ui/Badge";
import { Button, IconButton } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { Modal } from "../ui/Modal";
import { Tip } from "../ui/Overlays";
import { useTranslation } from "../i18n";
import { statusLabel } from "../labels";
import { STATUS_META } from "../status";
import { relativeTime, fullDateTime } from "../dates";
import { useNow } from "../hooks/useNow";
import { formatBytes } from "../bytes";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  /** Open the card of the task the worktree belongs to. */
  onOpenTask: (id: number) => void;
  /** Something was deleted — the board has something to re-read (cards lost their worktree). */
  onChanged: () => void;
}

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

const sumBytes = (items: WorktreeInfo[]) => items.reduce((acc, i) => acc + (i.size_bytes ?? 0), 0);

/** What we tear down: a single worktree by row, or a batch ("merged" / "all"). */
type Pending = { kind: "one"; item: WorktreeInfo } | { kind: "safe" | "all"; items: WorktreeInfo[] };

/** One worktree row: whose it is, how much it weighs, what state it is in, and whether it can be removed. */
function WorktreeRow({
  item,
  busy,
  onOpenTask,
  onDelete,
}: {
  item: WorktreeInfo;
  busy: boolean;
  onOpenTask: (id: number) => void;
  onDelete: (item: WorktreeInfo) => void;
}) {
  const { t, language } = useTranslation();
  const now = useNow();
  const activity = item.last_activity ? Date.parse(item.last_activity) : NaN;
  const procs = item.processes ?? [];

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--line)] px-3 py-2 last:border-0">
      <FolderGit2 size={12} className="shrink-0 text-[var(--ink-faint)]" aria-hidden />
      <code className="min-w-0 truncate font-mono text-[12px] text-[var(--ink)]" title={item.path}>
        {item.name}
      </code>

      {item.task_id !== null && item.task_title !== null && (
        <Badge
          mono
          className="max-w-[16rem]"
          title={`#${item.task_id} ${item.task_title}`}
          label={t("worktreesDialog.openTask", { id: item.task_id })}
          onClick={() => onOpenTask(item.task_id as number)}
        >
          #{item.task_id} {item.task_title}
        </Badge>
      )}
      {item.task_id !== null && item.task_title === null && (
        <Badge>{t("worktreesDialog.taskGone", { id: item.task_id })}</Badge>
      )}
      {item.task_status && (
        <Badge tone={STATUS_META[item.task_status].chip}>{statusLabel(t, item.task_status)}</Badge>
      )}
      {item.task_archived && <Badge>{t("worktreesDialog.archived")}</Badge>}
      {item.kind === "foreign" && <Badge>{t("worktreesDialog.foreign")}</Badge>}
      {item.kind === "merge" && <Badge>{t("worktreesDialog.tempMerge")}</Badge>}
      {item.merged === true && <Badge>{t("worktreesDialog.merged")}</Badge>}
      {item.merged === false && (
        <Badge tone="bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]">
          {t("worktreesDialog.notMerged", { target: item.target ?? "" })}
        </Badge>
      )}
      {!!item.dirty && (
        <Badge tone="bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]">
          {t("worktreesDialog.dirty", { count: item.dirty })}
        </Badge>
      )}
      {item.in_use && (
        <Badge
          tone="bg-[color-mix(in_oklab,var(--st-progress)_16%,transparent)] text-[var(--st-progress)]"
          title={procs.map((p) => `${p.name} (${p.pid})`).join("\n") || undefined}
        >
          {procs.length > 0
            ? t("worktreesDialog.inUseBy", { names: [...new Set(procs.map((p) => p.name || "?"))].join(", ") })
            : t("worktreesDialog.inUse")}
        </Badge>
      )}
      {!item.registered && item.exists && <Badge>{t("worktreesDialog.notRegistered")}</Badge>}
      {!item.exists && <Badge>{t("worktreesDialog.missing")}</Badge>}
      {item.locked && <Badge>{t("worktreesDialog.locked")}</Badge>}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {!Number.isNaN(activity) && (
          <span className="tnum text-[11px] text-[var(--ink-faint)]" title={fullDateTime(activity, language)}>
            {relativeTime(activity, language, now)}
          </span>
        )}
        <span className="tnum w-16 text-right text-[12px] font-medium text-[var(--ink)]">
          {item.size_bytes === null ? "—" : formatBytes(item.size_bytes, language)}
        </span>
        {item.delete_block ? (
          <Tip text={t("worktreesDialog.deleteBlocked", { reason: item.delete_block })}>
            <span className="inline-flex h-7 w-7 items-center justify-center text-[var(--ink-faint)]">
              <Lock size={12} aria-hidden />
              <span className="sr-only">{t("worktreesDialog.deleteBlocked", { reason: item.delete_block })}</span>
            </span>
          </Tip>
        ) : (
          <IconButton
            icon={Trash2}
            label={t("worktreesDialog.deleteNamed", { name: item.name })}
            size="sm"
            disabled={busy}
            onClick={() => onDelete(item)}
          />
        )}
      </div>

      {/* The reason for the refusal as text, not only a tooltip: otherwise the lock looks
          like a breakage, not like deliberate protection of work in progress. */}
      {item.delete_block && (
        <p className="basis-full pl-5 text-[11px] leading-snug text-[var(--ink-faint)]">{item.delete_block}</p>
      )}
    </li>
  );
}

/**
 * Project worktrees (.claude/worktrees): how many, whose, how much they weigh and what can be done with them.
 *
 * A task's worktree stays after the merge on purpose — "Rework" relies on it. Here its
 * cost is visible in bytes, and worktrees can be removed one by one, all merged at once, or all of them.
 * The "allowed / not allowed" rules are computed by the server (orc/worktrees.py) and sent as ready-made text.
 */
export function WorktreesDialog({ open, onOpenChange, projectId, onOpenTask, onChanged }: Props) {
  const { t, language } = useTranslation();
  const [view, setView] = useState<WorktreesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The dialog mounts already open (App renders it by a flag), so the first read happens immediately
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Pending | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reload, setReload] = useState(0);

  // Read on every open: worktrees are created and removed outside the dashboard too (Claude Code sessions, terminal).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .worktrees(projectId)
      .then((next) => {
        if (!alive) return;
        setView(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(err(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, projectId, reload]);

  // Heaviest first: that is why the dialog gets opened.
  const items = useMemo(
    () => [...(view?.items ?? [])].sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0) || a.name.localeCompare(b.name)),
    [view],
  );
  const deletable = items.filter((i) => !i.delete_block);
  const safe = deletable.filter((i) => i.safe);

  const refresh = () => {
    setLoading(true);
    setReload((n) => n + 1);
  };

  async function remove(target: Pending) {
    const names = target.kind === "one" ? [target.item.name] : target.items.map((i) => i.name);
    setDeleting(true);
    try {
      // force=true right away: everything that will be lost is listed in the confirmation dialog.
      const next = await api.deleteWorktrees(projectId, names, true);
      setView(next);
      setNote(next.note ?? null);
      setError(null);
      setPending(null);
      onChanged();
    } catch (e) {
      setError(err(e));
      // Worktrees may have been deleted partially or changed under us — show them as they are now.
      if (!(e instanceof ApiError && e.status === 409)) setPending(null);
      refresh();
    } finally {
      setDeleting(false);
    }
  }

  const pendingItems = pending === null ? [] : pending.kind === "one" ? [pending.item] : pending.items;
  const withWarnings = pendingItems.filter((i) => i.delete_warnings.length > 0);

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={t("worktreesDialog.title")}
        subtitle={view && <span className="font-mono text-[11px]">{view.root}</span>}
        actions={
          <IconButton
            icon={RefreshCw}
            label={t("worktreesDialog.refresh")}
            size="sm"
            disabled={loading || deleting}
            onClick={refresh}
          />
        }
      >
        <div className="space-y-4">
          <p className="text-[12px] leading-relaxed text-[var(--ink-muted)]">{t("worktreesDialog.intro")}</p>

          {error && (
            <p className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
              {error}
            </p>
          )}
          {note && !error && (
            <p className="rounded-[var(--radius-sm)] bg-[var(--sunken)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">{note}</p>
          )}
          {view && !view.processes_known && (
            <p className="text-[11px] leading-snug text-[var(--ink-faint)]">{t("worktreesDialog.processesUnknown")}</p>
          )}

          {view && items.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[12px] text-[var(--ink)]">
                <span className="font-semibold">
                  {t("worktreesDialog.summary", { count: items.length, size: formatBytes(view.total_bytes, language) })}
                </span>
                {safe.length > 0 && (
                  <span className="text-[var(--ink-muted)]">
                    {" · "}
                    {t("worktreesDialog.safeSummary", { count: safe.length, size: formatBytes(sumBytes(safe), language) })}
                  </span>
                )}
              </p>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={safe.length === 0 || deleting}
                  onClick={() => setPending({ kind: "safe", items: safe })}
                >
                  {t("worktreesDialog.removeSafe", { count: safe.length })}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={Trash2}
                  disabled={deletable.length === 0 || deleting}
                  onClick={() => setPending({ kind: "all", items: deletable })}
                >
                  {t("worktreesDialog.removeAll", { count: deletable.length })}
                </Button>
              </div>
            </div>
          )}

          <section className="rounded-[var(--radius-sm)] border border-[var(--line)]">
            {view === null ? (
              <p className="px-3 py-4 text-center text-[12px] text-[var(--ink-muted)]">
                {loading ? t("worktreesDialog.reading") : "—"}
              </p>
            ) : items.length === 0 ? (
              <p className="px-3 py-4 text-center text-[12px] text-[var(--ink-muted)]">{t("worktreesDialog.empty")}</p>
            ) : (
              <ul className={loading ? "opacity-60" : undefined}>
                {items.map((item) => (
                  <WorktreeRow
                    key={item.name}
                    item={item}
                    busy={deleting}
                    onOpenTask={(id) => {
                      onOpenChange(false);
                      onOpenTask(id);
                    }}
                    onDelete={(it) => setPending({ kind: "one", item: it })}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </Modal>

      {pending && (
        <Confirm
          open
          title={
            pending.kind === "one"
              ? t("worktreesDialog.deleteTitle", { name: pending.item.name })
              : pending.kind === "safe"
                ? t("worktreesDialog.bulkTitleSafe", { count: pending.items.length })
                : t("worktreesDialog.bulkTitleAll", { count: pending.items.length })
          }
          confirmLabel={pending.kind === "one" ? t("worktreesDialog.deleteConfirm") : t("worktreesDialog.bulkConfirm")}
          pending={deleting}
          onCancel={() => setPending(null)}
          onConfirm={() => void remove(pending)}
        >
          {pending.kind === "one" ? (
            <p>
              {t("worktreesDialog.deleteBody", {
                path: pending.item.path,
                size: pending.item.size_bytes === null ? "—" : formatBytes(pending.item.size_bytes, language),
              })}
            </p>
          ) : (
            <p>{t("worktreesDialog.bulkBody", { size: formatBytes(sumBytes(pending.items), language) })}</p>
          )}
          <p className="text-[var(--ink-muted)]">{t("worktreesDialog.branchNote")}</p>
          {withWarnings.length > 0 && (
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {pending.kind !== "one" && <p className="font-medium">{t("worktreesDialog.bulkWarningsHeading")}</p>}
              {withWarnings.map((i) =>
                i.delete_warnings.map((w) => (
                  <p key={`${i.name}:${w}`} className="text-[12px] text-[var(--danger)]">
                    {pending.kind === "one" ? w : `${i.name}: ${w}`}
                  </p>
                )),
              )}
            </div>
          )}
        </Confirm>
      )}
    </>
  );
}
