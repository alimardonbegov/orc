import { forwardRef, useEffect, useId, useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Popover as RxPopover } from "radix-ui";
import { cn } from "../lib/cn";
import { focusRing } from "./tokens";
import { useTranslation } from "../i18n";

export interface PickerOption<V> {
  value: V;
  label: string;
  /** Second line: what this option is. */
  hint?: string;
  /** Avatar, colored icon: what the option is recognized by before it is read. */
  leading?: React.ReactNode;
  /** Monospace: branches and other machine strings. */
  mono?: boolean;
  /** Pinned above the search results and never picked by Enter on a query: "Unassigned". */
  pinned?: boolean;
}

interface TriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** pill: the row under the title in the creation form. row: the properties column of a card. */
  variant?: "pill" | "row";
  /** The value cannot be changed now: it stays readable, without a hover or an arrow. */
  locked?: boolean;
}

/** What a picker looks like when closed. Both shapes are one component, so they cannot drift apart. */
export const PickerTrigger = forwardRef<HTMLButtonElement, TriggerProps>(function PickerTrigger(
  { variant = "pill", locked, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={locked || rest.disabled}
      {...rest}
      className={cn(
        "group/trigger flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--ink)] transition-colors duration-100",
        variant === "pill"
          ? "h-7 max-w-56 rounded-full border border-[var(--line)] bg-[var(--sunken)] px-2.5"
          : "min-h-7 w-full rounded-[var(--radius-sm)] px-1.5 text-left",
        locked
          ? "cursor-default"
          : cn(
              "cursor-pointer",
              variant === "pill" ? "hover:border-[var(--line-strong)]" : "hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]",
            ),
        focusRing,
        className,
      )}
    >
      {children}
      {!locked && variant === "row" && (
        <ChevronDown size={12} aria-hidden className="ml-auto shrink-0 text-[var(--ink-faint)] opacity-0 transition-opacity group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100" />
      )}
    </button>
  );
});

interface PanelProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  className?: string;
  /**
   * Give the focus back to the trigger on closing (the default). A picker that hands over to another one,
   * as the "+ Add property" menu does, turns it off: the returning focus would count as a click outside the
   * second picker and close it at once.
   */
  restoreFocus?: boolean;
}

/** The nearest element under the pointer that can actually scroll: the panel holds nested lists. */
function scrollableParent(from: Element, boundary: Element): HTMLElement | null {
  for (let el: Element | null = from; el && boundary.contains(el); el = el.parentElement) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

/**
 * The floating panel of a picker. Radix Dialog blocks wheel events outside its content, and a panel
 * inside a dialog is portalled outside it, so the panel scrolls by hand: otherwise a long list inside
 * a task card moves only by keyboard.
 */
export function PickerPanel({ trigger, children, open, onOpenChange, align = "start", className, restoreFocus = true }: PanelProps) {
  return (
    <RxPopover.Root open={open} onOpenChange={onOpenChange}>
      <RxPopover.Trigger asChild>{trigger}</RxPopover.Trigger>
      <RxPopover.Portal>
        <RxPopover.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          onCloseAutoFocus={restoreFocus ? undefined : (e) => e.preventDefault()}
          onWheel={(e) => {
            const list = scrollableParent(e.target as Element, e.currentTarget);
            if (list) list.scrollTop += e.deltaY;
          }}
          className={cn(
            "orc-anim-pop z-[60] flex max-h-[min(60vh,24rem)] w-72 flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-pop)]",
            className,
          )}
        >
          {children}
        </RxPopover.Content>
      </RxPopover.Portal>
    </RxPopover.Root>
  );
}

interface Props<V> {
  /** The property name, for screen readers and for the list. */
  label: string;
  /** The closed picker: a PickerTrigger, normally. */
  trigger: React.ReactNode;
  options: PickerOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  /** Search box above the list. */
  searchable?: boolean;
  /** Under the list and out of keyboard navigation: "New branch". */
  footer?: React.ReactNode;
  /** Instead of an empty list: why there is nothing to choose. */
  empty?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  restoreFocus?: boolean;
}

/**
 * A dropdown that shows what it offers: an avatar, a color, a second line. Native select cannot draw
 * any of it, and in a list of agents that is the whole point.
 */
export function Picker<V>({ label, trigger, options, value, onChange, searchable, footer, empty, open, onOpenChange, align, restoreFocus }: Props<V>) {
  const { t } = useTranslation();
  const [innerOpen, setInnerOpen] = useState(false);
  const isOpen = open ?? innerOpen;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  const setOpen = (next: boolean) => {
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
    if (next) {
      setQuery("");
      setActive(-1);
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => options.filter((o) => needle === "" || o.pinned || `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(needle)),
    [options, needle],
  );

  // A panel opened from outside (the "assign an agent" fix) starts at the current value as well
  useEffect(() => {
    if (isOpen && needle === "") setActive(shown.findIndex((o) => o.value === value));
    // Only on opening: moving the highlight must not snap back when the options refresh by a poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (needle !== "") setActive(shown.findIndex((o) => !o.pinned));
  }, [needle, shown]);

  useEffect(() => {
    if (!isOpen || active < 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, isOpen, listId]);

  const pick = (option: PickerOption<V>) => {
    if (option.value !== value) onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      // Enter must not submit the task form underneath, wherever the focus is
      e.preventDefault();
      const option = shown[active];
      if (option) pick(option);
    }
  };

  return (
    <PickerPanel trigger={trigger} open={isOpen} onOpenChange={setOpen} align={align} restoreFocus={restoreFocus}>
      <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
        {searchable && (
          <div className="relative shrink-0 border-b border-[var(--line)]">
            <Search size={12} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-faint)]" />
            <input
              autoFocus
              aria-label={t("card.searchIn", { label })}
              aria-controls={listId}
              placeholder={t("card.search")}
              className="h-8 w-full bg-transparent pl-7 pr-2.5 text-[12px] text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        {shown.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-[var(--ink-faint)]">{empty ?? t("card.nothingFound")}</div>
        ) : (
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            // Without a search box the list itself takes the focus, so the arrow keys work at once
            tabIndex={searchable ? undefined : 0}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 focus:outline-none"
          >
            {shown.map((option, i) => (
              <li
                key={String(option.value)}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={option.value === value}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(option)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px]",
                  i === active && "bg-[color-mix(in_oklab,var(--ink)_8%,transparent)]",
                )}
              >
                {option.leading}
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[var(--ink)]", option.mono && "font-mono text-[11px]")}>{option.label}</span>
                  {option.hint && <span className="block truncate text-[11px] leading-snug text-[var(--ink-faint)]">{option.hint}</span>}
                </span>
                {option.value === value && <Check size={13} aria-hidden className="shrink-0 text-[var(--ink-muted)]" />}
              </li>
            ))}
          </ul>
        )}
        {footer && <div className="shrink-0 border-t border-[var(--line)] p-1">{footer}</div>}
      </div>
    </PickerPanel>
  );
}
