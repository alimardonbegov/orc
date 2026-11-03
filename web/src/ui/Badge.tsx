import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

interface Props {
  children: React.ReactNode;
  icon?: LucideIcon;
  /** Ready-made color classes from STATUS_META/BLOCKER_META. Empty — a neutral badge. */
  tone?: string;
  /** Monospace — for machine strings: branches, paths, session identifiers. */
  mono?: boolean;
  /** Link badge: becomes a button and leads somewhere (for example, to a blocking task). */
  onClick?: () => void;
  className?: string;
  title?: string;
  /** Screen reader label when the badge text is assembled from pieces: the name computed from them
      loses the spaces between spans ("after #3· Backend"). */
  label?: string;
}

/** Badge: icon + short text. The color comes from outside because it means status. */
export function Badge({ children, icon: Icon, tone, mono, onClick, className, title, label }: Props) {
  const base = cn(
    "inline-flex max-w-full items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium leading-[1.4]",
    tone ?? "bg-[var(--sunken)] text-[var(--ink-muted)]",
    mono && "font-mono font-normal",
    className,
  );
  const content = (
    <>
      {Icon && <Icon size={11} className="shrink-0" aria-hidden />}
      <span className="truncate">{children}</span>
    </>
  );

  if (onClick) {
    // A clickable badge almost always sits inside something clickable — a task card,
    // which both opens on click and is dragged by mouse. So it suppresses the click, the drag
    // start, and keys: otherwise the backing element's action would fire instead of the navigation.
    return (
      <button
        type="button"
        title={title}
        aria-label={label}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={cn(
          base,
          "cursor-pointer underline decoration-dotted underline-offset-2 transition-colors duration-100",
          "hover:bg-[var(--line)] hover:text-[var(--ink)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <span title={title} aria-label={label} className={base}>
      {content}
    </span>
  );
}

/** State marker dot: where there is no room for a badge (collapsed sidebar, event row). */
export function Dot({ tone, className, pulse }: { tone: string; className?: string; pulse?: boolean }) {
  return <span aria-hidden className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", tone, pulse && "orc-pulse", className)} />;
}

/** Counter by a column or button heading. Digits are tabular — they do not jump when the number changes. */
export function Count({ value, className }: { value: number; className?: string }) {
  return (
    <span
      className={cn(
        "tnum inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--sunken)] px-1 text-[11px] font-medium text-[var(--ink-muted)]",
        className,
      )}
    >
      {value}
    </span>
  );
}
