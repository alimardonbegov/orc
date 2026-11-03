import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";

/** Comparison with the previous period: sign, label and which direction is "good". */
export interface TileDelta {
  /** Ready-made string: "+3", "−12%", "+$4.10". */
  text: string;
  /** Better, worse or no judgment (for example, "queued" — neither). */
  tone: "good" | "bad" | "neutral";
  /** Full label for the tooltip and screen reader: "vs the 30 days before: 21". */
  title: string;
}

/**
 * Metric tile: label, number, a context line under it and a delta against the previous period.
 *
 * The number is deliberately NOT monospace (unlike the counters on the board): `tabular-nums`
 * stretches large digits, and "121" looks loose. Tabular digits stay where
 * columns of numbers align vertically — in the tables below.
 *
 * The delta is a separate element, not part of the label: "got better or worse" is what
 * people look at the tile a second time for, and it must be readable without reading words. The delta's color
 * means judgment, not direction: growing failures are red, growing completions are green.
 */
export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  title,
  delta,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  /** CSS color of the value: only where color means status. Empty — plain ink. */
  tone?: string;
  title?: string;
  delta?: TileDelta | null;
}) {
  return (
    <div
      title={title}
      className="min-w-0 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5"
    >
      <p className="m-0 flex items-center gap-1.5 text-[11px] font-medium text-[var(--ink-muted)]">
        {Icon && <Icon size={12} aria-hidden className="shrink-0" />}
        <span className="truncate">{label}</span>
      </p>
      <p className="m-0 mt-0.5 flex items-baseline gap-2">
        <span
          className={cn("truncate text-[22px] font-semibold leading-tight tracking-tight", !tone && "text-[var(--ink)]")}
          style={tone ? { color: tone } : undefined}
        >
          {value}
        </span>
        {delta && (
          <span
            title={delta.title}
            aria-label={delta.title}
            className={cn(
              "tnum shrink-0 rounded-[4px] px-1 font-mono text-[11px] font-medium",
              delta.tone === "good" && "bg-[color-mix(in_oklab,var(--ok)_14%,transparent)] text-[var(--ok)]",
              delta.tone === "bad" && "bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] text-[var(--danger)]",
              delta.tone === "neutral" && "bg-[var(--sunken)] text-[var(--ink-muted)]",
            )}
          >
            {delta.text}
          </span>
        )}
      </p>
      {sub && <p className="m-0 truncate text-[11px] text-[var(--ink-faint)]">{sub}</p>}
    </div>
  );
}
