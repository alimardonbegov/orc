import { OrcMark } from "./OrcMark";
import { cn } from "../lib/cn";

interface Props {
  /** Mark size; the wordmark scales from it. */
  size?: number;
  awake?: boolean;
  working?: boolean;
  /** Line to the right of the name: "agent dashboard". Empty means only the mark and the name. */
  tagline?: string;
  className?: string;
}

/**
 * Logo lockup: mark + the name "orc". The name is always lowercase and monospaced: it is the
 * command name as typed in a terminal, not a heading. The gap between the mark and the name is half
 * the mark's side.
 */
export function OrcLogo({ size = 20, awake, working, tagline, className }: Props) {
  return (
    <span className={cn("inline-flex min-w-0 items-center", className)} style={{ gap: size / 2 }}>
      <OrcMark size={size} awake={awake} working={working} title="orc" />
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          className="font-mono font-semibold tracking-tight text-[var(--ink)]"
          style={{ fontSize: Math.round(size * 0.75), lineHeight: 1 }}
        >
          orc
        </span>
        {tagline && <span className="truncate text-[11px] text-[var(--ink-faint)]">{tagline}</span>}
      </span>
    </span>
  );
}
