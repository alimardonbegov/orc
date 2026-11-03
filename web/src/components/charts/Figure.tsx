import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useTranslation } from "../../i18n";

/**
 * Common chart frame: heading, caption, legend, body.
 *
 * Dashboard cards are identical outside and different inside — so the eye does not reassemble
 * the structure on each one. The legend lives in the header, not over the data: it is needed once,
 * at first reading, and must not take space in the chart area.
 */
export function Figure({
  title,
  hint,
  legend,
  aside,
  children,
  className,
}: {
  title: string;
  hint?: string;
  legend?: ReactNode;
  /** Right corner of the header: a total, a switcher, anything short. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // aria-label duplicates the heading on purpose: not all accessibility engines name a <figure> from
    // its <figcaption>, and without a name the card is announced simply as "illustration".
    <figure
      aria-label={title}
      className={cn("m-0 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] p-3", className)}
    >
      <figcaption className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[12px] font-semibold tracking-tight text-[var(--ink)]">{title}</h3>
        {hint && <p className="m-0 min-w-0 flex-1 text-[11px] text-[var(--ink-faint)]">{hint}</p>}
        {legend && <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">{legend}</div>}
        {aside && <div className="ml-auto shrink-0">{aside}</div>}
      </figcaption>
      {children}
    </figure>
  );
}

/**
 * Legend key: a colored marker plus a label in plain text.
 * Text is never colored in the series color — light status shades are unreadable as letters;
 * identification is carried by the marker beside it, not by the label itself.
 */
export function LegendKey({ tone, children, line }: { tone: string; children: ReactNode; line?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--ink-muted)]">
      <span
        aria-hidden
        className={cn("inline-block shrink-0 rounded-[2px]", line ? "h-[2px] w-3.5" : "h-2 w-2")}
        style={{ background: tone }}
      />
      {children}
    </span>
  );
}

/** Empty chart area: there is no data for the period, and this must be said in words, not by an empty axis. */
export function NoData({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <p className="m-0 flex min-h-[72px] items-center justify-center text-center text-[12px] text-[var(--ink-faint)]">
      {children ?? t("charts.noDataForPeriod")}
    </p>
  );
}
