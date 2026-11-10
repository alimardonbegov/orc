import { FileWarning } from "lucide-react";
import type { WorkIssue } from "../status";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useTranslation } from "../i18n";

interface Props {
  open: boolean;
  /** What stands between the card and work: see workIssues. */
  issues: WorkIssue[];
  /** Number and title of the card: the dialog also opens from the board, where the task is not open. */
  taskId: number;
  taskTitle: string;
  /** Take the person to what needs filling in. The main action: a refusal without a fix is useless. */
  onFix: () => void;
  onClose: () => void;
}

/**
 * Refusal to send a card to work: its description is empty or nobody is assigned.
 *
 * A modal, not a toast: this is not "something went wrong" but a fork. Until it is fixed there is
 * nowhere to go, and the person needs the field, not a notification in the corner. The server refuses
 * with the same reasons (orc/api/common.py): the interface catches them earlier to offer the fix.
 */
export function NotReadyDialog({ open, issues, taskId, taskTitle, onFix, onClose }: Props) {
  const { t } = useTranslation();
  const onlyDescription = issues.length === 1 && issues[0] === "description";
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={onlyDescription ? t("emptyDescriptionDialog.title") : t("card.notReady.title")}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("emptyDescriptionDialog.notNow")}
          </Button>
          <Button variant="primary" icon={FileWarning} onClick={onFix}>
            {onlyDescription ? t("emptyDescriptionDialog.fix") : t("card.notReady.fix")}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-[13px] leading-relaxed text-[var(--ink)]">
        <p>{onlyDescription ? t("emptyDescriptionDialog.body1", { id: taskId, title: taskTitle }) : t("card.notReady.body", { id: taskId, title: taskTitle })}</p>
        {issues.includes("assignee") && <p className="text-[var(--ink-muted)]">{t("card.notReady.assignee")}</p>}
        {issues.includes("description") && <p className="text-[var(--ink-muted)]">{t("emptyDescriptionDialog.body2")}</p>}
      </div>
    </Modal>
  );
}
