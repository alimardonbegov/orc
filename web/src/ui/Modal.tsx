import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { cn } from "../lib/cn";
import { IconButton } from "./Button";
import { useTranslation } from "../i18n";

type Size = "sm" | "md" | "lg" | "xl";

const WIDTH: Record<Size, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
  // xl — almost the whole screen: for windows where the content is itself a list or a table
  // and needs all the available width (the event feed).
  xl: "max-w-6xl",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Line under the heading: identifiers, branch, status. */
  subtitle?: React.ReactNode;
  /** Buttons in the header to the left of the cross. */
  actions?: React.ReactNode;
  /** Pinned bottom: the form's main actions. */
  footer?: React.ReactNode;
  size?: Size;
  /**
   * Do not close on a click outside the window. Enabled while the window has unsaved
   * input or a request in flight: losing typed text because of an accidental click on
   * the backdrop is the worst possible outcome.
   *
   * Escape keeps closing the window always: it is a deliberate action,
   * not a miss, and taking away a person's keyboard exit is not acceptable.
   */
  sticky?: boolean;
  /**
   * Remove the padding around the content. For windows where the content is a full-width list:
   * rows must highlight edge to edge and keep their own padding.
   */
  flush?: boolean;
  children: React.ReactNode;
}

/**
 * Modal window on Radix Dialog: a portal to the end of body, focus trap, focus return
 * to the source button, Escape, background scroll lock, aria-modal.
 * It used to be a hand-made div with onClick on the backdrop — it closed on a click
 * anywhere inside, did not hold focus and did not restore it.
 *
 * The header and bottom are pinned, only the content scrolls: in a long task
 * card the "Save"/"Close" buttons must stay in view.
 */
export function Modal({ open, onOpenChange, title, subtitle, actions, footer, size = "md", sticky, flush, children }: Props) {
  const { t } = useTranslation();
  const blockOutside = (e: Event) => {
    if (sticky) e.preventDefault();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="orc-anim-fade fixed inset-0 z-40 bg-[rgb(0_0_0/0.55)] backdrop-blur-[2px]" />
        <Dialog.Content
          onInteractOutside={blockOutside}
          className={cn(
            "orc-anim-sheet fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,52rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col",
            "overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-pop)]",
            WIDTH[size],
          )}
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-[var(--line)] px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-[15px] font-semibold leading-tight text-[var(--ink)]">
                {title}
              </Dialog.Title>
              {subtitle && <div className="mt-1 text-[12px] text-[var(--ink-muted)]">{subtitle}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {actions}
              <Dialog.Close asChild>
                <IconButton icon={X} label={t("common.close")} size="sm" />
              </Dialog.Close>
            </div>
          </header>

          <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", !flush && "px-5 py-4")}>{children}</div>

          {footer && (
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--line)] bg-[var(--sunken)] px-5 py-3">
              {footer}
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
