import { FileWarning } from "lucide-react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useTranslation } from "../i18n";

interface Props {
  open: boolean;
  /** Number and title of the card: the dialog also opens from the board, where the task is not
   * open. */
  taskId: number;
  taskTitle: string;
  /** Open the description editor. The main action: a refusal without a fix is useless. */
  onFix: () => void;
  onClose: () => void;
}

/**
 * Refusal to send a card with an empty description to work.
 *
 * A modal, not a toast: this is not "something went wrong" but a fork: until the description is
 * written there is nowhere to go, and the person needs a text field, not a notification in the
 * corner. The same text also comes from the server (orc/api.py, EMPTY_DESCRIPTION_ERROR): the
 * interface catches the error earlier to give the editor right away.
 */
export function EmptyDescriptionDialog({ open, taskId, taskTitle, onFix, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("emptyDescriptionDialog.title")}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("emptyDescriptionDialog.notNow")}
          </Button>
          <Button variant="primary" icon={FileWarning} onClick={onFix}>
            {t("emptyDescriptionDialog.fix")}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-[13px] leading-relaxed text-[var(--ink)]">
        <p>{t("emptyDescriptionDialog.body1", { id: taskId, title: taskTitle })}</p>
        <p className="text-[var(--ink-muted)]">{t("emptyDescriptionDialog.body2")}</p>
      </div>
    </Modal>
  );
}
