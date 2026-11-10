import type { Label } from "../types";
import { cn } from "../lib/cn";

/** A label as a small chip: a dot in its colour and the name. The colour is the label's identity, so it stays a dot and the text stays readable. */
export function LabelChip({ label, className }: { label: Pick<Label, "name" | "color">; className?: string }) {
  return (
    <span
      title={label.name}
      className={cn("inline-flex max-w-full items-center gap-1 rounded-[5px] bg-[var(--sunken)] px-1.5 py-0.5 text-[11px] font-medium leading-[1.4] text-[var(--ink-muted)]", className)}
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: label.color }} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}
