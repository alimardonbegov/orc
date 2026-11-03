import { cn } from "../lib/cn";
import { focusRing } from "./tokens";

interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}

/**
 * A switch of two or three mutually exclusive options.
 * The radiogroup role, not a set of buttons: moving between options with arrows is more familiar,
 * and a screen reader announces "1 of 3" rather than three separate buttons in a row.
 */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel, className }: Props<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--sunken)] p-0.5", className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-7 rounded-[5px] px-2.5 text-[12px] font-medium transition-colors duration-100",
              focusRing,
              active
                ? "bg-[var(--surface)] text-[var(--ink)] shadow-[var(--shadow-card)]"
                : "text-[var(--ink-muted)] hover:text-[var(--ink)]",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
