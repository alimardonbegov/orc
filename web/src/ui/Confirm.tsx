import { Modal } from "./Modal";
import { Button, type ButtonVariant } from "./Button";
import { useTranslation } from "../i18n";

interface Props {
  open: boolean;
  title: string;
  /** Label on the confirm button: an imperative verb, not "OK". */
  confirmLabel: string;
  /** Confirm button variant: danger — when the action is irreversible. */
  confirmVariant?: ButtonVariant;
  /** A request is in flight: both buttons are disabled, the dialog does not close on an outside click. */
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Explanation of the consequences: what exactly will happen and what will have to be done by hand afterwards. */
  children: React.ReactNode;
}

/**
 * Confirmation of a dangerous action.
 *
 * A separate component rather than `window.confirm`: the system dialog can neither explain
 * the consequences in human terms nor name the button after the action — and that is exactly what is missing
 * where "Yes" means a stopped session and an unmerged branch.
 */
export function Confirm({ open, title, confirmLabel, confirmVariant = "danger", pending, onConfirm, onCancel, children }: Props) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && !pending && onCancel()}
      title={title}
      size="sm"
      sticky={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant={confirmVariant} loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-[13px] leading-relaxed text-[var(--ink)]">{children}</div>
    </Modal>
  );
}
