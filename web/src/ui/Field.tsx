import { forwardRef, useId } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";
import { fieldBase, focusRing } from "./tokens";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(fieldBase, "h-8", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(fieldBase, "resize-y py-1.5 leading-relaxed", className)} {...rest} />;
  },
);

/**
 * Native `<select>` in its own "box": we deliberately do not build a custom dropdown —
 * the system list opens instantly, works from the keyboard and does not break
 * inside a modal. We draw the arrow ourselves because the system one is removed by appearance-none.
 */
export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <span className="relative block">
        <select
          ref={ref}
          className={cn(fieldBase, "h-8 cursor-pointer appearance-none truncate pr-7", className)}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          size={13}
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ink-faint)]"
        />
      </span>
    );
  },
);

interface FieldProps {
  label: string;
  /** Hint under the field: why it exists and what happens if it is left empty. */
  hint?: string;
  /** Optional actions to the right of the label (for example, "Clear"). */
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/** Label + field + hint. The label in regular case: an all-caps "eyebrow" is not needed here. */
export function Field({ label, hint, aside, children, className }: FieldProps) {
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-[var(--ink-muted)]">{label}</span>
        {aside}
      </div>
      {children}
      {hint && <p className="text-[11px] leading-snug text-[var(--ink-faint)]">{hint}</p>}
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * Switch: a real `<input type=checkbox>` under a visual slider.
 * This way it stays accessible from the keyboard and to screen readers without manual ARIA work.
 */
export function Toggle({ checked, onChange, label, hint, disabled }: ToggleProps) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className={cn("peer h-5 w-9 cursor-pointer appearance-none rounded-full transition-colors duration-150", focusRing, "disabled:cursor-not-allowed disabled:opacity-50")}
          style={{ background: checked ? "var(--ok)" : "var(--line-strong)" }}
        />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-[left] duration-150",
            checked ? "left-[1.125rem]" : "left-[0.1875rem]",
          )}
        />
      </span>
      <label htmlFor={id} className="cursor-pointer select-none">
        <span className="block text-[13px] text-[var(--ink)]">{label}</span>
        {hint && <span className="block text-[11px] leading-snug text-[var(--ink-faint)]">{hint}</span>}
      </label>
    </div>
  );
}

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Row content to the right of the box. */
  children?: React.ReactNode;
}

/** Square checkbox: a native input + a drawn check mark on top. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, children, ...rest },
  ref,
) {
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          "peer h-4 w-4 cursor-pointer appearance-none rounded-[5px] border border-[var(--line-strong)] bg-[var(--sunken)] transition-colors",
          "checked:border-[var(--ok)] checked:bg-[var(--ok)] disabled:opacity-50",
          focusRing,
          className,
        )}
        {...rest}
      />
      <Check
        size={11}
        strokeWidth={3.5}
        aria-hidden
        className="pointer-events-none absolute left-0.5 top-1/2 -translate-y-1/2 scale-75 text-[var(--canvas)] opacity-0 transition peer-checked:scale-100 peer-checked:opacity-100"
      />
      {children}
    </span>
  );
});
