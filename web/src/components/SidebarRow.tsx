import { forwardRef } from "react";
import type { LucideIcon } from "lucide-react";
import { focusRing } from "../ui/tokens";
import { cn } from "../lib/cn";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Row label. */
  children: React.ReactNode;
  /** The row leads to the panel that is open right now: we highlight it the same way as the
   * selected project. */
  active?: boolean;
  /** What stands at the right edge: unread counter, a short note. */
  trailing?: React.ReactNode;
}

/**
 * Item of the column's bottom navigation: "Events", "Settings".
 *
 * The shape is exactly the same as the project item above: the bottom of the column should read as
 * a continuation of one list, not a scatter of buttons of different calibre.
 */
export const SidebarRow = forwardRef<HTMLButtonElement, Props>(function SidebarRow(
  { icon: Icon, children, active, trailing, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-[13px] transition-colors duration-100",
        focusRing,
        active
          ? "bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] text-[var(--ink)]"
          : "text-[var(--ink-muted)] hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] hover:text-[var(--ink)]",
        className,
      )}
      {...rest}
    >
      <Icon size={14} aria-hidden className="shrink-0" />
      <span className="truncate">{children}</span>
      {trailing && <span className="ml-auto flex shrink-0 items-center">{trailing}</span>}
    </button>
  );
});
