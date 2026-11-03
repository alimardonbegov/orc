import { forwardRef } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { focusRing } from "./tokens";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon to the left of the label. */
  icon?: LucideIcon;
  /** Icon to the right — for "expanding" buttons (chevron). */
  iconRight?: LucideIcon;
  /** A request is in flight: the button is disabled, the icon is replaced by a spinner, the label stays in place. */
  loading?: boolean;
}

/* The primary button is monochrome: color in the interface is taken by task statuses,
   and a brand-blue button would compete with the badges (see index.css). */
const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--primary)] text-[var(--primary-ink)] hover:opacity-90 active:opacity-80 shadow-[var(--shadow-card)]",
  secondary:
    "bg-[var(--raised)] text-[var(--ink)] border border-[var(--line)] hover:border-[var(--line-strong)] hover:bg-[color-mix(in_oklab,var(--ink)_5%,var(--raised))] active:bg-[color-mix(in_oklab,var(--ink)_9%,var(--raised))]",
  ghost:
    "text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] active:bg-[color-mix(in_oklab,var(--ink)_13%,transparent)]",
  danger:
    "text-[var(--danger)] border border-[color-mix(in_oklab,var(--danger)_35%,transparent)] hover:bg-[color-mix(in_oklab,var(--danger)_12%,transparent)]",
  quiet: "text-[var(--ink-muted)] hover:text-[var(--ink)] underline-offset-2 hover:underline",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-[12px] rounded-[var(--radius-sm)]",
  md: "h-8 gap-1.5 px-3 text-[13px] rounded-[var(--radius-sm)]",
  lg: "h-10 gap-2 px-4 text-[14px] rounded-[var(--radius)]",
};

const ICON_SIZE: Record<ButtonSize, number> = { sm: 13, md: 14, lg: 16 };

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", size = "md", icon: Icon, iconRight: IconRight, loading, className, children, disabled, ...rest },
  ref,
) {
  const s = ICON_SIZE[size];
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,border-color,opacity,color] duration-100",
        "disabled:pointer-events-none disabled:opacity-45",
        focusRing,
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 size={s} className="animate-spin" aria-hidden />
      ) : (
        Icon && <Icon size={s} aria-hidden />
      )}
      {children}
      {IconRight && !loading && <IconRight size={s} aria-hidden />}
    </button>
  );
});

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Required: an icon button has no visible label. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const ICON_ONLY_SIZE: Record<ButtonSize, string> = {
  sm: "h-7 w-7 rounded-[var(--radius-sm)]",
  md: "h-8 w-8 rounded-[var(--radius-sm)]",
  lg: "h-10 w-10 rounded-[var(--radius)]",
};

/** Square button without a label. The label goes into aria-label and title. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, variant = "ghost", size = "md", loading, className, ...rest },
  ref,
) {
  const s = ICON_SIZE[size] + 2;
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      disabled={rest.disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center transition-[background-color,border-color,opacity,color] duration-100",
        "disabled:pointer-events-none disabled:opacity-45",
        focusRing,
        VARIANT[variant],
        ICON_ONLY_SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={s} className="animate-spin" aria-hidden /> : <Icon size={s} aria-hidden />}
    </button>
  );
});
