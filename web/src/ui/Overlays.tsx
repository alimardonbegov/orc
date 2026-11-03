import { createContext, useContext } from "react";
import { Popover as RxPopover, Tooltip as RxTooltip } from "radix-ui";
import { cn } from "../lib/cn";

/* Radix requires a tooltip provider higher up the tree and fails without it. We keep our own
   "provider already exists" flag: in the app there is one for everything (see main.tsx) and it gives
   a shared delay skip between neighboring buttons, while a component rendered
   on its own — for example, in a test — raises a provider for itself. */
const HasTooltipProvider = createContext(false);

export function TooltipProvider({ children, ...rest }: React.ComponentProps<typeof RxTooltip.Provider>) {
  return (
    <HasTooltipProvider.Provider value={true}>
      <RxTooltip.Provider {...rest}>{children}</RxTooltip.Provider>
    </HasTooltipProvider.Provider>
  );
}

/**
 * Tooltip. One provider per app (see main.tsx): without it Radix complains,
 * and with a shared provider neighboring tooltips open without a repeated delay.
 */
export function Tip({
  children,
  text,
  side = "bottom",
}: {
  children: React.ReactNode;
  text: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  const inProvider = useContext(HasTooltipProvider);
  const root = (
    <RxTooltip.Root>
      <RxTooltip.Trigger asChild>{children}</RxTooltip.Trigger>
      <RxTooltip.Portal>
        <RxTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="orc-anim-pop z-[60] max-w-64 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--raised)] px-2 py-1 text-[12px] leading-snug text-[var(--ink)] shadow-[var(--shadow-pop)]"
        >
          {text}
        </RxTooltip.Content>
      </RxTooltip.Portal>
    </RxTooltip.Root>
  );
  return inProvider ? root : <RxTooltip.Provider delayDuration={450}>{root}</RxTooltip.Provider>;
}

interface PopoverProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  /** Panel heading; a divider line is drawn with it. */
  title?: React.ReactNode;
  /** Actions on the right of the heading. */
  actions?: React.ReactNode;
}

/**
 * Popover on Radix: a portal (not clipped by the parent's overflow), automatic
 * positioning aware of screen edges, closing on Escape and outside click,
 * focus return. The previous events panel was `absolute` inside the header —
 * it got clipped and overlapped the buttons beneath it.
 */
export function Popover({ trigger, children, open, onOpenChange, align = "end", side = "bottom", className, title, actions }: PopoverProps) {
  return (
    <RxPopover.Root open={open} onOpenChange={onOpenChange}>
      <RxPopover.Trigger asChild>{trigger}</RxPopover.Trigger>
      <RxPopover.Portal>
        <RxPopover.Content
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={12}
          className={cn(
            "orc-anim-pop z-50 flex max-h-[min(70vh,34rem)] w-[22rem] flex-col overflow-hidden",
            "rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-pop)]",
            className,
          )}
        >
          {(title || actions) && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2">
              <span className="text-[12px] font-semibold text-[var(--ink)]">{title}</span>
              {actions}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        </RxPopover.Content>
      </RxPopover.Portal>
    </RxPopover.Root>
  );
}

export const PopoverClose = RxPopover.Close;
