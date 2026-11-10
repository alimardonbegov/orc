import { Archive, ArchiveRestore, ChevronDown, Tag, TagsIcon, X } from "lucide-react";
import { Picker, PickerTrigger } from "../ui/Picker";
import { Modal } from "../ui/Modal";
import { Button, IconButton } from "../ui/Button";
import { useTranslation } from "../i18n";
import { agentsForProject } from "../agents";
import { useAgents } from "../agents";
import { useLabels } from "../hooks/useLabels";
import { priorityLabel, statusLabel } from "../labels";
import { PRIORITIES, capitalized } from "../priority";
import { AgentAvatar } from "./AgentAvatar";
import { PriorityIcon } from "./cardProperties/PriorityProperty";
import type { BulkBody, BulkResult, Task } from "../types";

interface Props {
  /** The selected cards, all of one project. */
  tasks: Task[];
  projectId: number;
  /** The board shows the archive: the only thing left to do with those cards is to bring them back. */
  archivedView: boolean;
  pending: boolean;
  onApply: (body: Omit<BulkBody, "task_ids">) => void;
  onClear: () => void;
}

const UNASSIGN = 0;

/**
 * The bar that floats over the bottom of the board while cards are selected. One action per press: the server
 * checks every card by the same rules as a single edit, so a card without an agent does not go to "To do" here
 * either, and the answer says so card by card (BulkResultDialog).
 */
export function BatchToolbar({ tasks, projectId, archivedView, pending, onApply, onClear }: Props) {
  const { t } = useTranslation();
  const agents = agentsForProject(useAgents(), projectId);
  const { labels } = useLabels();
  if (tasks.length === 0) return null;
  const onCards = new Set(tasks.flatMap((task) => (task.labels ?? []).map((l) => l.name)));
  const trigger = (text: string, icon?: React.ReactNode) => (
    <PickerTrigger disabled={pending} aria-label={text}>
      {icon}
      <span className="truncate">{text}</span>
      <ChevronDown size={12} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
    </PickerTrigger>
  );
  return (
    <div
      role="toolbar"
      aria-label={t("bulk.selected", { count: tasks.length })}
      className="pointer-events-auto fixed bottom-5 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--surface)] px-2.5 py-2 shadow-[var(--shadow-pop)]"
    >
      <span className="tnum px-1 text-[12px] font-semibold text-[var(--ink)]">{t("bulk.selected", { count: tasks.length })}</span>
      {archivedView ? (
        <Button size="sm" variant="secondary" icon={ArchiveRestore} disabled={pending} onClick={() => onApply({ archived: false })}>
          {t("bulk.unarchive")}
        </Button>
      ) : (
        <>
          <Picker
            label={t("bulk.status")}
            trigger={trigger(t("bulk.status"))}
            value={null}
            onChange={(status: "backlog" | "todo") => onApply({ status })}
            options={(["backlog", "todo"] as const).map((s) => ({ value: s, label: statusLabel(t, s) }))}
          />
          <Picker
            label={t("bulk.priority")}
            trigger={trigger(t("bulk.priority"))}
            value={null}
            onChange={(priority) => onApply({ priority })}
            options={PRIORITIES.map((p) => ({
              value: p,
              label: capitalized(priorityLabel(t, p)),
              leading: <PriorityIcon priority={p} size={14} />,
            }))}
          />
          <Picker
            label={t("bulk.agent")}
            trigger={trigger(t("bulk.agent"))}
            value={null}
            onChange={(id: number) => onApply({ agent_id: id === UNASSIGN ? null : id })}
            searchable={agents.length > 8}
            options={[
              { value: UNASSIGN, label: t("bulk.unassign"), pinned: true },
              ...agents.map((a) => ({ value: a.id, label: a.name, leading: <AgentAvatar agent={a} size={18} /> })),
            ]}
          />
          <Picker
            label={t("bulk.addLabel")}
            trigger={trigger(t("bulk.addLabel"), <Tag size={12} aria-hidden />)}
            value={null}
            onChange={(name: string) => onApply({ add_labels: [name] })}
            searchable={labels.length > 8}
            empty={t("bulk.noLabels")}
            options={labels.map((l) => ({
              value: l.name,
              label: l.name,
              leading: <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: l.color }} />,
            }))}
          />
          {onCards.size > 0 && (
            <Picker
              label={t("bulk.removeLabel")}
              trigger={trigger(t("bulk.removeLabel"), <TagsIcon size={12} aria-hidden />)}
              value={null}
              onChange={(name: string) => onApply({ remove_labels: [name] })}
              options={labels
                .filter((l) => onCards.has(l.name))
                .map((l) => ({
                  value: l.name,
                  label: l.name,
                  leading: <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: l.color }} />,
                }))}
            />
          )}
          <Button size="sm" variant="secondary" icon={Archive} disabled={pending} onClick={() => onApply({ archived: true })}>
            {t("bulk.archive")}
          </Button>
        </>
      )}
      <IconButton icon={X} label={t("bulk.clear")} size="sm" onClick={onClear} />
    </div>
  );
}

/** The honest account of a partial refusal: which cards the server did not change, and why. */
export function BulkResultDialog({ result, tasks, onClose }: { result: BulkResult | null; tasks: Task[]; onClose: () => void }) {
  const { t } = useTranslation();
  if (!result) return null;
  const refused = result.results.filter((r) => !r.ok);
  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("bulk.resultTitle")}
      size="sm"
      footer={<Button onClick={onClose}>{t("bulk.resultClose")}</Button>}
    >
      <p className="mb-3 text-[13px] text-[var(--ink-muted)]">{t("bulk.resultBody", { ok: result.ok, failed: result.failed })}</p>
      <ul className="flex flex-col gap-2">
        {refused.map((r) => (
          <li key={r.id} className="rounded-[var(--radius-sm)] border border-[var(--line)] px-2.5 py-1.5 text-[12px]">
            <div className="font-medium text-[var(--ink)]">
              <span className="tnum font-mono text-[var(--ink-faint)]">#{r.id}</span> {tasks.find((x) => x.id === r.id)?.title ?? ""}
            </div>
            <div className="text-[var(--danger)]">{r.error}</div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
